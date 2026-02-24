import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "./db.js";
import { logLogin } from "./loginLogger.js";
import { onlineUsers } from "./chat.js";
import { addUserIP, removeUserIP } from "./ip.js";

const ROOM = process.env.ROOMNAME || 'windsong';
export const authRouter = express.Router();
export const ioTokens = new Map();
const fullWidthRegex = /[^\u0000-\u00ff]/;

function getNicknameLength(str = "") {
  let len = 0;
  for (const ch of str) {
    len += fullWidthRegex.test(ch) ? 2 : 1;
  }
  return len;
}

function isNicknameTooLong(username) {
  return getNicknameLength(username) > 12;
}
function isNicknameTooShort(username) {
  return getNicknameLength(username) < 3;
}

/* ================= 工具 ================= */
function getClientIP(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress
  );
}
/* ================= 工具 ================= */
async function isIPBlocked(ip) {
  try {
    const result = await pool.query(
      `SELECT 1 FROM blocked_ips WHERE ip=$1 and room = $2 LIMIT 1`,
      [ip, ROOM]
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error("IP 檢查失敗:", err);
    return false; // 失敗不阻擋登入
  }
}

async function isNicknameBlocked(username) {
  try {
    const result = await pool.query(
      `
      SELECT nickname
      FROM blocked_nicknames
      WHERE $1 ILIKE '%' || nickname || '%'
      AND room = $2
      LIMIT 1
      `,
      [username, ROOM]
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error("暱稱檢查失敗:", err);
    // ⭐ 失敗不要擋登入
    return false;
  }
}

// 允許中文、英文、數字，不允許特殊符號
const isValidNickname = (name) => /^[\u4e00-\u9fa5a-zA-Z0-9]+$/.test(name);


/* ================= 驗證 Middleware（room-based） ================= */
export const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers["authorization"]?.split(" ")[1] || req.body.token;
    if (!token) return res.status(401).json({ error: "No token provided" });

    const data = ioTokens.get(token);
    if (!data) return res.status(401).json({ error: "Invalid token" });

    const username = data.username;
    const room = req.body.room || ROOM; // 🔹 從 body 拿 room 或用預設 ROOM

    // 先抓 users
    const userRes = await pool.query(
      `SELECT id, username, gender, avatar, account_type
       FROM users
       WHERE username=$1`,
      [username]
    );
    if (!userRes.rowCount) return res.status(401).json({ error: "Invalid token" });

    const user = userRes.rows[0];

    // 再抓 user_room_stats 該 room 的等級/經驗
    const statsRes = await pool.query(
      `SELECT level, exp
       FROM user_room_stats
       WHERE user_id=$1 AND room=$2`,
      [user.id, room]
    );

    const stats = statsRes.rowCount ? statsRes.rows[0] : { level: 1, exp: 0 };

    req.user = {
      ...user,
      level: stats.level,
      exp: stats.exp,
      room
    };

    next();
  } catch (err) {
    console.error("authMiddleware error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

/* ================= 訪客登入 ================= */
authRouter.post("/guest", async (req, res) => {
  const ip = getClientIP(req);
  const userAgent = req.headers["user-agent"];
  const { gender, username } = req.body;

  try {
    if (!username || isNicknameTooLong(username)) {
      return res.status(400).json({
        error: "暱稱最多 6 個中文字 或 12 個英數字",
      });
    }
    if (isNicknameTooShort(username)) {
      return res.status(400).json({
        error: "暱稱最少 3 個英數字 或 2 個中文字"
      });
    }
    if (!isValidNickname(username)) {
      return res.status(400).json({
        error: "暱稱只能包含中文、英文或數字，不能包含符號"
      });
    }
    // IP 黑名單檢查
    if (await isIPBlocked(ip)) {
      await logLogin({
        username: username || "訪客",
        loginType: "guest",
        ip,
        userAgent,
        success: false,
        failReason: "IP 被封鎖",
      });
      return res.status(403).json({ error: "你的 IP 已被封鎖，無法登入" });
    }

    // 暱稱黑名單檢查
    if (await isNicknameBlocked(username)) {
      await logLogin({
        username: username,
        loginType: "guest",
        ip,
        userAgent,
        success: false,
        failReason: "暱稱黑名單",
      });
      return res.status(403).json({ error: "此暱稱不可使用" });
    }

    const safeGender = gender === "男" ? "男" : "女";
    const baseName = username?.trim() ? `訪客_${username.trim()}` : "訪客" + Math.floor(Math.random() * 10000);
    let guestName = baseName;

    // DB 檢查是否有人用正式帳號搶了這個暱稱
    const accountExists = await pool.query(
      `SELECT 1 FROM users WHERE username=$1 AND account_type='account'`,
      [username]
    );
    if (accountExists.rows.length) return res.status(400).json({ error: "暱稱已有人使用" });

    // 🔹 記憶體檢查暱稱是否在線
    if (onlineUsers.has(guestName)) {
      return res.status(400).json({ error: "暱稱正在使用" });
    }

    if (!addUserIP(ip, guestName)) {
      return res.status(400).json({
        error: "同一 IP 最多只能登入 5 個帳號"
      });
    }

    const now = new Date();
    const guestToken = crypto.randomUUID();
    const randomPassword = crypto.randomBytes(8).toString("hex");

    // DB 存資料（仍保留，方便後續紀錄或統計）
    const result = await pool.query(
      `INSERT INTO users
       (username, password, gender, last_login, account_type, level, exp, login_token)
       VALUES ($1,$2,$3,$4,'guest',1,0,$5)
       ON CONFLICT (username) DO UPDATE SET
         last_login=EXCLUDED.last_login,
         login_token=EXCLUDED.login_token,
         gender = EXCLUDED.gender
       RETURNING id, username, gender, level, exp`,
      [guestName, randomPassword, safeGender, now, guestToken]
    );

    const guest = result.rows[0];

    // 🔹 記憶體標記為線上
    onlineUsers.set(guestName, Date.now());
    ioTokens.set(guestToken, { username: guestName, socketId: null, ip });

    await logLogin({ userId: guest.id, username: guest.username, loginType: "guest", ip, userAgent, success: true });

    res.json({
      guestToken,
      name: guest.username,
      gender: guest.gender,
      level: guest.level,
      exp: guest.exp,
      last_login: now.toISOString(),
    });
  } catch (err) {
    console.error("訪客登入失敗：", err);
    res.status(500).json({ error: "訪客登入失敗" });
  }
});


// 註冊
authRouter.post("/register", async (req, res) => {
  try {
    const ip = getClientIP(req);
    const { username, password, gender, phone, email, avatar } = req.body;
    if (!username || isNicknameTooLong(username)) {
      return res.status(400).json({
        error: "暱稱最多 6 個中文字 或 12 個英數字",
      });
    }
    if (isNicknameTooShort(username)) {
      return res.status(400).json({
        error: "暱稱最少 3 個英數字 或 2 個中文字"
      });
    }
    if (!isValidNickname(username)) {
      return res.status(400).json({
        error: "暱稱只能包含中文、英文或數字，不能包含符號"
      });
    }
    if (!username || !password) return res.status(400).json({ error: "缺少帳號或密碼" });
    if (await isNicknameBlocked(username)) {
      return res.status(403).json({
        error: "此帳號暱稱違反規範"
      });
    }
    const exist = await pool.query(`SELECT id FROM users WHERE username = $1`, [username]);
    if (exist.rowCount > 0) return res.status(400).json({ error: "帳號已存在" });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password, gender, phone, email, avatar, level, exp, register_ip)
       VALUES ($1, $2, $3, $4, $5, $6, 2, 0, $7)
       RETURNING id, username, gender, avatar, level, exp`,
      [username, hash, gender === "男" ? "男" : "女", phone || null, email || null, avatar || null, ip || null]
    );

    res.json({ message: "註冊成功", user: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "註冊失敗" });
  }
});

/* ================= 正式登入（記憶體版） ================= */
authRouter.post("/login", async (req, res) => {
  const ip = getClientIP(req);
  const userAgent = req.headers["user-agent"];
  const { username, password } = req.body;

  try {
    if (!username || isNicknameTooLong(username)) {
      return res.status(400).json({
        error: "暱稱最多 6 個中文字 或 12 個英數字",
      });
    }
    if (isNicknameTooShort(username)) {
      return res.status(400).json({
        error: "暱稱最少 3 個英數字 或 2 個中文字"
      });
    }
    if (!isValidNickname(username)) {
      return res.status(400).json({
        error: "暱稱只能包含中文、英文或數字，不能包含符號"
      });
    }

    if (await isIPBlocked(ip)) {
      await logLogin({
        username: username || "-",
        loginType: "normal",
        ip,
        userAgent,
        success: false,
        failReason: "IP 被封鎖",
      });
      return res.status(403).json({ error: "你的 IP 已被封鎖，無法登入" });
    }

    if (await isNicknameBlocked(username)) {
      await logLogin({
        username: username || "-",
        loginType: "normal",
        ip,
        userAgent,
        success: false,
        failReason: "暱稱被封鎖",
      });
      return res.status(403).json({ error: "你的暱稱已被封鎖，無法登入" });
    }

    if (!username || !password) return res.status(400).json({ error: "缺少帳號或密碼" });

    // 從資料庫取得帳號資訊（密碼、基本資料）
    const result = await pool.query(
      `SELECT id, username, password, avatar, gender 
       FROM users WHERE username=$1`,
      [username]
    );

    if (!result.rowCount) return res.status(400).json({ error: "帳號不存在" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "密碼錯誤" });

    // ====== 處理聊天室等級/經驗 ======
    const room = ROOM; // 或者 req.body.room
    let statsRes = await pool.query(
      `SELECT level, exp FROM user_room_stats WHERE user_id=$1 AND room=$2`,
      [user.id, room]
    );

    let level, exp;
    if (!statsRes.rowCount) {
      // 如果沒有該聊天室紀錄，給預設 2 等 0 exp
      level = 2;
      exp = 0;
      await pool.query(
        `INSERT INTO user_room_stats (user_id, username, room, level, exp) VALUES ($1,$2,$3,$4,$5)`,
        [user.id, user.username, room, level, exp]
      );
    } else {
      level = statsRes.rows[0].level;
      exp = statsRes.rows[0].exp;
    }

    const now = new Date();
    const token = crypto.randomUUID();

    // 🔹 記憶體判斷是否已在線
    if (onlineUsers.has(username)) {
      const oldEntry = [...ioTokens.entries()].find(([t, data]) => data.username === username);
      if (oldEntry) {
        const [oldToken, { socketId }] = oldEntry;
        const socket = req.app.get("io").sockets.sockets.get(socketId);
        if (socket) {
          socket.emit("forceLogout", { reason: "你的帳號在其他地方登入" });
          socket.disconnect(true);
          console.log("帳號在其他地方登入", username);
        }
        ioTokens.delete(oldToken);
      }
      onlineUsers.delete(username);
    }

    if (!addUserIP(ip, username)) {
      return res.status(400).json({
        error: "同一 IP 最多只能登入 5 個帳號"
      });
    }

    onlineUsers.set(username, Date.now());
    ioTokens.set(token, { username, socketId: null, ip });

    await logLogin({ userId: user.id, username: user.username, loginType: "normal", ip, userAgent, success: true });

    res.json({
      token,
      name: user.username,
      level,
      exp,
      gender: user.gender,
      avatar: user.avatar,
      last_login: now,
      room
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "登入失敗" });
  }
});

/* ================= 登出 ================= */
authRouter.post("/logout", async (req, res) => {
  const ip = getClientIP(req);
  const userAgent = req.headers["user-agent"];
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "缺少 username" });
    // 移除 token
    for (const [token, data] of ioTokens.entries()) {
      if (data.username === username) ioTokens.delete(token);
    }
    onlineUsers.delete(username);
    removeUserIP(ip, username);
    await logLogin({ username, loginType: "logout", ip, userAgent, success: true });

    res.json({ success: true, message: `${username} 已登出` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "登出失敗" });
  }
});

// 修改資料
authRouter.post("/updateProfile", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    // 只允許已註冊帳號修改資料，訪客不可
    if (user.account_type !== "account") {
      return res.status(403).json({ error: "訪客無法修改資料" });
    }
    const { username, password, gender, avatar } = req.body;
    if (!username || isNicknameTooLong(username)) {
      return res.status(400).json({
        error: "暱稱最多 6 個中文字 或 12 個英數字",
      });
    }
    if (isNicknameTooShort(username)) {
      return res.status(400).json({
        error: "暱稱最少 3 個英數字 或 2 個中文字"
      });
    }
    if (!isValidNickname(username)) {
      return res.status(400).json({
        error: "暱稱只能包含中文、英文或數字，不能包含符號"
      });
    }
    // 如果有改密碼就 hash
    let hashedPassword = user.password; // 原本密碼
    if (password && password.trim() !== "") {
      hashedPassword = await bcrypt.hash(password, 10);
    }

    // 更新資料
    const updateRes = await pool.query(
      `UPDATE users 
       SET username = $1, password = $2, gender = $3, avatar = $4
       WHERE id = $5
       RETURNING id, username, gender, avatar, level, exp`,
      [
        username || user.username,
        hashedPassword,
        gender || user.gender,
        avatar || user.avatar,
        user.id,
      ]
    );

    res.json({ message: "修改成功", user: updateRes.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "修改資料失敗" });
  }
});
