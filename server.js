
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// simple AI call using OpenRouter free models
async function callAI(userMessage) {
  try {
    const res = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
      model: "openrouter/llama-3.1-8b",
      messages: [
        { role: "system", content: "You are a helpful Traditional Chinese assistant."},
        { role: "user", content: userMessage }
      ]
    },{
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      }
    });
    return res.data.choices[0].message.content;
  } catch(e){
    console.error(e.response?.data || e.message);
    return "AI 回覆失敗，請稍後再試。";
  }
}

io.on('connection', (socket)=>{
  console.log("connected", socket.id);

  socket.on("joinRoom", ({room, user})=>{
    socket.join(room);
    socket.to(room).emit("systemMessage", `${user.name} 加入房間`);
  });

  socket.on("message", async ({room, message, user})=>{
    io.to(room).emit("message", {user, message});
    if(message.includes("@bot")){
      const reply = await callAI(message.replace("@bot",""));
      io.to(room).emit("message", {user:{name:"AI小助手"}, message: reply});
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, ()=> console.log("Server running", PORT));
