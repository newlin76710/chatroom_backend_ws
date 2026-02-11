import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "./db.js";
import { logLogin } from "./loginLogger.js";

export const authRouter = express.Router();
export const ioTokens = new Map();

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
      `SELECT 1 FROM blocked_ips WHERE ip=$1 LIMIT 1`,
      [ip]
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
      LIMIT 1
      `,
      [username]
    );

    return result.rowCount > 0;

  } catch (err) {

    console.error("暱稱檢查失敗:", err);

    // ⭐ 失敗不要擋登入
    return false;
  }
}

/* ================= 驗證 Middleware ================= */
export const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers["authorization"]?.split(" ")[1] || req.body.token;
    if (!token) return res.status(401).json({ error: "No token provided" });

    const result = await pool.query(
      `SELECT id, username, level, exp, gender, avatar, account_type 
       FROM users WHERE login_token=$1`,
      [token]
    );

    if (!result.rowCount) return res.status(401).json({ error: "Invalid token" });

    req.user = result.rows[0];
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
    if (await isNicknameBlocked(username)) {
      await logLogin({
        username: username,
        loginType: "guest",
        ip,
        userAgent,
        success: false,
        failReason: "暱稱黑名單",
      });

      return res.status(403).json({
        error: "此暱稱不可使用"
      });
    }

    const safeGender = gender === "男" ? "男" : "女";
    const baseName = username?.trim() ? `訪客_${username.trim()}` : "訪客" + Math.floor(Math.random() * 10000);
    let guestName = baseName;

    const accountExists = await pool.query(
      `SELECT 1 FROM users WHERE username=$1 AND account_type='account'`,
      [username]
    );
    if (accountExists.rows.length) return res.status(400).json({ error: "暱稱已有人使用" });

    const existsOnline = await pool.query(
      `SELECT 1 FROM users WHERE username=$1 AND is_online = true AND last_seen > NOW() - INTERVAL '30 seconds'`,
      [guestName]
    );

    if (existsOnline.rows.length) {
      return res.status(400).json({ error: "暱稱已有人使用" });
    }


    const now = new Date();
    const guestToken = crypto.randomUUID();
    const randomPassword = crypto.randomBytes(8).toString("hex");

    const result = await pool.query(
      `INSERT INTO users
       (username, password, gender, last_login, account_type, level, exp, is_online, login_token)
       VALUES ($1,$2,$3,$4,'guest',1,0,true,$5)
       ON CONFLICT (username) DO UPDATE SET
         last_login=EXCLUDED.last_login,
         is_online=true,
         login_token=EXCLUDED.login_token,
         gender = EXCLUDED.gender
       RETURNING id, username, gender, level, exp`,
      [guestName, randomPassword, safeGender, now, guestToken]
    );

    const guest = result.rows[0];
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
    const { username, password, gender, phone, email, avatar } = req.body;
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
      `INSERT INTO users (username, password, gender, phone, email, avatar, level, exp)
       VALUES ($1, $2, $3, $4, $5, $6, 2, 0)
       RETURNING id, username, gender, avatar, level, exp`,
      [username, hash, gender === "男" ? "男" : "女", phone || null, email || null, avatar || null]
    );

    res.json({ message: "註冊成功", user: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "註冊失敗" });
  }
});

/* ================= 正式登入 ================= */
authRouter.post("/login", async (req, res) => {
  const ip = getClientIP(req);
  const userAgent = req.headers["user-agent"];
  const { username, password } = req.body;
  try {
    // IP 黑名單檢查
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

    const result = await pool.query(
      `SELECT id, username, password, level, exp, avatar, gender, is_online, login_token
       FROM users WHERE username=$1`,
      [username]
    );
    if (!result.rowCount) return res.status(400).json({ error: "帳號不存在" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "密碼錯誤" });

    const now = new Date();
    const token = crypto.randomUUID();

    if (user.is_online && user.login_token) {
      const oldToken = user.login_token;
      if (ioTokens.has(oldToken)) {
        const socketId = ioTokens.get(oldToken);
        const socket = req.app.get("io").sockets.sockets.get(socketId);
        if (socket) socket.emit("forceLogout", { reason: "你的帳號在其他地方登入" });
        ioTokens.delete(oldToken);
      }
      await pool.query(`UPDATE users SET is_online=false, login_token=NULL WHERE id=$1`, [user.id]);
    }

    await pool.query(`UPDATE users SET last_login=$1, login_token=$2, is_online=true WHERE id=$3`, [now, token, user.id]);

    await logLogin({ userId: user.id, username: user.username, loginType: "normal", ip, userAgent, success: true });

    res.json({ token, name: user.username, level: user.level, exp: user.exp, gender: user.gender, avatar: user.avatar, last_login: now });
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

    await pool.query(`UPDATE users SET is_online=false, login_token=NULL WHERE username=$1`, [username]);
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
