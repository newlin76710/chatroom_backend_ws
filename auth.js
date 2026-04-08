import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { pool } from "./db.js";
import { logLogin } from "./loginLogger.js";
import { onlineUsers } from "./chat.js";
import { addUserIP, removeUserIP } from "./ip.js";

const ROOM = process.env.ROOMNAME || 'windsong';
const GUEST = process.env.OPENGUEST === "true";

// 取得台灣今天日期 YYYY-MM-DD（模組層級，避免每次 request 重新定義）
function getTaiwanToday() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const taiwanTime = new Date(utc + 8 * 3600000);
  return taiwanTime.toISOString().slice(0, 10);
}

// 速率限制器（用 CF/Proxy header 取真實 IP，與既有 getClientIP 邏輯一致）
function _getRealIP(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress
  );
}
const _loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: _getRealIP,
  message: { error: "登入嘗試次數過多，請 15 分鐘後再試" },
  standardHeaders: true,
  legacyHeaders: false,
});
const _registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: _getRealIP,
  message: { error: "註冊次數過多，請稍後再試" },
  standardHeaders: true,
  legacyHeaders: false,
});

async function getDailyLoginReward(room) {
  try {
    const result = await pool.query(
      `SELECT daily_login_reward FROM room_settings WHERE room = $1`,
      [room]
    );
    if (result.rows.length) return result.rows[0].daily_login_reward;
  } catch (e) {}
  return 1;
}
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
      `SELECT id, username, gender, avatar, account_type, birthday, phone_confirm, email_confirm
       FROM users
       WHERE username=$1`,
      [username]
    );
    if (!userRes.rowCount) return res.status(401).json({ error: "Invalid token" });

    const user = userRes.rows[0];

    // 再抓 user_room_stats 該 room 的等級/經驗
    const statsRes = await pool.query(
      `SELECT level, exp, gold_apples
       FROM user_room_stats
       WHERE user_id=$1 AND room=$2`,
      [user.id, room]
    );

    const stats = statsRes.rowCount ? statsRes.rows[0] : { level: 1, exp: 0, gold_apples: 0 };

    req.user = {
      ...user,
      level: stats.level,
      exp: stats.exp,
      gold_apples: stats.gold_apples,
      room
    };

    next();
  } catch (err) {
    console.error("authMiddleware error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

// GET /me - 取得自己資料
authRouter.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    // 回傳給前端的資料
    res.json({
      id: user.id,
      username: user.username,
      gender: user.gender,
      avatar: user.avatar,
      account_type: user.account_type,
      birthday: user.birthday,
      phone_confirm: user.phone_confirm,
      email_confirm: user.email_confirm,
      level: user.level,
      exp: user.exp,
      gold_apples: user.gold_apples,
      room: user.room,
    });
  } catch (err) {
    console.error("GET /me error:", err);
    res.status(500).json({ error: "取得使用者資料失敗" });
  }
});

