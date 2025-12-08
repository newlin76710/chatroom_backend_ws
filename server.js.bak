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

// -----------------------------------
// 1. 訪客登入 API
// -----------------------------------
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

// -----------------------------------
// 2. OAuth 綁定登入 API
// -----------------------------------
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
app.post("/ai/reply", async (req, res) => {
  try {
    const { message, aiName, room } = req.body;

    if (!message || !aiName || !room) {
      return res.status(400).json({ error: "缺少必要參數" });
    }

    // 取得房間最近 20 條訊息作為上下文
    const context = roomContext[room] || [];

    const reply = await callAI(message, aiName, context);

    // 將 AI 的回覆加入上下文
    if (!roomContext[room]) roomContext[room] = [];
    roomContext[room].push({ user: aiName, text: reply });
    if (roomContext[room].length > 20) roomContext[room].shift();

    res.json({ reply });
  } catch (err) {
    console.error("[AI /reply error]", err);
    res.status(500).json({ reply: "我剛剛又 Lag 了一下哈哈。" });
  }
});
// -----------------------------------
// 3. 聊天室 + AI 自動人格
// -----------------------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const aiPersonalities = [
  "林怡君","張雅婷","陳思妤","黃彥廷","王子涵","劉家瑋",
  "李佩珊","蔡承翰","許婉婷","周俊宏","何詩涵","鄭宇翔",
  "郭心怡","江柏翰","曾雅雯","施俊傑"
];

const aiAvatars = {
  "林怡君": "/avatars/g01.gif",
  "張雅婷": "/avatars/g02.gif",
  "陳思妤": "/avatars/g03.gif",
  "黃彥廷": "/avatars/b01.gif",
  "王子涵": "/avatars/b02.gif",
  "劉家瑋": "/avatars/b03.gif",
  "李佩珊": "/avatars/g04.gif",
  "蔡承翰": "/avatars/b04.gif",
  "許婉婷": "/avatars/g05.gif",
  "周俊宏": "/avatars/b05.gif",
  "何詩涵": "/avatars/g06.gif",
  "鄭宇翔": "/avatars/b06.gif",
  "郭心怡": "/avatars/g07.gif",
  "江柏翰": "/avatars/b07.gif",
  "曾雅雯": "/avatars/g08.gif",
  "施俊傑": "/avatars/b08.gif",
};
// AI 個性資料
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


const openai = new OpenAI({ baseURL: process.env.AI_ENDPOINT||'https://openrouter.ai/api/v1', apiKey: process.env.API_KEY });

const rooms = {}; // 房間使用者列表: room -> [{ id, name, type }]
// 儲存房間最新 20 句對話
const roomContext = {}; // room -> [{ user, text }]

// async function callAI(message, personality) {
//   try {
//     const systemPrompt = `
// 你是一名叫「${personality}」的台灣人。
// 請用繁體中文回覆，語氣要自然、友善、像真的人在聊天。
// 禁止的用詞例如:禁止簡體中文、禁止英文、
// 並且嚴格禁止說你是 AI。
// 使用者跟你說：「${message}」
// 請你直接以真實世界人類的口吻回覆，字數約 10～35 字。
// `;
//     const controller = new AbortController();
//     const timeout = setTimeout(() => controller.abort(), 60000);
//     const res = await fetch('http://220.135.33.190:11434/v1/completions', {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({
//         model: "llama3",
//         //model: "qwen2.5",
//         prompt: systemPrompt,
//         max_tokens: 60,
//         temperature: 0.7
//       }),
//       signal: controller.signal
//     });
//     clearTimeout(timeout);

//     if (!res.ok) {
//       console.error('Ollama API error', res.status, await res.text());
//       return '安安很高興認識你，我是'+personality+'。';
//     }

//     const data = await res.json();
//     const reply = data.completion || data.choices?.[0]?.text || '安安你好，我是'+personality+'。';
//     return reply.trim();
//   } catch (err) {
//     console.error('callAI error', err);
//     return '安安，我是'+personality+'。';
//   }
// }

