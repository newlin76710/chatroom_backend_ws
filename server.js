// server.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';
import pkg from 'pg';
import bcrypt from "bcryptjs";
const { Pool } = pkg;

dotenv.config();

// --- DB ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- AI 設定 (略，保留你原本 aiProfiles) ---
const aiProfiles = {
  "林怡君": { style: "外向", desc: "很健談，喜歡分享生活。", level: 5 },
  "張雅婷": { style: "害羞", desc: "說話溫柔，句子偏短。", level: 8 },
  // ... 其餘略 ...
};
const aiNames = Object.keys(aiProfiles);

// --- Express + Socket.io ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// ---------- Helper ----------
async function createGuest() {
  const token = crypto.randomUUID();
  const name = "訪客 " + Math.floor(1000 + Math.random() * 9000);
  const level = 1;
  await pool.query(
    "INSERT INTO guest_users (guest_token, name, level) VALUES ($1, $2, $3)",
    [token, name, level]
  );
  return { guestToken: token, name, level };
}

async function findGuestByToken(token) {
  const r = await pool.query("SELECT guest_token, name, level FROM guest_users WHERE guest_token = $1", [token]);
  return r.rows[0] || null;
}

// -----------------
// --- 帳號系統 ---
// -----------------

app.post("/auth/guest", async (req, res) => {
  try {
    const guest = await createGuest();
    res.json(guest);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "訪客登入失敗" });
  }
});

app.post("/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "缺少帳號或密碼" });

    const exist = await pool.query(`SELECT id FROM users WHERE username=$1`, [username]);
    if (exist.rowCount > 0) return res.status(400).json({ error: "帳號已存在" });

    const hash = await bcrypt.hash(password, 10);
    await pool.query(`INSERT INTO users (username, password, level) VALUES ($1, $2, $3)`, [username, hash, 1]);

    res.json({ message: "註冊成功" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "註冊失敗" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "缺少帳號或密碼" });

    const result = await pool.query(`SELECT id, username, password, level FROM users WHERE username=$1`, [username]);
    if (result.rowCount === 0) return res.status(400).json({ error: "帳號不存在" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "密碼錯誤" });

    const token = crypto.randomUUID();
    res.json({ token, name: user.username, level: user.level });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "登入失敗" });
  }
});

// --- AI 回覆 API (保留) ---
app.post("/ai/reply", async (req, res) => {
  const { message, aiName } = req.body;
  if (!message || !aiName) return res.status(400).json({ error: "缺少參數" });
  const reply = await callAI(message, aiName);
  res.json({ reply });
});

async function callAI(userMessage, aiName) {
  const p = aiProfiles[aiName] || { style: "中性", desc: "", level: 99 };
  try {
    const response = await fetch('http://220.135.33.190:11434/v1/completions', {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3",
        prompt: `你是一名叫「${aiName}」的台灣人，個性是：${p.desc}（${p.style}）。請用繁體中文回覆，省略廢話跟自我介紹，控制在10~30字內：「${userMessage}」`,
        temperature: 0.8
      })
    });
    const data = await response.json();
    return (data.completion || data.choices?.[0]?.text || "嗯～").trim();
  } catch (e) {
    console.error("callAI error:", e);
    return "我剛剛又 Lag 了一下哈哈。";
  }
}

// --- Socket.io 聊天室（用 B 模式：timestamp 同步） ---
const rooms = {};
const roomContext = {};
const aiTimers = {};
const videoState = {}; // room -> { currentVideo: {url,user,timestamp,isPlaying,lastUpdate}, queue: [] }

