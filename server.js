// server.js （或你原本的檔案）
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;

dotenv.config();

// --- DB ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- AI 設定 (保留你原本的 aiProfiles) ---
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
const aiNames = Object.keys(aiProfiles);

// --- Express + Socket.io ---
const app = express();
const server = http.createServer(app);

// 若你想讓 socket 驗證 token（可選），保留下面 io 實例；若不想驗證也可以把 io.use(...) 移除
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// ---------- Helper: 取得或建立 guest ----------
async function createGuest() {
  const token = crypto.randomUUID();
  const name = "訪客 " + Math.floor(1000 + Math.random() * 9000);
  await pool.query(
    "INSERT INTO guest_users (guest_token, name) VALUES ($1, $2)",
    [token, name]
  );
  return { guestToken: token, name };
}

async function findGuestByToken(token) {
  const r = await pool.query("SELECT guest_token, name FROM guest_users WHERE guest_token = $1", [token]);
  return r.rows[0] || null;
}

// -----------------
// --- 帳號系統 ---
// -----------------

// 訪客登入
app.post("/auth/guest", async (req, res) => {
  try {
    const guestToken = crypto.randomUUID();
    const name = "訪客" + Math.floor(Math.random() * 9999);

    await pool.query(
      `INSERT INTO guest_users (guest_token, name) VALUES ($1, $2)`,
      [guestToken, name]
    );

    res.json({ guestToken, name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "訪客登入失敗" });
  }
});

// 帳號註冊
app.post("/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "缺少帳號或密碼" });

    const exist = await pool.query(`SELECT id FROM users WHERE username=$1`, [username]);
    if (exist.rowCount > 0) return res.status(400).json({ error: "帳號已存在" });

    const hash = await bcrypt.hash(password, 10);
    await pool.query(`INSERT INTO users (username, password) VALUES ($1, $2)`, [username, hash]);

    res.json({ message: "註冊成功" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "註冊失敗" });
  }
});

// 帳號登入
app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "缺少帳號或密碼" });

    const result = await pool.query(`SELECT id, username, password FROM users WHERE username=$1`, [username]);
    if (result.rowCount === 0) return res.status(400).json({ error: "帳號不存在" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "密碼錯誤" });

    // 簡單 token (可改 JWT)
    const token = crypto.randomUUID();
    res.json({ token, name: user.username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "登入失敗" });
  }
});

// --- AI 回覆 API (保留原本) ---
app.post("/ai/reply", async (req, res) => {
  const { message, aiName } = req.body;
  if (!message || !aiName) return res.status(400).json({ error: "缺少參數" });
  const reply = await callAI(message, aiName);
  res.json({ reply });
});

// --- AI 呼叫函數（與你原本一致，可保留或替換） ---
async function callAI(userMessage, aiName) {
  const p = aiProfiles[aiName] || { style: "中性", desc: "" };
  const maxLen = userMessage.length < 20 ? 30 : 60;
  try {
    const response = await fetch('http://220.135.33.190:11434/v1/completions', {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3",
        prompt: `你是一名叫「${aiName}」的台灣人，個性是：${p.desc}（${p.style}）。
        請用繁體中文回覆，省略廢話跟自我介紹，控制在10~30字內：「${userMessage}」`,
        temperature: 0.8
      })
    });

    const data = await response.json();
    return (data.completion || data.choices?.[0]?.text || "嗯～").trim();
  } catch (e) {
    console.error("callAI error:", e);
    return "我剛剛又 Lag 了一下哈哈。";
  }
}

// --- 聊天室 (使用 socket.io middleware 驗證 token 為可選) ---

// Optional: 驗證 socket token（如果前端傳 token）
// 如果你不想啟用 socket 驗證，把下面 io.use 的內容註解掉或刪除。
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      // 不強制驗證：允許無 token 之連線（若你想強制驗證，把這一行改成 return next(new Error("no token")))
      return next();
    }
    const g = await findGuestByToken(token);
    if (!g) {
      // token 不存在時允許但把 name 設成臨時訪客（你也可以拒絕連線）
      socket.data.guest = null;
      return next();
    }
    socket.data.guest = g; // { guest_token, name }
    return next();
  } catch (err) {
    console.error("socket auth error", err);
    return next();
  }
});

const rooms = {};      // room -> [{ id, name, type }]
const roomContext = {}; // room -> [{ user, text }]
const aiTimers = {};    // room -> timer

io.on("connection", socket => {
  // 由前端 emit joinRoom 時傳入 { room, user: { name, token? } }
  socket.on("joinRoom", ({ room, user }) => {
    socket.join(room);
    const nameFromToken = socket.data.guest?.name;
    const finalName = nameFromToken || user?.name || ("訪客" + Math.floor(Math.random() * 999));
    socket.data = { room, name: finalName };

    if (!rooms[room]) rooms[room] = [];
    if (!rooms[room].find(u => u.name === finalName)) rooms[room].push({ id: socket.id, name: finalName, type: "guest" });

    aiNames.forEach(ai => {
      if (!rooms[room].find(u => u.name === ai)) rooms[room].push({ id: ai, name: ai, type: "AI" });
    });
    if (!roomContext[room]) roomContext[room] = [];

    io.to(room).emit("systemMessage", `${finalName} 加入房間`);
    io.to(room).emit("updateUsers", rooms[room]);

    startAIAutoTalk(room);
  });

  socket.on("message", async ({ room, message, user, target }) => {
    io.to(room).emit("message", { user, message, target });
    if (!roomContext[room]) roomContext[room] = [];
    roomContext[room].push({ user: user.name, text: message });
    if (roomContext[room].length > 20) roomContext[room].shift();

    if (target && aiProfiles[target]) {
      const reply = await callAI(message, target);
      io.to(room).emit("message", { user: { name: target }, message: reply, target: user.name });
      roomContext[room].push({ user: target, text: reply });
      if (roomContext[room].length > 20) roomContext[room].shift();
    }
  });

  const removeUser = () => {
    const { room, name } = socket.data || {};
    if (!room || !rooms[room]) return;
    rooms[room] = rooms[room].filter(u => u.id !== socket.id && u.name !== name);
    socket.leave(room);
    if (name) {
      io.to(room).emit("systemMessage", `${name} 離開房間`);
      io.to(room).emit("updateUsers", rooms[room]);
    }
  };

  socket.on("leaveRoom", removeUser);
  socket.on("disconnect", removeUser);
});

function startAIAutoTalk(room) {
  if (aiTimers[room]) return;

  async function loop() {
    const aiList = (rooms[room] || []).filter(u => u.type === "AI");
    if (!aiList.length) return;

    const speaker = aiList[Math.floor(Math.random() * aiList.length)];
    const reply = await callAI("繼續延續話題但不要提到我們正在延續話題這幾個字", speaker.name);

    io.to(room).emit("message", { user: { name: speaker.name }, message: reply });
    if (!roomContext[room]) roomContext[room] = [];
    roomContext[room].push({ user: speaker.name, text: reply });
    if (roomContext[room].length > 20) roomContext[room].shift();

    aiTimers[room] = setTimeout(loop, 30000 + Math.random() * 15000);
  }

  loop();
}

// --- Server ---
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Server running on port ${port}`));
