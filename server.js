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
import { songSocket, webrtcHandlers } from "./socketHandlers.js";
import { initMediasoup, peers, createWebRtcTransport, getRouter } from "./mediasoupServer.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "https://boygirl.ek21.com"],
    methods: ["GET","POST"],
    credentials: true
  },
  transports: ["websocket"]
});

// Upload directory
const __dirname = path.resolve();
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

// 初始化 Mediasoup
await initMediasoup();

// Socket.io
io.on("connection", (socket) => {
  console.log(`[socket] ${socket.id} connected`);
  peers[socket.id] = { transports: [], producers: [] };

  // 聊天 + AI
  chatHandlers(io, socket);

  // WebRTC 信令 + Mediasoup
  webrtcHandlers(io, socket);

  // 歌唱狀態 + 評分
  songSocket(io, socket);

  // ===== Mediasoup transport 創建 =====
  socket.on("create-transport", async (_, callback) => {
    const transport = await createWebRtcTransport();
    peers[socket.id].transports.push(transport);
    callback({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });
  });

  socket.on("connect-transport", async ({ transportId, dtlsParameters }) => {
    const transport = peers[socket.id].transports.find(t => t.id === transportId);
    if (transport) await transport.connect({ dtlsParameters });
  });

  socket.on("produce", async ({ transportId, kind, rtpParameters }, callback) => {
    const transport = peers[socket.id].transports.find(t => t.id === transportId);
    if (!transport) return;
    const producer = await transport.produce({ kind, rtpParameters });
    peers[socket.id].producers.push(producer);

    // 廣播給其他用戶
    socket.broadcast.emit("new-producer", { producerId: producer.id, producerSocketId: socket.id });
    callback({ id: producer.id });
  });

  socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
    const router = getRouter();
    if (!router.canConsume({ producerId, rtpCapabilities })) return;

    const transport = peers[socket.id].transports[0];
    const consumer = await transport.consume({ producerId, rtpCapabilities, paused: false });
    callback({
      id: consumer.id,
      producerId: producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    });
  });

  socket.on("disconnect", () => {
    console.log(`[socket] ${socket.id} disconnected`);
    const peer = peers[socket.id];
    if (peer) {
      peer.transports.forEach(t => t.close());
      peer.producers.forEach(p => p.close());
      delete peers[socket.id];
    }
  });
});

const port = process.env.PORT || 10000;
server.listen(port, () => console.log(`Server running on port ${port}`));