io.on("connection", socket => {
  console.log("socket connected:", socket.id);

  socket.on("joinRoom", ({ room, user }) => {
    socket.join(room);
    const name = user.name || ("訪客" + Math.floor(Math.random() * 999));
    const level = user.level || 1;
    socket.data = { room, name, level };

    if (!rooms[room]) rooms[room] = [];
    if (!rooms[room].find(u => u.name === name))
      rooms[room].push({ id: socket.id, name, type: user.type || "guest", level });

    // AI 使用者
    aiNames.forEach(ai => {
      if (!rooms[room].find(u => u.name === ai))
        rooms[room].push({ id: ai, name: ai, type: "AI", level: aiProfiles[ai]?.level || 99 });
    });

    if (!roomContext[room]) roomContext[room] = [];
    if (!videoState[room]) videoState[room] = { currentVideo: null, queue: [] };

    // 廣播使用者列表 / 系統訊息
    io.to(room).emit("systemMessage", `${name} 加入房間`);
    io.to(room).emit("updateUsers", rooms[room]);

    // 當新 user 加入，送他目前的影片狀態與 queue
    socket.emit("videoUpdate", videoState[room].currentVideo);
    socket.emit("videoQueueUpdate", videoState[room].queue);

    startAIAutoTalk(room);
  });

  socket.on("message", async ({ room, message, user, target }) => {
    io.to(room).emit("message", { user, message, target });
    if (!roomContext[room]) roomContext[room] = [];
    roomContext[room].push({ user: user.name, text: message });
    if (roomContext[room].length > 20) roomContext[room].shift();

    if (target && aiProfiles[target]) {
      const reply = await callAI(message, target);
      io.to(room).emit("message", { user: { name: target }, message: reply, target: user.name });
      roomContext[room].push({ user: target, text: reply });
      if (roomContext[room].length > 20) roomContext[room].shift();
    }
  });

  // Play new video (點播) -> 設為 current 並廣播（timestamp = 0, isPlaying = true）
  socket.on("playVideo", ({ room, url, user }) => {
    if (!videoState[room]) videoState[room] = { currentVideo: null, queue: [] };

    const now = Date.now();
    const video = { url, user, timestamp: 0, isPlaying: true, lastUpdate: now };

    videoState[room].currentVideo = video;
    videoState[room].queue.push(video);

    io.to(room).emit("videoUpdate", video);
    io.to(room).emit("videoQueueUpdate", videoState[room].queue);
  });

  // Pause -> 計算經過時間，更新 timestamp, isPlaying=false
  socket.on("pauseVideo", ({ room }) => {
    const state = videoState[room];
    if (!state || !state.currentVideo) return;
    const v = state.currentVideo;
    if (!v.isPlaying) return;

    const elapsed = (Date.now() - v.lastUpdate) / 1000;
    v.timestamp = v.timestamp + elapsed;
    v.isPlaying = false;
    // lastUpdate 不需更新（因為是暫停狀態）
    io.to(room).emit("videoUpdate", v);
  });

  // Resume -> 設 isPlaying = true，更新 lastUpdate
  socket.on("resumeVideo", ({ room }) => {
    const state = videoState[room];
    if (!state || !state.currentVideo) return;
    const v = state.currentVideo;
    if (v.isPlaying) return;

    v.isPlaying = true;
    v.lastUpdate = Date.now();
    io.to(room).emit("videoUpdate", v);
  });

  // Seek -> 前端可發 seek 秒數，更新 timestamp/lastUpdate，並廣播
  socket.on("seekVideo", ({ room, toSeconds }) => {
    const state = videoState[room];
    if (!state || !state.currentVideo) return;
    const v = state.currentVideo;
    v.timestamp = Number(toSeconds) || 0;
    v.lastUpdate = Date.now();
    io.to(room).emit("videoUpdate", v);
  });

  const removeUser = () => {
    const { room, name } = socket.data || {};
    if (!room || !rooms[room]) return;
    rooms[room] = rooms[room].filter(u => u.id !== socket.id && u.name !== name);
    socket.leave(room);
    if (name) {
      io.to(room).emit("systemMessage", `${name} 離開房間`);
      io.to(room).emit("updateUsers", rooms[room]);
    }
  };

  socket.on("leaveRoom", removeUser);
  socket.on("disconnect", removeUser);
});

// --- AI 自動對話（保留） ---
function startAIAutoTalk(room) {
  if (aiTimers[room]) return;

  async function loop() {
    const aiList = (rooms[room] || []).filter(u => u.type === "AI");
    if (!aiList.length) return;

    const speaker = aiList[Math.floor(Math.random() * aiList.length)];
    const reply = await callAI("繼續當前話題但不要提到我們正在繼續話題這幾個字", speaker.name);

    io.to(room).emit("message", { user: { name: speaker.name }, message: reply });
    if (!roomContext[room]) roomContext[room] = [];
    roomContext[room].push({ user: speaker.name, text: reply });
    if (roomContext[room].length > 20) roomContext[room].shift();

    aiTimers[room] = setTimeout(loop, 30000 + Math.random() * 15000);
  }

  loop();
}

// --- Server ---
const port = process.env.PORT || 10000;
server.listen(port, () => console.log(`Server running on port ${port}`));
