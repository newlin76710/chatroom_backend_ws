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

    await pool.query(
      "INSERT INTO guest_users (guest_token) VALUES ($1)",
      [guestToken]
    );

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
    // (1) 檢查是否已有綁定帳號
    const existBind = await pool.query(
      "SELECT user_id FROM oauth_accounts WHERE provider=$1 AND provider_id=$2",
      [provider, providerId]
    );

    if (existBind.rows.length > 0) {
      const user = await pool.query(
        "SELECT * FROM users WHERE id=$1",
        [existBind.rows[0].user_id]
      );
      return res.json({ user: user.rows[0] });
    }

    // (2) Email 是否存在 → 用舊的，不存在才新增
    let userId;
    const existEmail = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (existEmail.rows.length > 0) {
      userId = existEmail.rows[0].id;
    } else {
      const insert = await pool.query(
        "INSERT INTO users (email, name, avatar) VALUES ($1,$2,$3) RETURNING id",
        [email, name, avatar]
      );
      userId = insert.rows[0].id;
    }

    // (3) 新增 OAuth 綁定
    await pool.query(
      "INSERT INTO oauth_accounts (user_id, provider, provider_id) VALUES ($1,$2,$3)",
      [userId, provider, providerId]
    );

    // (4) 若有 guestToken → 移除訪客帳
    if (guestToken) {
      await pool.query(
        "DELETE FROM guest_users WHERE guest_token=$1",
        [guestToken]
      );
    }

    const user = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
    res.json({ user: user.rows[0] });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "oauth login failed" });
  }
});

// -----------------------------------
// 3. 聊天室 + AI 功能
// -----------------------------------

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// OpenRouter
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

// AI 呼叫
async function callAI(message) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'amazon/nova-2-lite-v1:free',
      messages: [
        { role: 'system', content: '你是一個幫助使用者的繁體中文助理。' },
        { role: 'user', content: message },
      ],
    });

    return completion.choices[0].message.content;
  } catch (err) {
    console.error(err.response?.data || err.message);
    return 'AI 回覆失敗，請稍後再試。';
  }
}

io.on('connection', (socket) => {
  console.log('connected', socket.id);

  // 使用者加入房間
  socket.on('joinRoom', ({ room, user }) => {
    socket.join(room);

    // 將使用者名稱存到 socket.data，方便之後斷線或離開使用
    socket.data.name = user.name;
    socket.data.room = room;

    // 廣播系統訊息給房間內其他人
    socket.to(room).emit('systemMessage', `${user.name} 加入房間`);
  });

  // 使用者發送訊息
  socket.on('message', async ({ room, message, user }) => {
    // 廣播訊息給房間內所有人
    io.to(room).emit('message', { user, message });

    // 如果訊息包含 @bot，呼叫 AI 回覆
    if (message.includes('@bot')) {
      const reply = await callAI(message.replace('@bot', '').trim());
      io.to(room).emit('message', { user: { name: 'AI小助手' }, message: reply });
    }
  });

  // 使用者離開房間
  socket.on('leaveRoom', () => {
    const { room, name } = socket.data;
    if (room) {
      socket.leave(room);
      io.to(room).emit('systemMessage', `${name} 離開房間`);
      socket.data.room = null;
    }
  });

  // 斷線事件
  socket.on('disconnect', () => {
    const { room, name } = socket.data;
    if (room) {
      io.to(room).emit('systemMessage', `${name} 離開房間`);
    }
  });
});


// -----------------------------------
// 4. 自動 port fallback (3000 → 10000)
// -----------------------------------
function listenPort(port) {
  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} 已被占用，嘗試另一個 port`);
      if (port === 3000) listenPort(10000);
    } else {
      console.error(err);
    }
  });
}

const initialPort = process.env.PORT || 3000;
listenPort(initialPort);
