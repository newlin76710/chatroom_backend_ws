// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

import { pool } from "./db.js";
import { authRouter } from "./auth.js";
import { aiRouter } from "./ai.js";
import { songRouter } from "./song.js";
import { chatHandlers } from "./chat.js";
import { songSocket } from "./socketHandlers.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "https://boygirl.ek21.com"],
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
  origin: ["http://localhost:5173", "https://boygirl.ek21.com"],
  methods: ["GET","POST"],
  credentials: true
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/songs", express.static(uploadDir));

// ===== Routes =====
app.use("/auth", authRouter);
app.use("/ai", aiRouter);
app.use("/song", songRouter);

// ===== Peers（管理 transports / producers / consumers）=====
const peers = {};

// ===== Socket.IO =====
io.on("connection", socket => {
  console.log(`[socket] ${socket.id} connected`);

  // ===== 原本功能：聊天 / AI =====
  chatHandlers(io, socket);

  // ===== 原本唱歌 / 評分 =====
  songSocket(io, socket);

  // ===== 斷線清理 =====
  socket.on("disconnect", () => {
    console.log(`[socket] ${socket.id} disconnected`);
  });
});

// ===== Start server =====
const port = process.env.PORT || 10000;
server.listen(port, () => console.log(`🚀 Server running on port ${port}`));
