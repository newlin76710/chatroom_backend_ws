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
import {
  initMediasoup,
  createWebRtcTransport,
  getRouter
} from "./mediasoupServer.js";

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

// ===== Mediasoup =====
await initMediasoup();

app.get("/mediasoup-rtpCapabilities", (req, res) => {
  const router = getRouter();
  if (!router) return res.status(500).json({ error: "Router not ready" });
  res.json({ rtpCapabilities: router.rtpCapabilities });
});

// ===== Peers（PATCH：加 consumers）=====
const peers = {};

// ===== Socket.IO =====
io.on("connection", socket => {
  console.log(`[socket] ${socket.id} connected`);

  peers[socket.id] = {
    transports: [],
    producers: [],
    consumers: []   // ✅ PATCH
  };

  // ===== 原本功能：聊天 / AI =====
  chatHandlers(io, socket);

  // ===== 原本 WebRTC =====
  webrtcHandlers(io, socket);

  // ===== 原本唱歌 / 評分 =====
  songSocket(io, socket);

  // ===== PATCH：create transport（加 direction）=====
  socket.on("create-transport", async ({ direction }, callback) => {
    const transport = await createWebRtcTransport();
    transport.appData = { direction }; // send | recv

    peers[socket.id].transports.push(transport);

    callback({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });
  });

  // ===== connect transport（不變）=====
  socket.on("connect-transport", async ({ transportId, dtlsParameters }) => {
    const transport = peers[socket.id].transports.find(t => t.id === transportId);
    if (!transport) return;
    await transport.connect({ dtlsParameters });
  });

  // ===== PATCH：produce 只用 send transport =====
  socket.on("produce", async ({ transportId, kind, rtpParameters }, callback) => {
    const transport = peers[socket.id].transports.find(
      t => t.id === transportId && t.appData.direction === "send"
    );
    if (!transport) {
      console.error("❌ produce: send transport not found");
      return;
    }

    const producer = await transport.produce({ kind, rtpParameters });
    peers[socket.id].producers.push(producer);

    console.log("🎤 produce", producer.id);

    socket.broadcast.emit("new-producer", {
      producerId: producer.id,
      socketId: socket.id
    });

    callback({ id: producer.id });
  });

  // ===== PATCH：consume 用 recv transport =====
  socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
    const router = getRouter();
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      console.error("❌ cannot consume");
      return;
    }

    const transport = peers[socket.id].transports.find(
      t => t.appData.direction === "recv"
    );
    if (!transport) {
      console.error("❌ recv transport not found");
      return;
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: false
    });

    peers[socket.id].consumers.push(consumer);

    console.log("🎧 consume", consumer.id);

    callback({
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    });
  });

  // ===== PATCH：disconnect 清乾淨 =====
  socket.on("disconnect", () => {
    console.log(`[socket] ${socket.id} disconnected`);
    const peer = peers[socket.id];
    if (!peer) return;

    peer.consumers.forEach(c => c.close());
    peer.producers.forEach(p => p.close());
    peer.transports.forEach(t => t.close());

    delete peers[socket.id];
  });
});

// ===== Start server =====
const port = process.env.PORT || 10000;
server.listen(port, () =>
  console.log(`🚀 Server running on port ${port}`)
);
