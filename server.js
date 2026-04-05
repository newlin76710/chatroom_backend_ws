import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { AccessToken } from "livekit-server-sdk";
import { removeUserIP } from "./ip.js";
import { adminRouter } from "./admin.js";
import { authRouter, ioTokens } from "./auth.js";
import { aiRouter } from "./ai.js";
import { songState } from "./socketHandlers.js";
import { rooms, chatHandlers, onlineUsers, pendingReconnect } from "./chat.js";
import { songSocket } from "./socketHandlers.js";
import { quickPhrasesRouter } from "./quickPhrase.js";
import { ipRouter } from "./blockIP.js";
import { nicknameRouter } from "./blockNickname.js";
import { announcementRouter } from "./announcementRouter.js";
import { messageBoardRouter } from "./messageBoardRouter.js";
import { createTransferRouter } from "./transferGold.js";
import { initSurpriseScheduler } from "./surpriseGold.js";
import { initGoldGameScheduler, goldGameSocket } from "./goldAppleGame.js";
process.on('exit', (code) => console.log('Process exit code:', code));
process.on('SIGTERM', () => console.log('SIGTERM received'));
process.on('SIGINT', () => console.log('SIGINT received'));
process.on("uncaughtException", (err) => console.error("💥 uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("💥 unhandledRejection:", err));
dotenv.config();

const app = express();
const server = http.createServer(app);

//////////////////////////////////////////////////////
// Socket.IO 設定
//////////////////////////////////////////////////////

// 若設定 ALLOWED_ORIGINS（逗號分隔），則限制指定來源；否則允許所有（維持原行為）
const _allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null;
const _corsOrigin = _allowedOrigins
  ? (origin, callback) => {
      if (!origin || _allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error('Not allowed by CORS'));
    }
  : (origin, callback) => callback(null, true);

const io = new Server(server, {
  cors: {
    origin: _corsOrigin,
    credentials: true
  },
  allowUpgrades: true,
  pingInterval: 25000,   // 每25秒確認一次
  pingTimeout: 120000,   // 強烈建議 ≥ 60秒
  upgradeTimeout: 30000,
  maxHttpBufferSize: 1e7
});
app.set("io", io);

//////////////////////////////////////////////////////
// Middleware
//////////////////////////////////////////////////////

app.use(cors({
  origin: _corsOrigin,
  credentials: true
}));
app.use(express.json());

//////////////////////////////////////////////////////
// Routes
//////////////////////////////////////////////////////

app.use("/admin", adminRouter);
app.use("/auth", authRouter);
app.use("/ai", aiRouter);
app.use("/api/announcement", announcementRouter);
app.use("/api/quick-phrases", quickPhrasesRouter);
app.use("/api/blocked-ips", ipRouter);
app.use("/api/blocked-nicknames", nicknameRouter);
app.use("/api/message-board", messageBoardRouter);
app.use("/api", createTransferRouter(io));
app.get("/", (req, res) => {
  res.send("🚀 Server is running");
});
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
});
app.get("/getRoomUsers", (req, res) => {
  const room = req.query.room;
  if (!room) return res.status(400).json({ error: "缺少 room 參數" });

  const users = rooms[room] || [];
  res.json({
    users: users.map(u => ({ name: u.name, type: u.type }))
  });
});

app.get("/livekit-token", async (req, res) => {
  const { room, name } = req.query;
  if (!room || !name) return res.status(400).json({ error: "missing room or name" });

  try {
    const state = songState[room];
    const isSinger = state?.currentSinger === name;

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: name, ttl: "10m" }
    );

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: isSinger,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();
    res.json({ token, identity: name, role: isSinger ? "singer" : "listener" });

  } catch (err) {
    console.error("[LiveKit Token] Error:", err);
    res.status(500).json({ error: "LiveKit token generation failed" });
  }
});

//////////////////////////////////////////////////////
// Socket
//////////////////////////////////////////////////////

io.on("connection", socket => {
  console.log(`🟢 socket connected: ${socket.id}`);

  try {
    chatHandlers(io, socket);
  } catch (err) {
    console.error("chatHandlers error:", err.message);
  }

  try {
    songSocket(io, socket);
  } catch (err) {
    console.error("songSocket error:", err.message);
  }

  try {
    goldGameSocket(io, socket);
  } catch (err) {
    console.error("goldGameSocket error:", err.message);
  }

  socket.on("disconnect", reason => {
    console.log(`🔴 socket disconnected: ${socket.id}`, reason);
  });
});

//////////////////////////////////////////////////////
// Heartbeat 防 Render 睡死
//////////////////////////////////////////////////////

const HEARTBEAT_INTERVAL = 60 * 1000;
setInterval(async () => {
  try {
    const url = process.env.SELF_URL || `http://localhost:${process.env.PORT || 10000}`;
    await fetch(url);
  } catch (err) {
    console.error("[Heartbeat] Error:", err.message);
  }
}, HEARTBEAT_INTERVAL);

//////////////////////////////////////////////////////
// 清除假在線使用者（安全版）
//////////////////////////////////////////////////////

setInterval(() => {
  const now = Date.now();
  try {
    // 清理房間使用者（保留還在 10 秒重連等待中的使用者，否則 leave 訊息會遺失）
    for (const room in rooms) {
      rooms[room] = rooms[room].filter(u =>
        u.type === "AI" ||
        io.sockets.sockets.has(u.socketId) ||
        pendingReconnect.has(u.name)
      );
    }

    // 清理唱歌房狀態
    for (const room in songState) {
      const state = songState[room];
      if (!state) continue;
      state.queue = state.queue.filter(u => io.sockets.sockets.has(u.socketId));
      if (state.currentSingerSocketId && !io.sockets.sockets.has(state.currentSingerSocketId)) {
        state.currentSinger = null;
        state.currentSingerSocketId = null;
        state.currentScore = null;
      }
    }

    // 清理 onlineUsers / onlineReward / token
    for (const [name, last] of onlineUsers.entries()) {
      try {
        if (pendingReconnect.has(name)) continue;
        if (now - last > 5 * 60 * 1000) {
          onlineUsers.delete(name);
          console.log("🧹 假在線移除:", name);

          for (const [token, data] of ioTokens.entries()) {
            if (data.username === name) {
              ioTokens.delete(token);
              try { removeUserIP(data.ip, name); } catch (err) { console.error("removeUserIP error", err.message); }
            }
          }
        }
      } catch (err) {
        console.error("單個假在線錯誤", name, err.message);
      }
    }
  } catch (err) {
    console.error("假在線 interval 錯誤", err.message);
  }

}, 60000);

//////////////////////////////////////////////////////
// Start server
//////////////////////////////////////////////////////

const port = process.env.PORT || 10000;
server.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log("Server started at:", new Date());
  initSurpriseScheduler(io);
  initGoldGameScheduler(io);
});