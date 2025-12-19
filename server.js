import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';
import pkg from 'pg';
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";

const { Pool } = pkg;
dotenv.config();

// --- DB ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- AI 設定 ---
const aiProfiles = {
  "林怡君": { style: "外向", desc: "很健談，喜歡分享生活。", level: 5, job: "社群行銷", gender: "女" },
  "張雅婷": { style: "害羞", desc: "說話溫柔，句子偏短。", level: 8, job: "學生", gender: "女" },
  "思妤": { style: "搞笑", desc: "喜歡講幹話、氣氛製造機。", level: 13, job: "喜劇演員", gender: "女" },
  "黃彥廷": { style: "穩重", desc: "語氣沈穩，回覆較中性。", level: 15, job: "律師", gender: "男" },
  "隨風飛揚": { style: "天真", desc: "像可愛弟弟妹妹，很直率。", level: 17, job: "大學生", gender: "男" },
  "家瑋": { style: "暖心", desc: "安撫型，講話溫暖。", level: 20, job: "心理諮商師", gender: "男" },
  "李佩珊": { style: "外向", desc: "喜歡問問題，擅長帶話題。", level: 22, job: "業務專員", gender: "女" },
  "蔡承翰": { style: "吐槽", desc: "回話直接、喜歡鬧別人。", level: 25, job: "工程師", gender: "男" },
  "婷x2": { style: "知性", desc: "講話有邏輯，句型較完整。", level: 31, job: "老師", gender: "女" },
  "周俊宏": { style: "開朗", desc: "活潑健談，喜歡講笑話。", level: 32, job: "主持人", gender: "男" },
  "詩與遠方": { style: "文青", desc: "喜歡聊心情與生活感受。", level: 40, job: "作家", gender: "女" },
  "鄭宇翔": { style: "沉默", desc: "話不多，但會突然丟一句。", level: 45, job: "資料分析師", gender: "男" },
  "郭心怡的朋友": { style: "可愛", desc: "語氣甜甜的。", level: 47, job: "幼教老師", gender: "女" },
  "江柏翰": { style: "理工男", desc: "講話直白，略呆。", level: 48, job: "軟體工程師", gender: "男" },
  "小龍女": { style: "喜歡八卦", desc: "最愛聊人與人之間的事。", level: 49, job: "記者", gender: "女" },
  "神鍵墨客": { style: "運動系", desc: "語氣健康、陽光。", level: 50, job: "健身教練", gender: "男" },
};

const aiNames = Object.keys(aiProfiles);

// --- Express + Socket.io ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const __dirname = new URL('.', import.meta.url).pathname;
const uploadDir = path.join(__dirname, "uploads", "songs");

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

app.use("/songs", express.static(uploadDir));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// -----------------
// --- 帳號系統 ---
// 訪客登入
app.post("/auth/guest", async (req, res) => {
  try {
    const { gender } = req.body;
    const safeGender = gender === "男" ? "男" : "女"; // 中文化

    const guestName = "訪客" + Math.floor(Math.random() * 10000);
    const now = new Date();
    const guestToken = crypto.randomUUID();
    const randomPassword = crypto.randomBytes(8).toString("hex"); // 隨機密碼
    const level = 1;
    const exp = 0;

    const result = await pool.query(
      `INSERT INTO users (username, password, gender, last_login, account_type, level, exp)
       VALUES ($1, $2, $3, $4, 'guest', $5, $6)
       RETURNING id, username, gender, level, exp`,
      [guestName, randomPassword, safeGender, now, level, exp]
    );

    const guest = result.rows[0];

    res.json({
      guestToken,
      name: guest.username,
      gender: guest.gender,
      level: guest.level,
      exp: guest.exp,
      last_login: now,
    });
  } catch (err) {
    console.error("訪客登入錯誤：", err);
    res.status(500).json({ error: "訪客登入失敗" });
  }
});

