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
import { songRouter, songState, displayQueue } from "./song.js";
import { chatHandlers, startAIAutoTalk, rooms, roomContext } from "./chat.js";
import { webrtcHandlers } from "./webrtc.js";
import { songSocket } from "./socketHandlers.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "https://boygirl.ek21.com"], // 測試用，之後再改成特定域名
    methods: ["GET","POST"],
    credentials: true
  },
  transports: ["websocket"]
});

// Upload directory
const __dirname = new URL('.', import.meta.url).pathname;
const uploadDir = path.join(__dirname, "uploads", "songs");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Middleware
app.use(cors({
  origin: ["http://localhost:5173", "https://boygirl.ek21.com"],
  methods: ["GET","POST"],
  credentials: true 
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use("/songs", express.static(uploadDir));

// Routes
app.use("/auth", authRouter);
app.use("/ai", aiRouter);
app.use("/song", songRouter);

// Socket.io
io.on("connection", (socket) => {
  // 聊天 + AI
  chatHandlers(io, socket);

  // WebRTC 信令
  webrtcHandlers(io, socket);

  // 歌唱狀態 + 評分
  songSocket(io, socket);
});

const port = process.env.PORT || 10000;
server.listen(port, () => console.log(`Server running on port ${port}`));
