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

const openai = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY });

// 生成隨機 AI 人格
function randomAIPersonality() {
  const genders = ["女性", "男性"];
  const maritalStatuses = ["未婚", "已婚"];
  const personalityIndexes = [1,2,3,4];

  const gender = genders[Math.floor(Math.random() * genders.length)];
  const maritalStatus = maritalStatuses[Math.floor(Math.random() * maritalStatuses.length)];
  const personalityIndex = personalityIndexes[Math.floor(Math.random() * personalityIndexes.length)];

  return `${maritalStatus}${gender}-${personalityIndex}`;
}

// 呼叫 AI
async function callAI(message, personality) {
  try {
    const systemPrompt = `你是一個模擬人格的正常聊天，角色是 ${personality}，請以繁體中文，請用這個角色的口吻回答，字數限字在10~30內：`;
    const completion = await openai.chat.completions.create({
      model: 'tngtech/deepseek-r1t2-chimera:free',
      //model: "amazon/nova-2-lite-v1:free",
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ]
    });
    return completion.choices[0].message.content;
  } catch (err) {
    console.error(err.response?.data || err.message);
    return '對方 回覆失敗，請稍後再試。';
  }
}

io.on('connection', (socket) => {
  console.log('connected', socket.id);

  // 使用者加入房間
  socket.on('joinRoom', ({ room, user }) => {
    socket.join(room);
    socket.data.name = user.name;
    socket.data.room = room;

    socket.to(room).emit('systemMessage', `${user.name} 加入房間`);
  });

  // 發送訊息
  socket.on('message', async ({ message, user, targetAI }) => {
    io.to(user.room || 'public').emit('message', { user, message });

    // 如果有指定 targetAI → AI 回覆
    if (!targetAI) return;

    const aiPersonality = targetAI; // targetAI 直接作為人格名稱
    const reply = await callAI(message, aiPersonality);

    io.to(user.room || 'public').emit('message', {
      user: { name: aiPersonality },
      message: reply
    });
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

  // 斷線
  socket.on('disconnect', () => {
    const { room, name } = socket.data;
    if (room) io.to(room).emit('systemMessage', `${name} 離開房間`);
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

listenPort(process.env.PORT || 3000);
