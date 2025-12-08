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

const openai = new OpenAI({ baseURL: process.env.AI_ENDPOINT||'https://openrouter.ai/api/v1', apiKey: process.env.API_KEY });

const rooms = {}; // 房間使用者列表: room -> [{ id, name, type }]

async function callAI(message, personality) {
  try {
    const systemPrompt = `
你是一名叫「${personality}」的台灣人。
請用繁體中文回覆，語氣要自然、友善、像真的人在聊天。
禁止的用詞例如:禁止簡體中文、禁止英文、
並且嚴格禁止說你是 AI。
使用者跟你說：「${message}」
請你直接以真實世界人類的口吻回覆，字數約 10～35 字。
`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const res = await fetch('http://220.135.33.190:11434/v1/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: "llama3",
        //model: "qwen2.5",
        prompt: systemPrompt,
        max_tokens: 60,
        temperature: 0.7
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.error('Ollama API error', res.status, await res.text());
      return '安安很高興認識你，我是'+personality+'。';
    }

    const data = await res.json();
    const reply = data.completion || data.choices?.[0]?.text || '安安你好，我是'+personality+'。';
    return reply.trim();
  } catch (err) {
    console.error('callAI error', err);
    return '安安，我是'+personality+'。';
  }
}

io.on('connection', (socket) => {
  console.log('connected', socket.id);

  // 使用者加入房間
  socket.on('joinRoom', ({ room, user }) => {
    socket.join(room);
    socket.data.name = user.name;
    socket.data.room = room;

    // 建立房間陣列
    if (!rooms[room]) rooms[room] = [];
    // 加入使用者
    rooms[room].push({ id: socket.id, name: user.name, type: 'guest' });

    // AI 人格加入房間
    aiPersonalities.forEach(ai => {
      if (!rooms[room].find(u => u.name === ai))
        rooms[room].push({ id: ai, name: ai, type: 'AI' });
    });

    io.to(room).emit('systemMessage', `${user.name} 加入房間`);
    io.to(room).emit('updateUsers', rooms[room]);
  });

  // 發送訊息
  socket.on('message', async ({ room, message, user, target }) => {
    // 先廣播原訊息
    io.to(room).emit('message', { user, message, target });

    // 如果 target 是 AI
    if (target && aiAvatars[target]) {
      const aiReply = await callAI(message, target); // 呼叫你之前寫的 callAI
      io.to(room).emit('message', {
        user: { name: target },
        message: aiReply,
        target: user.name, // AI 回覆給原發訊息的人
      });
    }
  });

  // 離開房間
  socket.on('leaveRoom', () => {
    const { room, name } = socket.data;
    if (room && rooms[room]) {
      rooms[room] = rooms[room].filter(u => u.id !== socket.id);
      socket.leave(room);
      io.to(room).emit('systemMessage', `${name} 離開房間`);
      io.to(room).emit('updateUsers', rooms[room]);
    }
    socket.data.room = null;
  });

  // 斷線
  socket.on('disconnect', () => {
    const { room, name } = socket.data;
    if (room && rooms[room]) {
      rooms[room] = rooms[room].filter(u => u.id !== socket.id);
      io.to(room).emit('systemMessage', `${name} 離開房間`);
      io.to(room).emit('updateUsers', rooms[room]);
    }
  });
});

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