// 註冊
app.post("/auth/register", async (req, res) => {
  try {
    const { username, password, gender, phone, email, avatar } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: "缺少帳號或密碼" });

    const exist = await pool.query(
      `SELECT id FROM users WHERE username = $1`,
      [username]
    );
    if (exist.rowCount > 0)
      return res.status(400).json({ error: "帳號已存在" });

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (username, password, gender, phone, email, avatar, level, exp)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 0)
       RETURNING id, username, gender, avatar, level, exp`,
      [
        username,
        hash,
        gender === "男" ? "男" : "女",
        phone || null,
        email || null,
        avatar || null
      ]
    );

    res.json({ message: "註冊成功", user: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "註冊失敗" });
  }
});


// 帳號登入
app.post("/auth/login", async (req, res) => {
  try {
    const { username, password, gender } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: "缺少帳號或密碼" });

    const result = await pool.query(
      `SELECT id, username, password, level, exp, avatar FROM users WHERE username=$1`,
      [username]
    );

    if (result.rowCount === 0)
      return res.status(400).json({ error: "帳號不存在" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "密碼錯誤" });

    const safeGender = gender === "男" ? "男" : "女"; // 中文化
    const now = new Date();

    await pool.query(
      `UPDATE users SET gender=$1, last_login=$2, account_type='account' WHERE id=$3`,
      [safeGender, now, user.id]
    );

    const token = crypto.randomUUID();

    res.json({
      token,
      name: user.username,
      level: user.level,
      exp: user.exp,
      gender: safeGender,
      avatar: user.avatar,
      last_login: now,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "登入失敗" });
  }
});



// --- AI 回覆 API ---
app.post("/ai/reply", async (req, res) => {
  const { message, aiName } = req.body;
  if (!message || !aiName) return res.status(400).json({ error: "缺少參數" });
  const reply = await callAI(message, aiName);
  res.json({ reply });
});

// --- 歌曲上傳 ---
app.post("/song/upload", async (req, res) => {
  try {
    const { audioBase64, singer } = req.body;
    if (!audioBase64) return res.status(400).json({ error: "no audio" });

    const buffer = Buffer.from(audioBase64, "base64");
    const filename = `${Date.now()}_${singer}.webm`;
    const filepath = path.join(uploadDir, filename);

    fs.writeFileSync(filepath, buffer);
    res.json({ url: `/songs/${filename}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "upload failed" });
  }
});