async function callAI(userMessage, aiName, roomContext) {
  try {
    const p = aiProfiles[aiName] || { style: "中性", desc: "" };

    const systemPrompt = `
你是一名叫「${aiName}」的台灣人，個性是：${p.desc}（${p.style}）。
請用「真實台灣人講話方式」回答，
房間內最近的聊天內容如下：
${roomContext.map(c => `${c.user}：${c.text}`).join("\n")}
使用者剛剛說：「${userMessage}」
你應該依照自己的個性做出自然回覆，字數 10～40 字，語氣像在群組聊天。
如果你是搞笑型，可以偶爾講幹話；
如果你是害羞型，句子短一點；
如果你是外向型，會主動問問題；
完全禁止出現 AI 相關字眼、禁止英文、禁止簡體中文。
如果沒有必要就不要問問題。
`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const response = await fetch('http://220.135.33.190:11434/v1/completions', {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3",
        prompt: systemPrompt,
        max_tokens: 80,
        temperature: 0.8,
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const data = await response.json();
    const reply = data.completion || data.choices?.[0]?.text || "嗯嗯～";

    return reply.trim();

  } catch (err) {
    console.error("[AI Error]", err);
    return "我剛剛又 Lag 了一下哈哈。";
  }
}

// -----------------------------------
// 統一 WebSocket 事件
// -----------------------------------
io.on("connection", (socket) => {

  // -------- joinRoom --------
  socket.on("joinRoom", ({ room, user }) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.name = user.name;

    // 建立房間資料
    if (!rooms[room]) rooms[room] = [];

    // 加入真正使用者
    rooms[room].push({ id: socket.id, name: user.name, type: "guest" });

    // AI 加入房間（若不存在）
    aiPersonalities.forEach(ai => {
      if (!rooms[room].find(u => u.name === ai)) {
        rooms[room].push({ id: ai, name: ai, type: "AI" });
      }
    });

    // 初始化上下文
    if (!roomContext[room]) roomContext[room] = [];

    io.to(room).emit("systemMessage", `${user.name} 加入房間`);
    io.to(room).emit("updateUsers", rooms[room]);

    // 啟動 AI 自動聊天（避免重複開啟）
    setTimeout(() => startAIAutoTalk(room), 2000);
  });

  // -------- message --------
  socket.on("message", async ({ room, message, user, target }) => {

    // 廣播原訊息
    io.to(room).emit("message", { user, message, target });

    // 更新上下文
    roomContext[room].push({ user: user.name, text: message });
    if (roomContext[room].length > 20) roomContext[room].shift();

    // 如果 target 是 AI → AI 回覆
    if (target && aiProfiles[target]) {
      const aiReply = await callAI(message, target, roomContext[room]);

      io.to(room).emit("message", {
        user: { name: target },
        message: aiReply,
        target: user.name,
      });

      // AI 回覆也要加入上下文
      roomContext[room].push({ user: target, text: aiReply });
      if (roomContext[room].length > 20) roomContext[room].shift();
    }
  });

  // -------- 離線 / 離開 --------
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

const aiChatTimers = {};

function startAIAutoTalk(room) {
  if (aiChatTimers[room]) return; // 已啟動

  async function loop() {
    const list = rooms[room];
    if (!list || list.length === 0) {
      delete aiChatTimers[room];
      return;
    }

    const aiList = list.filter(u => u.type === "AI");
    if (aiList.length === 0) return;

    // 25% 機率發言
    if (Math.random() < 0.25) {
      const speaker = aiList[Math.floor(Math.random() * aiList.length)];

      const lastContext = roomContext[room] || [];
      const lastUser = lastContext.slice(-1)[0]?.user || "大家";

      const aiReply = await callAI(
        `延續 ${lastUser} 的話題自然聊天`,
        speaker.name,
        lastContext
      );

      io.to(room).emit("message", {
        user: { name: speaker.name },
        message: aiReply,
        target: lastUser,
      });

      roomContext[room].push({ user: speaker.name, text: aiReply });
      if (roomContext[room].length > 20) roomContext[room].shift();
    }

    // 下次聊天時間（18～35秒）
    const delay = 18000 + Math.random() * 17000;
    aiChatTimers[room] = setTimeout(loop, delay);
  }

  loop();
}


// -----------------------------------
// 4. 自動 port fallback
// -----------------------------------
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