/* ================= 訪客登入 ================= */
authRouter.post("/guest", _loginLimiter, async (req, res) => {
  const ip = getClientIP(req);
  const userAgent = req.headers["user-agent"];
  const { gender, username } = req.body;

  try {
    if (!GUEST) {
      return res.status(400).json({
        error: "此聊天室已關閉訪客登入",
      });
    }
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
authRouter.post("/register", _registerLimiter, async (req, res) => {
  try {
    const ip = getClientIP(req);
    const { username, password, gender, phone, email, avatar, birthday } = req.body;
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
    // 轉換空字串
    const phoneValue = phone?.trim() || null;
    const emailValue = email?.trim() || null;
    const birthdayValue = birthday?.trim() || null;

    const phoneRegex = /^[0-9]{8,11}$/;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const birthdayRegex = /^\d{4}-\d{2}-\d{2}$/;

    // 有填才驗證
    if (phoneValue && !phoneRegex.test(phoneValue)) {
      return res.status(400).json({ error: "手機格式錯誤" });
    }

    if (emailValue && !emailRegex.test(emailValue)) {
      return res.status(400).json({ error: "Email 格式錯誤" });
    }

    if (birthdayValue && !birthdayRegex.test(birthdayValue)) {
      return res.status(400).json({ error: "生日格式錯誤，請使用 YYYY-MM-DD" });
    }

    const exist = await pool.query(`SELECT id FROM users WHERE username = $1`, [username]);
    if (exist.rowCount > 0) return res.status(400).json({ error: "帳號已存在" });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users
       (username, password, gender, phone, email, avatar, birthday, level, exp, register_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 2, 0, $8)
       RETURNING id, username, gender, avatar, birthday, level, exp`,
      [
        username,
        hash,
        gender === "男" ? "男" : "女",
        phoneValue,
        emailValue,
        avatar || null,
        birthdayValue,
        ip || null
      ]
    );

    res.json({ message: "註冊成功", user: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "註冊失敗" });
  }
});

/* ================= 正式登入（記憶體版） ================= */
authRouter.post("/login", _loginLimiter, async (req, res) => {
  const ip = getClientIP(req);
  const userAgent = req.headers["user-agent"];
  const { username, password, allowProfileIncomplete } = req.body;

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
      `SELECT id, username, password, password_type, avatar, gender, phone, email, birthday, phone_confirm, email_confirm
       FROM users WHERE username=$1`,
      [username]
    );

    if (!result.rowCount) return res.status(400).json({ error: "帳號不存在" });

    const user = result.rows[0];

    // ── 密碼驗證：支援 md5（舊帳號）與 bcrypt（新帳號） ──
    const pwType = user.password_type || 'bcrypt';
    let match = false;
    if (pwType === 'md5') {
      const inputMd5 = crypto.createHash('md5').update(password).digest('hex');
      match = inputMd5 === user.password;
      if (match) {
        // 第一次登入成功，自動升級為 bcrypt
        const newHash = await bcrypt.hash(password, 10);
        await pool.query(
          `UPDATE users SET password = $1, password_type = 'bcrypt' WHERE id = $2`,
          [newHash, user.id]
        );
      }
    } else {
      match = await bcrypt.compare(password, user.password);
    }
    if (!match) return res.status(400).json({ error: "密碼錯誤" });

    // // ===== 檢查手機與 Email 是否填寫 =====
    // if (!allowProfileIncomplete && (!user.phone || !user.email)) {
    //   return res.status(403).json({
    //     error: "請先至修改資料中補齊手機與 Email 資料",
    //     requireProfileUpdate: true
    //   });
    // }

    // ====== 處理聊天室等級/經驗 ======
    const room = ROOM; // 或者 req.body.room
    let statsRes = await pool.query(
      `SELECT level, exp, gold_apples, last_login_reward 
   FROM user_room_stats 
   WHERE user_id=$1 AND room=$2`,
      [user.id, room]
    );

    let level, exp, gold_apples;
    const today = getTaiwanToday();

    let rewardApple = 0;
    const dailyReward = await getDailyLoginReward(room);

    if (!statsRes.rowCount) {
      // 首次進入房間
      // 用 ON CONFLICT DO NOTHING 防止並發雙重登入造成 duplicate key
      level = 2;
      exp = 0;
      gold_apples = dailyReward;
      rewardApple = dailyReward;

      const insertRes = await pool.query(
        `INSERT INTO user_room_stats
     (user_id, username, room, level, exp, gold_apples, last_login_reward)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT ON CONSTRAINT ux_user_room DO NOTHING`,
        [user.id, user.username, room, level, exp, gold_apples, today]
      );

      if (insertRes.rowCount === 0) {
        // 並發請求已由另一個請求建立，重新讀取實際資料
        const retryRes = await pool.query(
          `SELECT level, exp, gold_apples FROM user_room_stats WHERE user_id=$1 AND room=$2`,
          [user.id, room]
        );
        if (retryRes.rowCount) {
          level      = retryRes.rows[0].level;
          exp        = retryRes.rows[0].exp;
          gold_apples = retryRes.rows[0].gold_apples || 0;
          rewardApple = 0; // 另一個請求已給過登入獎勵
        }
      } else if (dailyReward > 0) {
        // 確實是第一次插入才寫 gift_logs
        await pool.query(
          `INSERT INTO gift_logs
   (room, sender, receiver, receiver_id, item_type, amount, created_at)
   VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [room, 'system', user.username, user.id, 'gold_apples', dailyReward]
        );
      }
    } else {
      const stats = statsRes.rows[0];
      level = stats.level;
      exp = stats.exp;
      gold_apples = stats.gold_apples || 0;

      // 將資料庫時間轉 YYYY-MM-DD 字串比較
      const lastReward = stats.last_login_reward
        ? stats.last_login_reward.toISOString().slice(0, 10)
        : null;

      if (lastReward !== today) {
        rewardApple = dailyReward;
        gold_apples += dailyReward;

        await pool.query(`
  UPDATE user_room_stats
  SET gold_apples = gold_apples + $1,
      last_login_reward = $2
  WHERE user_id = $3 AND room = $4
`, [dailyReward, today, user.id, room]);
        // 🔹 新增 gift_logs 記錄
        if (dailyReward > 0) {
          await pool.query(
            `INSERT INTO gift_logs
   (room, sender, receiver, receiver_id, item_type, amount, created_at)
   VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [room, 'system', user.username, user.id, 'gold_apples', dailyReward]
          );
        }
      }
    }

    console.log("[Debug] 最後結果 -> name:", username, "level:", level, "exp:", exp, "gold_apples:", gold_apples, "rewardApple:", rewardApple);

    const now = new Date();
    const token = crypto.randomUUID();

    if (!addUserIP(ip, username)) {
      return res.status(400).json({
        error: "同一 IP 最多只能登入 5 個帳號"
      });
    }

    onlineUsers.set(username, Date.now());
    // ⭐ 清掉同 username 的舊 token（避免殘留）
    for (const [oldToken, data] of ioTokens.entries()) {
      if (data.username === username) {
        ioTokens.delete(oldToken);
      }
    }
    ioTokens.set(token, { username, socketId: null, ip });

    await logLogin({ userId: user.id, username: user.username, loginType: "normal", ip, userAgent, success: true });

    res.json({
      token,
      name: user.username,
      level,
      exp,
      gold_apples,
      gender: user.gender,
      avatar: user.avatar,
      birthday: user.birthday,
      phone: user.phone,
      email: user.email,
      phone_confirm: user.phone_confirm,
      email_confirm: user.email_confirm,
      last_login: now,
      room,
      reward_apple: rewardApple
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "登入失敗" });
  }
});

authRouter.post("/logout", async (req, res) => {
  const ip = getClientIP(req);
  const userAgent = req.headers["user-agent"];
  try {
    // ✅ 從 header 拿 token（標準做法）
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      return res.status(400).json({ error: "缺少 token" });
    }
    const data = ioTokens.get(token);
    if (!data) {
      return res.status(200).json({ success: true, message: "token 已失效" });
    }
    const { username } = data;
    // ✅ 只刪「這個 token」
    ioTokens.delete(token);
    // ⚠️ 只有當「沒有其他 token」時才真的離線
    const stillOnline = [...ioTokens.values()].some(
      (u) => u.username === username
    );
    if (!stillOnline) {
      onlineUsers.delete(username);
      removeUserIP(ip, username);
    }
    await logLogin({
      username,
      loginType: "logout",
      ip,
      userAgent,
      success: true,
    });
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
    const { username, password, gender, avatar, phone, email, birthday } = req.body;
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
    // if (!phone || !email) {
    //   return res.status(400).json({ error: "手機與 Email 為必填" });
    // }
    const phoneRegex = /^[0-9]{8,11}$/;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const birthdayRegex = /^\d{4}-\d{2}-\d{2}$/;

    // 手機有填才驗證
    if (phone && !phoneRegex.test(phone)) {
      return res.status(400).json({ error: "手機格式錯誤" });
    }

    // email 有填才驗證
    if (email && !emailRegex.test(email)) {
      return res.status(400).json({ error: "Email 格式錯誤" });
    }

    // 生日有填才驗證
    const birthdayValue = birthday?.trim() || null;
    if (birthdayValue && !birthdayRegex.test(birthdayValue)) {
      return res.status(400).json({ error: "生日格式錯誤，請使用 YYYY-MM-DD" });
    }

    // 如果有改密碼就 hash（並統一升級為 bcrypt）
    let hashedPassword = undefined;
    if (password && password.trim() !== "") {
      hashedPassword = await bcrypt.hash(password, 10);
    }

    // 取得舊的手機/email 以判斷是否有變更
    const oldDataRes = await pool.query(
      `SELECT phone, email FROM users WHERE id = $1`,
      [user.id]
    );
    const oldData = oldDataRes.rows[0] || {};
    const newPhone = phone?.trim() || null;
    const newEmail = email?.trim() || null;

    // 手機或 email 有變更則重置對應 confirm 狀態
    const phoneChanged = newPhone !== (oldData.phone || null);
    const emailChanged = newEmail !== (oldData.email || null);

    // 密碼有變更才加入 SET；順便把 password_type 升為 bcrypt
    const pwSetClause = hashedPassword ? `, password = $10, password_type = 'bcrypt'` : "";
    const baseParams = [
      username || user.username,
      gender || user.gender,
      avatar || user.avatar,
      newPhone,
      newEmail,
      birthdayValue,
      phoneChanged,
      emailChanged,
      user.id,
    ];

    const updateRes = await pool.query(
      `UPDATE users
       SET username = $1, gender = $2, avatar = $3, phone = $4, email = $5,
           birthday = $6,
           phone_confirm = CASE WHEN $7 THEN false ELSE phone_confirm END,
           email_confirm = CASE WHEN $8 THEN false ELSE email_confirm END
           ${pwSetClause}
       WHERE id = $9
       RETURNING id, username, gender, avatar, birthday, phone_confirm, email_confirm`,
      hashedPassword ? [...baseParams, hashedPassword] : baseParams
    );

    // 同步更新 user_room_stats 的 username，避免舊名稱殘留造成之後新用戶登入衝突
    const newUsername = updateRes.rows[0]?.username;
    if (newUsername) {
      await pool.query(
        `UPDATE user_room_stats SET username = $1 WHERE user_id = $2`,
        [newUsername, user.id]
      );
    }

    res.json({ message: "修改成功", user: updateRes.rows[0] });

  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "使用者名稱已存在" });
    }
    console.error("更新使用者失敗", err);
    res.status(500).json({ error: "操作失敗" });
  }
});

// 忘記密碼
authRouter.post("/forgotPassword", async (req, res) => {
  try {
    const { username, phone, email } = req.body;

    if (!username || !phone || !email) {
      return res.status(400).json({ error: "帳號、手機與 Email 為必填" });
    }

    // 驗證格式
    const phoneRegex = /^[0-9]{8,11}$/;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!phoneRegex.test(phone)) return res.status(400).json({ error: "手機格式錯誤" });
    if (!emailRegex.test(email)) return res.status(400).json({ error: "Email 格式錯誤" });

    // 查詢使用者
    const userRes = await pool.query(
      `SELECT id, username FROM users 
       WHERE username=$1 AND phone=$2 AND email=$3 AND account_type='account'`,
      [username, phone, email]
    );

    if (!userRes.rowCount) {
      return res.status(404).json({ error: "找不到對應的帳號資料" });
    }

    const user = userRes.rows[0];

    // 生成新密碼
    const newPassword = crypto.randomBytes(6).toString("hex"); // 12位隨機密碼
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // 更新資料庫（同時升級為 bcrypt）
    await pool.query(
      `UPDATE users SET password=$1, password_type='bcrypt' WHERE id=$2`,
      [hashedPassword, user.id]
    );

    // 回傳給使用者（測試用，真實上線建議 Email/SMS）
    res.json({
      message: "密碼已重置成功",
      username: user.username,
      newPassword,
    });

  } catch (err) {
    console.error("密碼重置失敗:", err);
    res.status(500).json({ error: "密碼重置失敗" });
  }
});