// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import fetch from "node-fetch"; // Node 18+ 可直接用 fetch
import { AccessToken } from "livekit-server-sdk"; // 舊版本 v2.x 用 addGrant
import { pool } from "./db.js";
import { adminRouter } from "./admin.js";
import { authRouter } from "./auth.js";
import { aiRouter } from "./ai.js";
import { songRouter } from "./song.js";
import { rooms, chatHandlers } from "./chat.js";
import { songSocket } from "./socketHandlers.js";
import { songState } from "./song.js"; // 判斷誰是歌手
import { quickPhrasesRouter } from "./quickPhrase.js";
import { ipRouter } from "./blockIP.js";
import { announcementRouter } from "./announcementRouter.js";
import { messageBoardRouter } from "./messageBoardRouter.js";
dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      callback(null, true); // 允許所有 origin
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket"]
});

// ===== Upload dir =====
const __dirname = path.resolve();
const uploadDir = path.join(__dirname, "uploads", "songs");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ===== Middleware =====
app.use(cors({
  origin: (origin, callback) => {
    callback(null, true); // 允許所有 origin
  },
  methods: ["GET", "POST"],
  credentials: true
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/songs", express.static(uploadDir));

// ===== Routes =====
app.use("/admin", adminRouter);
app.use("/auth", authRouter);
app.use("/ai", aiRouter);
app.use("/song", songRouter);
app.use("/api/announcement", announcementRouter);
app.use("/api/quick-phrases", quickPhrasesRouter);
app.use("/api/blocked-ips", ipRouter);
app.use("/api/message-board", messageBoardRouter);
// 回傳房間使用者
app.get("/getRoomUsers", (req, res) => {
  const room = req.query.room;
  if (!room) return res.status(400).json({ error: "缺少 room 參數" });

  const users = rooms[room] || [];
  // 這裡只回傳使用者簡單資訊，避免泄露 socketId 等
  const simpleUsers = users.map(u => ({ name: u.name, type: u.type }));

  res.json({ users: simpleUsers });
});
// app.get("/livekit-token")
app.get("/livekit-token", async (req, res) => {
  const { room, name } = req.query;  // 改成 name
  if (!room || !name) return res.status(400).json({ error: "missing room or name" });

  const state = songState[room];
  const isSinger = state?.currentSinger === name; // 判斷是不是正在唱的人

  try {
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: name, ttl: "10m" } // 用 name 當 identity
    );

    at.addGrant({
      room: room,
      roomJoin: true,
      canPublish: isSinger,   // 只有當前歌手可以發音訊
      canSubscribe: true,     // 所有人可收聽
      canPublishData: true,
    });

    const token = await at.toJwt();

    console.log(`[LiveKit Token] ${name} in room ${room} as ${isSinger ? "singer" : "listener"}`);

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

// ===== Socket.IO =====
io.on("connection", socket => {
  console.log(`[socket] ${socket.id} connected`);

  // 聊天 / AI
  chatHandlers(io, socket);

  // 唱歌 / 評分
  songSocket(io, socket);

  socket.on("disconnect", () => {
    console.log(`[socket] ${socket.id} disconnected`);
  });
});

// ===== Heartbeat for Render =====
const HEARTBEAT_INTERVAL = 1 * 60 * 1000; // 每 1 分鐘
setInterval(async () => {
  try {
    const url = process.env.SELF_URL || `http://localhost:${process.env.PORT || 10000}/`;
    const res = await fetch(url);
    console.log(`[Heartbeat] ${new Date().toISOString()} - Status: ${res.status}`);
  } catch (err) {
    console.error("[Heartbeat] Error:", err.message);
  }
}, HEARTBEAT_INTERVAL);

// ===== Start server =====
const port = process.env.PORT || 10000;
server.listen(port, () => console.log(`🚀 Server running on port ${port}`));
