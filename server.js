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

const openai = new OpenAI({ baseURL: process.env.AI_ENDPOINT||'https://openrouter.ai/api/v1', apiKey: process.env.API_KEY||"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" });

async function callAI(message, personality) {
  try {
    const systemPrompt = `
你是一個模擬人格的聊天機器人。
角色名稱：${personality}。
請以繁體中文回答，保持熱情、有禮貌，口吻活潑。
每次回覆字數限制 15~40 字，不要回答「我是一個AI」或「我沒有意見」。
使用者說：「${message}」
請直接用角色口吻回覆：
`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15 秒
    const res = await fetch('http://220.135.33.190:11434/v1/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: "mistral",
        prompt: systemPrompt,
        max_tokens: 80,
        temperature: 0.7
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.error('Ollama API error', res.status, await res.text());
      return '對方回覆失敗，請稍後再試。';
    }

    const data = await res.json();
    const reply = data.completion || data.choices?.[0]?.text || '對方回覆失敗，請稍後再試。';
    return reply.trim();

  } catch (err) {
    console.error('callAI error', err);
    return '對方回覆失敗，請稍後再試。';
  }
}


// // 呼叫 AI
// async function callAI(message, personality) {
//   try {
//     const systemPrompt = `你是一個模擬人格的正常聊天，角色是 ${personality}，請以繁體中文，請用這個角色的口吻回答，字數限字在10~30內：`;
//     const completion = await openai.chat.completions.create({
//       model: 'tngtech/deepseek-r1t2-chimera:free',
//       messages: [
//         { role: 'system', content: systemPrompt },
//         { role: 'user', content: message }
//       ]
//     });
//     return completion.choices[0].message.content;
//   } catch (err) {
//     console.error(err.response?.data || err.message);
//     return '對方 回覆失敗，請稍後再試。';
//   }
// }

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
// 4. 自動 port fallback（三個 port）
// -----------------------------------
const fallbackPorts = [3000, 10000, 11000]; // 三個可選 fallback port
let portIndex = 0;

function listenPort(port) {
  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} 已被占用`);
      portIndex++;
      if (portIndex < fallbackPorts.length) {
        console.log(`嘗試下一個 port: ${fallbackPorts[portIndex]}`);
        listenPort(fallbackPorts[portIndex]);
      } else {
        console.error('所有 fallback port 都被占用，啟動失敗');
      }
    } else {
      console.error(err);
    }
  });
}

// Render 必須使用 process.env.PORT
const initialPort = process.env.PORT || fallbackPorts[portIndex];
listenPort(initialPort);
