import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "./db.js";

export const authRouter = express.Router();
export const ioTokens = new Map();
// 訪客登入
authRouter.post("/guest", async (req, res) => {
  const { gender, username } = req.body;

  let guestName = "";
  if (username?.trim()) {
    // 有輸入暱稱 → 變成 "訪客_暱稱"
    guestName = "訪客_" + username.trim();
  } else {
    // 沒輸入暱稱 → 自動生成
    guestName = "訪客" + Math.floor(Math.random() * 9999);
  }

  // 防止重複
  const existing = await pool.query(`SELECT 1 FROM users_ws WHERE username=$1`, [guestName]);
  if (existing.rows.length) {
    // 加個隨機數字避免重複
    guestName += Math.floor(Math.random() * 9999);
  }

  // 建立訪客資料（或生成 token）
  const guestToken = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users_ws (username, gender, login_token, account_type) VALUES ($1, $2, $3, 'guest')`,
    [guestName, gender, guestToken]
  );

  res.json({ guestToken, name: guestName, gender, last_login: new Date().toISOString() });
});

// 註冊
authRouter.post("/register", async (req, res) => {
  try {
    const { username, password, gender, phone, email, avatar } = req.body;
    if (!username || !password) return res.status(400).json({ error: "缺少帳號或密碼" });

    const exist = await pool.query(`SELECT id FROM users_ws WHERE username = $1`, [username]);
    if (exist.rowCount > 0) return res.status(400).json({ error: "帳號已存在" });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users_ws (username, password, gender, phone, email, avatar, level, exp)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 0)
       RETURNING id, username, gender, avatar, level, exp`,
      [username, hash, gender === "男" ? "男" : "女", phone || null, email || null, avatar || null]
    );

    res.json({ message: "註冊成功", user: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "註冊失敗" });
  }
});

// 登入
// 登入
authRouter.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "缺少帳號或密碼" });
    }

    const result = await pool.query(
      `SELECT id, username, password, level, exp, avatar, gender, is_online, login_token
       FROM users_ws WHERE username=$1`,
      [username]
    );

    if (result.rowCount === 0) return res.status(400).json({ error: "帳號不存在" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "密碼錯誤" });

    const now = new Date();
    const token = crypto.randomUUID(); // 新登入 token

    // --- 1️⃣ 踢掉前登入 ---
    if (user.is_online && user.login_token) {
      const oldToken = user.login_token;
      if (ioTokens.has(oldToken)) {
        const oldSocketId = ioTokens.get(oldToken);
        const oldSocket = req.app.get("io").sockets.sockets.get(oldSocketId);
        if (oldSocket) {
          oldSocket.emit("forceLogout", { reason: "你的帳號在其他地方登入" });
          oldSocket.disconnect(true);
        }
        ioTokens.delete(oldToken);
      }

      // 資料庫也把舊 token 清掉
      await pool.query(
        `UPDATE users_ws SET is_online=false, login_token=NULL WHERE id=$1`,
        [user.id]
      );
    }

    // --- 2️⃣ 更新新登入 ---
    await pool.query(
      `UPDATE users_ws
       SET last_login=$1, login_token=$2, is_online=true
       WHERE id=$3`,
      [now, token, user.id]
    );

    // --- 3️⃣ 回傳給前端 ---
    res.json({
      token,
      name: user.username,
      level: user.level,
      exp: user.exp,
      gender: user.gender,
      avatar: user.avatar,
      last_login: now
    });

    // ⚠️ 注意：前端拿到 token 後，要建立 socket 連線時，把 token 對應 socket.id
    // 例如：
    // ioTokens.set(token, socket.id);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "登入失敗" });
  }
});

authRouter.post("/logout", async (req, res) => {
  const { token } = req.body;

  await pool.query(
    `UPDATE users_ws
     SET is_online=false,
         login_token=NULL
     WHERE login_token=$1`,
    [token]
  );

  res.json({ message: "已登出" });
});