import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// 初始化 OpenRouter SDK
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

async function callAI(message) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'amazon/nova-2-lite-v1:free', // 可換成 openai/gpt-4o
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

  socket.on('joinRoom', ({ room, user }) => {
    socket.join(room);
    socket.to(room).emit('systemMessage', `${user.name} 加入房間`);
  });

  socket.on('message', async ({ room, message, user }) => {
    io.to(room).emit('message', { user, message });

    // 如果訊息包含 @bot，呼叫 AI
    if (message.includes('@bot')) {
      const reply = await callAI(message.replace('@bot', ''));
      io.to(room).emit('message', { user: { name: 'AI小助手' }, message: reply });
    }
  });
});

// 嘗試監聽 port，如果被占用就 fallback
function listenPort(port) {
  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} 已被占用，嘗試另一個 port`);
      if (port === 3000) listenPort(10000); // fallback 10000
    } else {
      console.error(err);
    }
  });
}

// 優先平台提供 port，再 fallback 3000
const initialPort = process.env.PORT || 3000;
listenPort(initialPort);