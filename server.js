import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;

dotenv.config();

// --- DB ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- AI 設定 ---
const aiProfiles = {
  "林怡君": { style: "外向", desc: "很健談，喜歡分享生活。" },
  "張雅婷": { style: "害羞", desc: "說話溫柔，句子偏短。" },
  "陳思妤": { style: "搞笑", desc: "喜歡講幹話、氣氛製造機。" },
  "黃彥廷": { style: "穩重", desc: "語氣沈穩，回覆較中性。" },
  "王子涵": { style: "天真", desc: "像可愛弟弟妹妹，很直率。" },
  "劉家瑋": { style: "暖心", desc: "安撫型，講話溫暖。" },
  "李佩珊": { style: "外向", desc: "喜歡問問題，擅長帶話題。" },
  "蔡承翰": { style: "吐槽", desc: "回話直接、喜歡鬧別人。" },
  "許婉婷": { style: "知性", desc: "講話有邏輯，句型較完整。" },
  "周俊宏": { style: "開朗", desc: "活潑健談，喜歡講笑話。" },
  "何詩涵": { style: "文青", desc: "喜歡聊心情與生活感受。" },
  "鄭宇翔": { style: "沉默", desc: "話不多，但會突然丟一句。" },
  "郭心怡": { style: "可愛", desc: "語氣甜甜的。" },
  "江柏翰": { style: "理工男", desc: "講話直白，略呆。" },
  "曾雅雯": { style: "喜歡八卦", desc: "最愛聊人與人之間的事。" },
  "施俊傑": { style: "運動系", desc: "語氣健康、陽光。" },
};
const aiNames = Object.keys(aiProfiles);

// --- Express + Socket.io ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// --- 訪客登入 ---
app.post("/auth/guest", async (req, res) => {
  const token = crypto.randomUUID();
  await pool.query("INSERT INTO guest_users (guest_token) VALUES ($1)", [token]);
  res.json({ guestToken: token });
});

// --- AI 回覆 API ---
app.post("/ai/reply", async (req, res) => {
  const { message, aiName } = req.body;
  if (!message || !aiName) return res.status(400).json({ error: "缺少參數" });
  const reply = await callAI(message, aiName);
  res.json({ reply });
});

// --- AI 呼叫函數（改進版） ---
async function callAI(userMessage, aiName) {
  const p = aiProfiles[aiName] || { style: "中性", desc: "" };
  
  // 動態 max_tokens：訊息長度小於 20，max 30；長訊息可到 60
  const maxLen = userMessage.length < 20 ? 30 : 60;

  try {
    const response = await fetch('http://220.135.33.190:11434/v1/completions', {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3",
        prompt: `你是一名叫「${aiName}」的台灣人，個性是：${p.desc}（${p.style}）。請用繁體中文回覆：「${userMessage}」`,
        max_tokens: maxLen,
        temperature: 0.8
      })
    });

    const data = await response.json();
    return (data.completion || data.choices?.[0]?.text || "嗯～").trim();
  } catch {
    return "我剛剛又 Lag 了一下哈哈。";
  }
}

// --- 聊天室 ---
const rooms = {};      // room -> [{ id, name, type }]
const roomContext = {}; // room -> [{ user, text }]
const aiTimers = {};    // room -> timer

io.on("connection", socket => {
  socket.on("joinRoom", ({ room, user }) => {
    socket.join(room);
    socket.data = { room, name: user.name };

    if (!rooms[room]) rooms[room] = [];
    if (!rooms[room].find(u => u.name === user.name)) rooms[room].push({ id: socket.id, name: user.name, type: "guest" });
    aiNames.forEach(ai => {
      if (!rooms[room].find(u => u.name === ai)) rooms[room].push({ id: ai, name: ai, type: "AI" });
    });
    if (!roomContext[room]) roomContext[room] = [];

    io.to(room).emit("systemMessage", `${user.name} 加入房間`);
    io.to(room).emit("updateUsers", rooms[room]);

    startAIAutoTalk(room);
  });

  socket.on("message", async ({ room, message, user, target }) => {
    io.to(room).emit("message", { user, message, target });
    roomContext[room].push({ user: user.name, text: message });
    if (roomContext[room].length > 20) roomContext[room].shift();

    if (target && aiProfiles[target]) {
      const reply = await callAI(message, target);
      io.to(room).emit("message", { user: { name: target }, message: reply, target: user.name });
      roomContext[room].push({ user: target, text: reply });
      if (roomContext[room].length > 20) roomContext[room].shift();
    }
  });

  const removeUser = () => {
    const { room, name } = socket.data;
    if (!room || !rooms[room]) return;
    rooms[room] = rooms[room].filter(u => u.id !== socket.id);
    socket.leave(room);
    io.to(room).emit("systemMessage", `${name} 離開房間`);
    io.to(room).emit("updateUsers", rooms[room]);
  };

  socket.on("leaveRoom", removeUser);
  socket.on("disconnect", removeUser);
});

// --- AI 自動聊天 ---
function startAIAutoTalk(room) {
  if (aiTimers[room]) return;

  async function loop() {
    const aiList = (rooms[room] || []).filter(u => u.type === "AI");
    if (!aiList.length) return;

    const speaker = aiList[Math.floor(Math.random() * aiList.length)];
    const lastContext = roomContext[room] || [];
    const reply = await callAI("延續話題", speaker.name);

    io.to(room).emit("message", { user: { name: speaker.name }, message: reply });
    roomContext[room].push({ user: speaker.name, text: reply });
    if (roomContext[room].length > 20) roomContext[room].shift();

    aiTimers[room] = setTimeout(loop, 30000 + Math.random() * 15000);
  }

  loop();
}

// --- Server ---
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Server running on port ${port}`));
