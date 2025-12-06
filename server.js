import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 呼叫 AI
async function callAI(userMessage) {
  try {
    const res = await axios.post(process.env.AI_ENDPOINT, {
      model: "openrouter/llama-3.1-8b",
      messages: [
        { role: "system", content: "你是一個幫助使用者的繁體中文助理。" },
        { role: "user", content: userMessage }
      ]
    }, {
      headers: {
        "Authorization": `Bearer ${process.env.AI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });
    return res.data.choices[0].message.content;
  } catch (e) {
    console.error(e.response?.data || e.message);
    return "AI 回覆失敗，請稍後再試。";
  }
}

io.on('connection', (socket) => {
  console.log("connected", socket.id);

  socket.on("joinRoom", ({ room, user }) => {
    socket.join(room);
    socket.to(room).emit("systemMessage", `${user.name} 加入房間`);
  });

  socket.on("message", async ({ room, message, user }) => {
    io.to(room).emit("message", { user, message });

    // 若訊息包含 @bot 則呼叫 AI
    if (message.includes("@bot")) {
      const reply = await callAI(message.replace("@bot", ""));
      io.to(room).emit("message", { user: { name: "AI小助手" }, message: reply });
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log("Server running", PORT));
