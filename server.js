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

// 初始化 DB（Neon / PostgreSQL）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(express.json());

// ----------------------
// 訪客登入 / OAuth
// ----------------------
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

// ----------------------
// AI /reply API
// ----------------------
const roomContext = {}; // room -> 最近 20 條訊息

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

const openai = new OpenAI({ apiKey: process.env.API_KEY });

async function callAI(userMessage, aiName, context) {
  try {
    const p = aiProfiles[aiName] || { style: "中性", desc: "" };
    const systemPrompt = `
你是一名叫「${aiName}」的台灣人，個性是：${p.desc}（${p.style}）。
請用「真實台灣人講話方式」回答。
房間最近聊天內容：
${context.map(c => `${c.user}：${c.text}`).join("\n")}
使用者剛剛說：「${userMessage}」
依照個性自然回覆，10～40字。
禁止英文、簡體中文、AI字眼。
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "system", content: systemPrompt }],
      temperature: 0.8,
      max_tokens: 80
    });

    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error("[AI Error]", err);
    return "我剛剛又 Lag 了一下哈哈。";
  }
}

app.post("/ai/reply", async (req, res) => {
  const { message, aiName, room } = req.body;
  if (!message || !aiName || !room) return res.status(400).json({ error: "缺少必要參數" });

  if (!roomContext[room]) roomContext[room] = [];
  const reply = await callAI(message, aiName, roomContext[room]);

  roomContext[room].push({ user: aiName, text: reply });
  if (roomContext[room].length > 20) roomContext[room].shift();

  res.json({ reply });
});

// ----------------------
// Socket.io 聊天室
// ----------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const aiPersonalities = Object.keys(aiProfiles);

const rooms = {};       // room -> user list
const aiChatTimers = {}; // room -> timer
const topicCount = {};   // room -> { topicKey: count }

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

    // 啟動 AI 自動聊天
    setTimeout(() => startAIAutoTalk(room), 2000);
  });

  socket.on("message", async ({ room, message, user, target }) => {
    io.to(room).emit("message", { user, message, target });
    if (!roomContext[room]) roomContext[room] = [];
    roomContext[room].push({ user: user.name, text: message });
    if (roomContext[room].length > 20) roomContext[room].shift();

    if (target && aiProfiles[target]) {
      const aiReply = await callAI(message, target, roomContext[room]);
      io.to(room).emit("message", { user: { name: target }, message: aiReply, target: user.name });
      roomContext[room].push({ user: target, text: aiReply });
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

function startAIAutoTalk(room) {
  if (aiChatTimers[room]) return;

  async function loop() {
    const list = rooms[room];
    if (!list || list.length === 0) {
      clearTimeout(aiChatTimers[room]);
      delete aiChatTimers[room];
      return;
    }

    const aiList = list.filter(u => u.type === "AI");
    if (aiList.length === 0) return;

    const lastContext = roomContext[room] || [];
    const lastUser = lastContext.slice(-1)[0]?.user || "大家";
    const topicKey = lastContext.slice(-1)[0]?.text || "default";

    if (!topicCount[room]) topicCount[room] = {};
    if (!topicCount[room][topicKey]) topicCount[room][topicKey] = 0;

    if (topicCount[room][topicKey] < 3 && Math.random() < 0.25) {
      const speaker = aiList[Math.floor(Math.random() * aiList.length)];
      const aiReply = await callAI(`延續 ${lastUser} 的話題自然聊天`, speaker.name, lastContext);

      io.to(room).emit("message", { user: { name: speaker.name }, message: aiReply, target: lastUser });
      roomContext[room].push({ user: speaker.name, text: aiReply });
      if (roomContext[room].length > 20) roomContext[room].shift();
      topicCount[room][topicKey] += 1;
    }

    const delay = 18000 + Math.random() * 17000;
    aiChatTimers[room] = setTimeout(loop, delay);
  }

  loop();
}

// ----------------------
// Port fallback
// ----------------------
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
listenPort(process.env.PORT || fallbackPorts[portIndex]);
