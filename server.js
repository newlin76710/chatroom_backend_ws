import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import fetch from "node-fetch";
import { AccessToken } from "livekit-server-sdk";
import { removeUserIP } from "./ip.js";
import { pool } from "./db.js";
import { adminRouter } from "./admin.js";
import { authRouter, ioTokens } from "./auth.js";
import { aiRouter } from "./ai.js";
import { songRouter, songState } from "./song.js";
import { rooms, chatHandlers, onlineUsers } from "./chat.js";
import { songSocket } from "./socketHandlers.js";
import { quickPhrasesRouter } from "./quickPhrase.js";
import { ipRouter } from "./blockIP.js";
import { nicknameRouter } from "./blockNickname.js";
import { announcementRouter } from "./announcementRouter.js";
import { messageBoardRouter } from "./messageBoardRouter.js";
import { createTransferRouter } from "./transferGold.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

//////////////////////////////////////////////////////
// ⭐⭐⭐⭐⭐ 這裡是關鍵 Socket 設定
//////////////////////////////////////////////////////

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, true),
    credentials: true
  },

  // ❗不要限制 transports
  // 讓 polling 可 fallback 救 websocket
  allowUpgrades: true,

  pingInterval: 25000,   // 每25秒確認一次
  pingTimeout: 120000,  // ⭐⭐⭐⭐ 強烈建議 ≥ 60秒
  upgradeTimeout: 30000,

  maxHttpBufferSize: 1e7 // 防止大訊息炸掉
});
app.set("io", io);
//////////////////////////////////////////////////////
// Upload dir
//////////////////////////////////////////////////////

const __dirname = path.resolve();
const uploadDir = path.join(__dirname, "uploads", "songs");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

//////////////////////////////////////////////////////
// Middleware
//////////////////////////////////////////////////////

app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/songs", express.static(uploadDir));

//////////////////////////////////////////////////////
// Routes
//////////////////////////////////////////////////////

app.use("/admin", adminRouter);
app.use("/auth", authRouter);
app.use("/ai", aiRouter);
app.use("/song", songRouter);
app.use("/api/announcement", announcementRouter);
app.use("/api/quick-phrases", quickPhrasesRouter);
app.use("/api/blocked-ips", ipRouter);
app.use("/api/blocked-nicknames", nicknameRouter);
app.use("/api/message-board", messageBoardRouter);
app.use("/api", createTransferRouter(io));
//////////////////////////////////////////////////////
// 取得房間使用者
//////////////////////////////////////////////////////

app.get("/getRoomUsers", (req, res) => {
  const room = req.query.room;
  if (!room) return res.status(400).json({ error: "缺少 room 參數" });

  const users = rooms[room] || [];
  res.json({
    users: users.map(u => ({
      name: u.name,
      type: u.type
    }))
  });
});

//////////////////////////////////////////////////////
// LiveKit Token
//////////////////////////////////////////////////////

app.get("/livekit-token", async (req, res) => {
  const { room, name } = req.query;
  if (!room || !name)
    return res.status(400).json({ error: "missing room or name" });

  const state = songState[room];
  const isSinger = state?.currentSinger === name;

  try {
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: name,
        ttl: "10m"
      }
    );

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: isSinger,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    res.json({
      token,
      identity: name,
      role: isSinger ? "singer" : "listener",
    });

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

  // 聊天
  chatHandlers(io, socket);

  // 唱歌
  songSocket(io, socket);

  socket.on("disconnect", reason => {
    console.log(`🔴 socket disconnected: ${socket.id}`, reason);
  });
});

//////////////////////////////////////////////////////
// ⭐⭐⭐⭐⭐ 防 Render 睡死（只保護 container）
//////////////////////////////////////////////////////

const HEARTBEAT_INTERVAL = 60 * 1000;

setInterval(async () => {
  try {
    const url =
      process.env.SELF_URL ||
      `http://localhost:${process.env.PORT || 10000}`;

    await fetch(url);

  } catch (err) {
    console.error("[Heartbeat] Error:", err.message);
  }
}, HEARTBEAT_INTERVAL);

//////////////////////////////////////////////////////
// ⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐
// 🔥 超推薦：清除假在線使用者
//////////////////////////////////////////////////////

setInterval(() => {
  const now = Date.now();

  for (const [name, last] of onlineUsers.entries()) {
    if (now - last > 5 * 60 * 1000) { // 5分鐘沒 heartbeat
      onlineUsers.delete(name);
      console.log("🧹 假在線移除:", name);

      // 同步移除 token
      for (const [token, data] of ioTokens.entries()) {
        if (data.username === name) {
          ioTokens.delete(token);
          console.log("🧹 對應 token 移除:", token);
          removeUserIP(data.ip, name);
        }
      }
    }
  }
}, 60000);



//////////////////////////////////////////////////////
// Start server
//////////////////////////////////////////////////////

const port = process.env.PORT || 10000;

server.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log("Server started at:", new Date());
});