// --- AI 呼叫函數 ---
async function callAI(userMessage, aiName) {
  const p = aiProfiles[aiName] || { style: "中性", desc: "", level: 99, job: "未知職業" };
  const jobText = p.job ? `她/他的職業是 ${p.job}，` : "";

  try {
    const response = await fetch('http://220.135.33.190:11434/v1/completions', {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3",
        prompt: `
你是一名叫「${aiName}」的台灣人，個性是：${p.desc}（${p.style}）。
${jobText}請用繁體中文回覆，省略廢話跟自我介紹，控制在10~30字內：
「${userMessage}」`,
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

async function callAISongComment({ singer, avg }) {
  let mood = "中性評論";

  if (avg >= 4.2) mood = "超暖心誇讚";
  else if (avg < 3.2) mood = "毒舌但幽默";

  const aiList = aiNames;
  const aiName = aiList[Math.floor(Math.random() * aiList.length)];
  const profile = aiProfiles[aiName] || {};
  const jobText = profile.job ? `她/他的職業是 ${profile.job}，` : "";

  const prompt = `
你是聊天室裡的 AI「${aiName}」
現在 ${singer} 剛唱完一首歌
平均分數是 ${avg} 分
${jobText}請用「${mood}」風格評論
限制 15~30 字
請用繁體中文，不要自我介紹
`;

  const text = await callAI(prompt, aiName);

  return {
    user: { name: aiName },
    message: `🎤 歌評：${text}`,
    mode: "public"
  };
}
// 等級升級需求費氏數列，從等級1開始
function expForNextLevel(level) {
  let a = 100, b = 100;
  if (level <= 1) return 100;

  for (let i = 2; i <= level; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return b;
}

// --- Socket.io 聊天室 ---
const rooms = {};
const roomContext = {};
const aiTimers = {};
const videoState = {}; // room -> { currentVideo, queue }
const songState = {};  // songState[room] = { queue: [{singer, url}], current: {singer, url}, scores: [], timer: null }
// 🔹 純顯示用播放列隊（不控制播放）
const displayQueue = {};
// room -> [{ type: "song" | "video", name, title }]

io.on("connection", socket => {
  socket.on("joinRoom", async ({ room, user }) => {
    socket.join(room);

    // --- 預設值 ---
    let name = user.name || "訪客" + Math.floor(Math.random() * 999);
    let level = 1;
    let exp = 0;
    let gender = "女";
    let avatar = "/avatars/g01.gif"; // 預設頭像
    let type = user.type || "guest";

    // --- 從資料庫取得使用者資料 (account 或 guest) ---
    try {
      const res = await pool.query(
        `SELECT username, level, exp, gender, avatar FROM users WHERE username=$1`,
        [user.name]
      );
      const dbUser = res.rows[0];
      if (dbUser) {
        name = dbUser.username;
        level = dbUser.level || 1;
        exp = dbUser.exp || 0;
        gender = dbUser.gender || "女";
        avatar = dbUser.avatar || avatar;
        type = type === "account" ? "account" : type; // 確保已註冊帳號是 account
      }
    } catch (err) {
      console.error("Socket joinRoom 取得使用者資料錯誤：", err);
    }

    // --- 將資料存到 socket 上方便後續使用 ---
    socket.data = { room, name, level, gender, avatar, type };

    // --- 房間使用者列表 ---
    if (!rooms[room]) rooms[room] = [];
    if (!rooms[room].find(u => u.name === name)) {
      rooms[room].push({ id: socket.id, name, type, level, exp, gender, avatar });
    }

    // --- 加入 AI 使用者 ---
    aiNames.forEach(ai => {
      if (!rooms[room].find(u => u.name === ai)) {
        rooms[room].push({
          id: ai,
          name: ai,
          type: "AI",
          level: aiProfiles[ai]?.level || 99,
          gender: aiProfiles[ai]?.gender || "女",
          avatar: aiProfiles[ai]?.avatar || null, // <- 保留原本設定
        });
      }
    });

    // --- 初始化房間 context & video state ---
    if (!roomContext[room]) roomContext[room] = [];
    if (!videoState[room]) videoState[room] = { currentVideo: null, queue: [] };

    // --- 廣播訊息與使用者列表 ---
    io.to(room).emit("systemMessage", `${name} 加入房間`);
    io.to(room).emit("updateUsers", rooms[room]);
    io.to(room).emit("videoUpdate", videoState[room].currentVideo);
    io.to(room).emit("videoQueueUpdate", videoState[room].queue);

    // --- 啟動 AI 自動對話 ---
    startAIAutoTalk(room);
  });

  socket.on("message", async ({ room, message, user, target, mode }) => {
    if (!roomContext[room]) roomContext[room] = [];
    roomContext[room].push({ user: user.name, text: message });
    if (roomContext[room].length > 20) roomContext[room].shift();

    const msgPayload = { user, message, target: target || "", mode };

    try {
      // 取得使用者資料
      const res = await pool.query(
        `SELECT id, level, exp, gender, avatar, account_type FROM users WHERE username=$1`,
        [user.name]
      );
      let dbUser = res.rows[0];

      if (dbUser) {
        let { level, exp, gender, avatar, account_type } = dbUser;
        exp += 5; // 發訊息 +5 EXP

        // 判斷升級
        while (exp >= expForNextLevel(level)) {
          exp -= expForNextLevel(level);
          level += 1;
        }

        // 更新資料庫
        await pool.query(
          `UPDATE users SET level=$1, exp=$2 WHERE id=$3`,
          [level, exp, dbUser.id]
        );

        // 更新 rooms[room] 裡的使用者資料
        if (rooms[room]) {
          const roomUser = rooms[room].find(u => u.name === user.name);
          if (roomUser) {
            roomUser.exp = exp;
            roomUser.level = level;
            roomUser.gender = gender;
            roomUser.avatar = avatar || roomUser.avatar || "/avatars/g01.gif";
            roomUser.type = account_type || roomUser.type || "guest";
          }
        }
      }
    } catch (err) {
      console.error("更新 EXP/LV/使用者資料 失敗：", err);
    }

    // --- 廣播訊息 ---
    if (mode === "private" && target) {
      const sockets = Array.from(io.sockets.sockets.values());
      sockets.forEach(s => {
        if (s.data.name === target || s.data.name === user.name) s.emit("message", msgPayload);
      });
    } else {
      io.to(room).emit("message", msgPayload);
    }

    // --- 廣播更新使用者 EXP / LV / avatar / type ---
    if (rooms[room]) {
      io.to(room).emit("updateUsers", rooms[room]);
    }

    // --- AI 回覆 ---
    if (target && aiProfiles[target]) {
      const reply = await callAI(message, target);
      const aiMsg = { user: { name: target }, message: reply, target: user.name, mode };
      if (mode === "private") {
        const sockets = Array.from(io.sockets.sockets.values());
        sockets.forEach(s => {
          if (s.data.name === target || s.data.name === user.name) s.emit("message", aiMsg);
        });
      } else io.to(room).emit("message", aiMsg);

      roomContext[room].push({ user: target, text: reply });
      if (roomContext[room].length > 20) roomContext[room].shift();
    }
  });


  // --- 歌唱狀態 ---
  // --- 即時語音廣播 ---
  // 開始唱歌
  // WebRTC 信令
  socket.on("offer", ({ offer, to }) => {
    io.to(to).emit("offer", { offer, from: socket.id });
  });

  socket.on("answer", ({ answer, to }) => {
    io.to(to).emit("answer", { answer, from: socket.id });
  });

  socket.on("ice-candidate", ({ candidate, to }) => {
    io.to(to).emit("ice-candidate", { candidate, from: socket.id });
  });

  // --- 歌唱狀態 ---
  socket.on("start-singing", ({ room, singer }) => {
    socket.data.isSinging = true;
    socket.data.singer = singer;
    io.to(room).emit("user-start-singing", { singer });
  });

  socket.on("stop-singing", ({ room, singer }) => {
    socket.data.isSinging = false;
    io.to(room).emit("user-stop-singing", { singer });
  });
  // 新增歌曲
  socket.on("startSong", ({ room, singer, songUrl }) => {
    if (!displayQueue[room]) displayQueue[room] = [];

    displayQueue[room].push({
      type: "song",
      name: singer,
      title: "演唱歌曲"
    });

    io.to(room).emit("displayQueueUpdate", displayQueue[room]);
    if (!songState[room]) songState[room] = { queue: [], current: null, scores: [], timer: null, scoreTimer: null };
    songState[room].queue.push({ singer, url: songUrl });
    if (!songState[room].current) playNextSong(room);
  });

  // 評分
  socket.on("scoreSong", ({ room, score }) => {
    const state = songState[room];
    if (!state || !state.current) return;
    state.scores.push(score);
  });

  // --- YouTube ---
  socket.on("playVideo", ({ room, url, user }) => {
    if (!displayQueue[room]) displayQueue[room] = [];

    displayQueue[room].push({
      type: "video",
      name: user?.name || "訪客",
      title: "點播影片"
    });

    io.to(room).emit("displayQueueUpdate", displayQueue[room]);
    if (!videoState[room]) videoState[room] = { currentVideo: null, queue: [] };
    const video = { url, user };
    videoState[room].currentVideo = video;
    videoState[room].queue.push(video);
    io.to(room).emit("videoUpdate", video);
    io.to(room).emit("videoQueueUpdate", videoState[room].queue);
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

function playNextSong(room) {
  const state = songState[room];
  if (!state.queue.length) {
    state.current = null;
    io.to(room).emit("playSong", null);
    return;
  }

  state.current = state.queue.shift();
  state.scores = [];
  io.to(room).emit("playSong", state.current); // 播放歌曲通知前端
  if (displayQueue[room]) {
    displayQueue[room].shift();
    io.to(room).emit("displayQueueUpdate", displayQueue[room]);
  }

  // 偵聽前端播放完事件，開始倒數 30 秒評分
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    // 歌曲播完後 30 秒倒數
    if (state.scoreTimer) clearTimeout(state.scoreTimer);
    state.scoreTimer = setTimeout(async () => {
      const scores = state.scores;
      const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : 0;

      // 公布分數
      io.to(room).emit("songResult", {
        singer: state.current.singer,
        avg,
        count: scores.length
      });

      // AI 歌評
      const aiComment = await callAISongComment({ singer: state.current.singer, avg });
      io.to(room).emit("message", aiComment);

      // 播放下一首
      playNextSong(room);
    }, 30000); // 30 秒倒數
  }, 0); // 0 代表前端會先播放歌曲，再用 audio onEnded 通知
}

// --- AI 自動對話 ---
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
const port = process.env.PORT || 10000;
server.listen(port, () => console.log(`Server running on port ${port}`));
