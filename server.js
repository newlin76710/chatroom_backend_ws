import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import cors from 'cors';
import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;

dotenv.config();

// 初始化 DB（Neon）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- 訪客登入 API ----------------
app.post("/auth/guest", async (req, res) => {
  try {
    const guestToken = crypto.randomUUID();
    await pool.query("INSERT INTO guest_users (guest_token) VALUES ($1)", [guestToken]);
    res.json({ guestToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "guest login failed" });
  }
});

// ---------------- OAuth 綁定登入 API ----------------
app.post("/auth/oauth", async (req, res) => {
  const { provider, providerId, email, name, avatar, guestToken } = req.body;
  try {
    const existBind = await pool.query(
      "SELECT user_id FROM oauth_accounts WHERE provider=$1 AND provider_id=$2",
      [provider, providerId]
    );
    if (existBind.rows.length > 0) {
      const user = await pool.query("SELECT * FROM users WHERE id=$1", [existBind.rows[0].user_id]);
      return res.json({ user: user.rows[0] });
    }

    let userId;
    const existEmail = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    if (existEmail.rows.length > 0) userId = existEmail.rows[0].id;
    else {
      const insert = await pool.query(
        "INSERT INTO users (email, name, avatar) VALUES ($1,$2,$3) RETURNING id",
        [email, name, avatar]
      );
      userId = insert.rows[0].id;
    }

    await pool.query(
      "INSERT INTO oauth_accounts (user_id, provider, provider_id) VALUES ($1,$2,$3)",
      [userId, provider, providerId]
    );

    if (guestToken) {
      await pool.query("DELETE FROM guest_users WHERE guest_token=$1", [guestToken]);
    }

    const user = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
    res.json({ user: user.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "oauth login failed" });
  }
});

// ---------------- AI 回覆 API ----------------
const roomContext = {}; // room -> [{ user, text }]
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

app.post("/ai/reply", async (req, res) => {
  try {
    const { message, aiName, roomContext: context = [] } = req.body;
    if (!message || !aiName) return res.status(400).json({ error: "缺少必要參數" });

    const reply = await callAI(message, aiName, context, "reply");
    res.json({ reply });
  } catch (err) {
    console.error("[AI /reply error]", err);
    res.status(500).json({ reply: "我剛剛又 Lag 了一下哈哈。" });
  }
});

// ---------------- AI 呼叫函數 ----------------
async function callAI(userMessage, aiName, roomContext = [], mode = "reply") {
  const p = aiProfiles[aiName] || { style: "中性", desc: "" };
  let maxLen = mode === "reply" ? 40 : 20;

  let prompt = "";
  if(mode === "reply") {
    prompt = `
你是一名叫「${aiName}」的台灣人，個性是：${p.desc}（${p.style}）。
請用繁體中文直接回覆使用者：「${userMessage}」。
字數 10~40 字，語氣自然友善。
禁止出現 AI 簡體 或英文。
    `;
  } else {
    prompt = `
你是一名叫「${aiName}」的台灣人，個性是：${p.desc}（${p.style}）。
房間最近的聊天內容如下：
${roomContext.map(c => `${c.user}：${c.text}`).join("\n")}
請延續話題，自我發言，字數 10~20 字，語氣自然。
禁止出現 AI 簡體 或英文。
    `;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch('http://220.135.33.190:11434/v1/completions', {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3",
        prompt,
        max_tokens: maxLen,
        temperature: 0.8,
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const data = await response.json();
    return (data.completion || data.choices?.[0]?.text || "嗯～").trim();
  } catch(err) {
    console.error("[AI Error]", err);
    return "我剛剛又 Lag 了一下哈哈。";
  }
}

// ---------------- 聊天室 ----------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const aiPersonalities = Object.keys(aiProfiles);

const rooms = {}; // room -> [{ id, name, type }]
const aiChatTimers = {}; // room -> timer

io.on("connection", (socket) => {

  socket.on("joinRoom", ({ room, user }) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.name = user.name;

    if (!rooms[room]) rooms[room] = [];
    rooms[room].push({ id: socket.id, name: user.name, type: "guest" });

    // AI 加入房間
    aiPersonalities.forEach(ai => {
      if (!rooms[room].find(u => u.name === ai)) {
        rooms[room].push({ id: ai, name: ai, type: "AI" });
      }
    });

    if (!roomContext[room]) roomContext[room] = [];

    io.to(room).emit("systemMessage", `${user.name} 加入房間`);
    io.to(room).emit("updateUsers", rooms[room]);

    setTimeout(() => startAIAutoTalk(room), 2000);
  });

  socket.on("message", async ({ room, message, user, target }) => {
    io.to(room).emit("message", { user, message, target });

    roomContext[room].push({ user: user.name, text: message });
    if (roomContext[room].length > 20) roomContext[room].shift();

    if (target && aiProfiles[target]) {
      const aiReply = await callAI(message, target, [], "reply");
      io.to(room).emit("message", {
        user: { name: target },
        message: aiReply,
        target: user.name,
      });
      roomContext[room].push({ user: target, text: aiReply });
      if (roomContext[room].length > 20) roomContext[room].shift();
    }
  });

  function removeUser() {
    const { room, name } = socket.data;
    if (!room || !rooms[room]) return;

    rooms[room] = rooms[room].filter(u => u.id !== socket.id);
    socket.leave(room);

    io.to(room).emit("systemMessage", `${name} 離開房間`);
    io.to(room).emit("updateUsers", rooms[room]);
  }

  socket.on("leaveRoom", removeUser);
  socket.on("disconnect", removeUser);
});

// ---------------- AI 自動聊天 ----------------
function startAIAutoTalk(room) {
  if (aiChatTimers[room]) return;

  async function loop() {
    const list = rooms[room];
    if (!list || list.length === 0) {
      delete aiChatTimers[room];
      return;
    }

    const aiList = list.filter(u => u.type === "AI");
    if (!aiList.length) return;

    const speaker = aiList[Math.floor(Math.random() * aiList.length)];
    const lastContext = roomContext[room] || [];

    const aiReply = await callAI("延續話題", speaker.name, lastContext, "auto");

    io.to(room).emit("message", {
      user: { name: speaker.name },
      message: aiReply,
      target: ""
    });

    roomContext[room].push({ user: speaker.name, text: aiReply });
    if (roomContext[room].length > 20) roomContext[room].shift();

    const delay = 30000 + Math.random() * 15000; // 30~45 秒
    aiChatTimers[room] = setTimeout(loop, delay);
  }

  loop();
}

// ---------------- 自動 port fallback ----------------
const fallbackPorts = [3000, 10000, 11000];
let portIndex = 0;
function listenPort(port) {
  server.listen(port, () => console.log(`Server running on port ${port}`))
  .on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} 已被占用`);
      portIndex++;
      if (portIndex < fallbackPorts.length) listenPort(fallbackPorts[portIndex]);
      else console.error('所有 fallback port 都被占用，啟動失敗');
    } else console.error(err);
  });
}
const initialPort = process.env.PORT || fallbackPorts[portIndex];
listenPort(initialPort);
