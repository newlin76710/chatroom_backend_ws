// admin.js
import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js"; // 驗證 token 並填 req.user
import { rescheduleGoldGames } from "./goldAppleGame.js";

export const adminRouter = express.Router();
const AML = process.env.ADMIN_MAX_LEVEL || 99;
const ROOM = process.env.ROOMNAME || 'windsong';
const MAX_GOLD_APPLES = parseInt(process.env.MAX_GOLD_APPLES || "9999", 10);
/* ================= 登入紀錄 API（支援分頁 / 日期） ================= */
adminRouter.post("/login-logs", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    if (!user || user.level < AML)
      return res.status(403).json({ error: "權限不足" });

    const {
      page = 1,
      pageSize = 20,
      from,
      to
    } = req.body;

    const offset = (page - 1) * pageSize;

    const conditions = [];
    const values = [];
    let i = 1;

    if (from) {
      conditions.push(`login_at >= $${i++}`);
      values.push(from);
    }

    if (to) {
      conditions.push(`login_at <= $${i++}`);
      values.push(to);
    }

    conditions.push(`room = $${i++}`);
    values.push(ROOM);

    const whereSql =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // 總筆數
    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM login_logs ${whereSql}`,
      values
    );
    const total = parseInt(totalRes.rows[0].count, 10);

    // 資料
    const logsRes = await pool.query(
      `
      SELECT
        id,
        username,
        login_type,
        ip_address,
        success,
        fail_reason,
        login_at
      FROM login_logs
      ${whereSql}
      ORDER BY login_at DESC
      LIMIT $${i++} OFFSET $${i++}
      `,
      [...values, pageSize, offset]
    );

    res.json({
      page,
      pageSize,
      total,
      logs: logsRes.rows,
    });
  } catch (err) {
    console.error("查詢登入紀錄失敗", err);
    res.status(500).json({ error: "查詢失敗" });
  }
});

/* ================= 使用者等級清單（分頁 / 搜尋 / 過濾訪客 + 最近登入） ================= */
adminRouter.post("/user-levels", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    if (!user || user.level < AML)
      return res.status(403).json({ error: "權限不足" });

    const {
      keyword = "",
      page = 1,
      pageSize = 20
    } = req.body;

    const values = [ROOM];
    let where = "WHERE s.room = $1";

    if (keyword) {
      where += ` AND u.username ILIKE $${values.length + 1}`;
      values.push(`%${keyword}%`);
    }

    const offset = (page - 1) * pageSize;

    // 🔹 總筆數
    const totalRes = await pool.query(
      `
      SELECT COUNT(*)
      FROM user_room_stats s
      JOIN users u ON s.user_id = u.id
      ${where}
      `,
      values
    );

    const total = parseInt(totalRes.rows[0].count, 10);

    // 🔹 使用者資料 + 最近登入
    const dataRes = await pool.query(
      `
      SELECT 
        u.id,
        u.username,
        s.level,
        s.exp,
        s.gold_apples,
        u.created_at,
        MAX(l.login_at) AS last_login_at
      FROM user_room_stats s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN login_logs l
        ON u.username = l.username
      ${where}
      GROUP BY u.id, s.level, s.exp, s.gold_apples
      ORDER BY s.level DESC, s.exp DESC, u.created_at ASC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `,
      [...values, pageSize, offset]
    );

    res.json({
      page,
      pageSize,
      total,
      users: dataRes.rows,
    });

  } catch (err) {
    console.error("查詢使用者等級失敗", err);
    res.status(500).json({ error: "查詢失敗" });
  }
});

/* ================= 調整使用者等級 ================= */
adminRouter.post("/set-user-level", authMiddleware, async (req, res) => {
  try {
    const admin = req.user;
    const { username, level, reason = "" } = req.body;

    if (!admin || admin.level < AML)
      return res.status(403).json({ error: "權限不足" });

    if (!username || typeof level !== "number")
      return res.status(400).json({ error: "參數錯誤" });

    if (username === admin.username)
      return res.status(400).json({ error: "不能修改自己的等級" });

    // 🔹 先找到 user_id 與舊等級
    const targetRes = await pool.query(
      `SELECT u.id, s.level AS old_level
       FROM users u
       JOIN user_room_stats s ON s.user_id = u.id AND s.room = $2
       WHERE u.username = $1`,
      [username, ROOM]
    );

    if (!targetRes.rows.length)
      return res.status(404).json({ error: "使用者不存在" });

    const { id: userId, old_level: oldLevel } = targetRes.rows[0];

    if (level > admin.level)
      return res.status(400).json({ error: "不能設定高於自己的等級" });

    // 🔥 更新指定 ROOM 的等級
    await pool.query(
      `UPDATE user_room_stats SET level = $1 WHERE user_id = $2 AND room = $3`,
      [level, userId, ROOM]
    );

    // 📝 記錄操作日誌
    await pool.query(
      `INSERT INTO admin_adjustment_logs
         (admin_username, target_username, adjustment_type, old_value, new_value, reason, room)
       VALUES ($1, $2, 'level', $3, $4, $5, $6)`,
      [admin.username, username, oldLevel, level, reason, ROOM]
    );

    res.json({ success: true });

  } catch (err) {
    console.error("調整使用者等級失敗", err);
    res.status(500).json({ error: "操作失敗" });
  }
});

/* ================= 調整使用者金蘋果 ================= */
adminRouter.post("/set-user-gold", authMiddleware, async (req, res) => {
  try {
    const admin = req.user;
    const { username, gold_apples, reason = "" } = req.body;

    if (!admin || admin.level < AML)
      return res.status(403).json({ error: "權限不足" });

    if (!username || typeof gold_apples !== "number" || !Number.isInteger(gold_apples) || gold_apples < 0)
      return res.status(400).json({ error: "參數錯誤：gold_apples 須為非負整數" });

    if (gold_apples > MAX_GOLD_APPLES)
      return res.status(400).json({ error: `金蘋果不能超過 ${MAX_GOLD_APPLES}` });

    // 🔹 先找到 user_id 與舊金蘋果數
    const targetRes = await pool.query(
      `SELECT u.id, s.gold_apples AS old_gold
       FROM users u
       JOIN user_room_stats s ON s.user_id = u.id AND s.room = $2
       WHERE u.username = $1`,
      [username, ROOM]
    );

    if (!targetRes.rows.length)
      return res.status(404).json({ error: "使用者不存在" });

    const { id: userId, old_gold: oldGold } = targetRes.rows[0];

    // 🔥 更新金蘋果
    await pool.query(
      `UPDATE user_room_stats SET gold_apples = $1 WHERE user_id = $2 AND room = $3`,
      [gold_apples, userId, ROOM]
    );

    // 📝 記錄操作日誌
    await pool.query(
      `INSERT INTO admin_adjustment_logs
         (admin_username, target_username, adjustment_type, old_value, new_value, reason, room)
       VALUES ($1, $2, 'gold_apples', $3, $4, $5, $6)`,
      [admin.username, username, oldGold, gold_apples, reason, ROOM]
    );

    res.json({ success: true });

  } catch (err) {
    console.error("調整使用者金蘋果失敗", err);
    res.status(500).json({ error: "操作失敗" });
  }
});

/* ================= 查詢管理員調整日誌 ================= */
adminRouter.post("/adjustment-logs", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.level < AML)
      return res.status(403).json({ error: "權限不足" });

    const {
      page = 1,
      pageSize = 50,
      admin_username,
      target_username,
      adjustment_type,
      from,
      to,
    } = req.body;

    const offset = (page - 1) * pageSize;
    const conditions = [`room = $1`];
    const values = [ROOM];
    let i = 2;

    if (admin_username) {
      conditions.push(`admin_username ILIKE $${i++}`);
      values.push(`%${admin_username}%`);
    }
    if (target_username) {
      conditions.push(`target_username ILIKE $${i++}`);
      values.push(`%${target_username}%`);
    }
    if (adjustment_type) {
      conditions.push(`adjustment_type = $${i++}`);
      values.push(adjustment_type);
    }
    if (from) {
      conditions.push(`created_at >= $${i++}`);
      values.push(from);
    }
    if (to) {
      conditions.push(`created_at <= $${i++}`);
      values.push(to);
    }

    const whereSql = `WHERE ${conditions.join(" AND ")}`;

    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM admin_adjustment_logs ${whereSql}`,
      values
    );
    const total = parseInt(totalRes.rows[0].count, 10);

    const dataRes = await pool.query(
      `SELECT id, admin_username, target_username, adjustment_type,
              old_value, new_value, reason, created_at
       FROM admin_adjustment_logs
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...values, pageSize, offset]
    );

    res.json({ page, pageSize, total, logs: dataRes.rows });
  } catch (err) {
    console.error("查詢調整日誌失敗", err);
    res.status(500).json({ error: "查詢失敗" });
  }
});

/* ================= 刪除使用者（僅刪除當前聊天室等級） ================= */
adminRouter.post("/delete-user", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    const admin = req.user;
    const { username, room } = req.body;

    if (!admin || admin.level < AML)
      return res.status(403).json({ error: "權限不足" });

    if (!username || !room)
      return res.status(400).json({ error: "缺少參數" });

    if (username === admin.username)
      return res.status(400).json({ error: "不能刪除自己" });

    await client.query("BEGIN");

    // 取得目標使用者該聊天室等級
    const targetRes = await client.query(
      `
      SELECT urs.level
      FROM user_room_stats urs
      JOIN users u ON u.id = urs.user_id
      WHERE u.username = $1
        AND urs.room = $2
      `,
      [username, room]
    );

    if (!targetRes.rows.length)
      throw new Error("使用者在此聊天室不存在");

    const target = targetRes.rows[0];

    if (target.level > admin.level)
      throw new Error("不能刪除等級更高的使用者");

    // 🔥 只刪除該聊天室資料
    await client.query(
      `
      DELETE FROM user_room_stats
      USING users
      WHERE user_room_stats.user_id = users.id
        AND users.username = $1
        AND user_room_stats.room = $2
      `,
      [username, room]
    );

    await client.query("COMMIT");

    res.json({ success: true });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("刪除聊天室等級失敗", err);
    res.status(400).json({ error: err.message || "刪除失敗" });
  } finally {
    client.release();
  }
});

/* ================= 發言紀錄 API（搜尋 / 分頁 / target / 可選日期 / 預設最近 2 天） ================= */
adminRouter.post("/message-logs", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    if (!user || user.level < AML)
      return res.status(403).json({ error: "權限不足" });

    const {
      page = 1,
      pageSize = 50,
      room,
      username,
      keyword,
      role,
      mode,
      target,
      from,
      to
    } = req.body;

    const offset = (page - 1) * pageSize;

    const conditions = [];
    const values = [];
    let i = 1;

    // 🔹 日期條件（沒選擇就預設最近 2 天）
    if (from) {
      conditions.push(`created_at >= $${i++}`);
      values.push(from);
    }
    if (to) {
      conditions.push(`created_at <= $${i++}`);
      values.push(to);
    }
    if (!from && !to) {
      conditions.push(`created_at >= NOW() - INTERVAL '2 days'`);
    }

    if (room) {
      conditions.push(`room = $${i++}`);
      values.push(room);
    }
    if (username) {
      conditions.push(`username = $${i++}`);
      values.push(username);
    }
    if (role) {
      conditions.push(`role = $${i++}`);
      values.push(role);
    }
    if (mode) {
      conditions.push(`mode = $${i++}`);
      values.push(mode);
    }
    if (target) {
      conditions.push(`target = $${i++}`);
      values.push(target);
    }
    if (keyword) {
      conditions.push(`message ILIKE $${i++}`);
      values.push(`%${keyword}%`);
    }

    conditions.push(`room = $${i++}`);
    values.push(ROOM);

    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // 總筆數
    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM message_logs ${whereSql}`,
      values
    );
    const total = parseInt(totalRes.rows[0].count, 10);

    // 資料
    const dataRes = await pool.query(
      `
      SELECT
        id,
        room,
        username,
        role,
        message,
        message_type,
        mode,
        target,
        ip,
        created_at
      FROM message_logs
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${i++} OFFSET $${i++}
      `,
      [...values, pageSize, offset]
    );

    res.json({ page, pageSize, total, logs: dataRes.rows });
  } catch (err) {
    console.error("查詢發言紀錄失敗", err);
    res.status(500).json({ error: "查詢失敗" });
  }
});

/* ================= 取得系統設定 ================= */
adminRouter.get("/settings", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.level < AML)
      return res.status(403).json({ error: "權限不足" });

    await pool.query(`
      INSERT INTO room_settings (room, daily_login_reward, daily_transfer_limit, singing_reward, per_transfer_limit)
      VALUES ($1, 1, 0, 2, 0)
      ON CONFLICT (room) DO NOTHING
    `, [ROOM]);

    const result = await pool.query(
      `SELECT daily_login_reward, singing_reward, per_transfer_limit, daily_transfer_limit,
              COALESCE(surprise_reward,     10)   AS surprise_reward,
              COALESCE(game1_enabled,       true) AS game1_enabled,
              COALESCE(game1_hour,          20)   AS game1_hour,
              COALESCE(game1_minute,        30)   AS game1_minute,
              COALESCE(game1_apple_count,   5)    AS game1_apple_count,
              COALESCE(game1_reward,        1)    AS game1_reward,
              COALESCE(game2_enabled,       true) AS game2_enabled,
              COALESCE(game2_hour,          20)   AS game2_hour,
              COALESCE(game2_minute,        35)   AS game2_minute,
              COALESCE(game2_reward,        25)   AS game2_reward
       FROM room_settings WHERE room = $1`,
      [ROOM]
    );

    res.json(result.rows[0] || {
      daily_login_reward: 1, singing_reward: 2, per_transfer_limit: 0,
      daily_transfer_limit: 0, surprise_reward: 10,
      game1_enabled: true, game1_hour: 20, game1_minute: 30,
      game1_apple_count: 5, game1_reward: 1,
      game2_enabled: true, game2_hour: 20, game2_minute: 35, game2_reward: 25,
    });
  } catch (err) {
    console.error("取得設定失敗", err);
    res.status(500).json({ error: "查詢失敗" });
  }
});

/* ================= 更新系統設定 ================= */
adminRouter.post("/set-settings", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.level < AML)
      return res.status(403).json({ error: "權限不足" });

    const {
      daily_login_reward, singing_reward, per_transfer_limit,
      daily_transfer_limit, surprise_reward,
      game1_enabled, game1_hour, game1_minute, game1_apple_count, game1_reward,
      game2_enabled, game2_hour, game2_minute, game2_reward,
    } = req.body;

    // 整數欄位驗證
    const intFields = {
      daily_login_reward, singing_reward, per_transfer_limit,
      daily_transfer_limit, surprise_reward,
      game1_hour, game1_minute, game1_apple_count, game1_reward,
      game2_hour, game2_minute, game2_reward,
    };
    for (const [key, val] of Object.entries(intFields)) {
      if (val !== undefined && (!Number.isInteger(val) || val < 0))
        return res.status(400).json({ error: `${key} 必須為非負整數` });
    }

    // 小時/分鐘範圍
    if (game1_hour !== undefined && (game1_hour < 0 || game1_hour > 23))
      return res.status(400).json({ error: 'game1_hour 必須為 0-23' });
    if (game1_minute !== undefined && (game1_minute < 0 || game1_minute > 59))
      return res.status(400).json({ error: 'game1_minute 必須為 0-59' });
    if (game2_hour !== undefined && (game2_hour < 0 || game2_hour > 23))
      return res.status(400).json({ error: 'game2_hour 必須為 0-23' });
    if (game2_minute !== undefined && (game2_minute < 0 || game2_minute > 59))
      return res.status(400).json({ error: 'game2_minute 必須為 0-59' });

    const allFields = {
      ...intFields,
      game1_enabled: game1_enabled !== undefined ? Boolean(game1_enabled) : undefined,
      game2_enabled: game2_enabled !== undefined ? Boolean(game2_enabled) : undefined,
    };

    if (Object.values(allFields).every(v => v === undefined))
      return res.status(400).json({ error: "沒有要更新的設定" });

    await pool.query(`
      INSERT INTO room_settings (room, daily_login_reward, daily_transfer_limit, singing_reward, per_transfer_limit)
      VALUES ($1, 1, 0, 2, 0)
      ON CONFLICT (room) DO NOTHING
    `, [ROOM]);

    const updates = [];
    const values = [];
    let i = 1;

    const colMap = {
      daily_login_reward, singing_reward, per_transfer_limit,
      daily_transfer_limit, surprise_reward,
      game1_enabled, game1_hour, game1_minute, game1_apple_count, game1_reward,
      game2_enabled, game2_hour, game2_minute, game2_reward,
    };

    for (const [col, val] of Object.entries(colMap)) {
      if (val !== undefined) {
        updates.push(`${col} = $${i++}`);
        values.push(val);
      }
    }

    values.push(ROOM);
    await pool.query(
      `UPDATE room_settings SET ${updates.join(', ')} WHERE room = $${i}`,
      values
    );

    // 若遊戲時間相關設定有變更，重新排程
    const gameFields = [
      'game1_enabled', 'game1_hour', 'game1_minute', 'game1_apple_count', 'game1_reward',
      'game2_enabled', 'game2_hour', 'game2_minute', 'game2_reward',
    ];
    if (gameFields.some(f => colMap[f] !== undefined)) {
      rescheduleGoldGames();
    }

    res.json({ success: true });
  } catch (err) {
    console.error("更新設定失敗", err);
    res.status(500).json({ error: "操作失敗" });
  }
});

/* ================= 樂透金蘋果紀錄（所有登入用戶可查） ================= */
adminRouter.get("/surprise-history", authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "未登入" });

    const page     = Math.max(1, parseInt(req.query.page     || "1",  10));
    const pageSize = Math.min(50, parseInt(req.query.pageSize || "20", 10));
    const offset   = (page - 1) * pageSize;

    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM surprise_gold_logs WHERE room = $1 AND triggered_at IS NOT NULL`,
      [ROOM]
    );
    const total = parseInt(totalRes.rows[0].count, 10);

    const dataRes = await pool.query(
      `SELECT id, scheduled_time, winner, amount, triggered_at
       FROM surprise_gold_logs
       WHERE room = $1 AND triggered_at IS NOT NULL
       ORDER BY scheduled_time DESC
       LIMIT $2 OFFSET $3`,
      [ROOM, pageSize, offset]
    );

    res.json({ total, page, pageSize, logs: dataRes.rows });
  } catch (err) {
    console.error("查詢樂透紀錄失敗", err);
    res.status(500).json({ error: "查詢失敗" });
  }
});

/* ================= 建立 admin_adjustment_logs 表（若不存在） ================= */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_adjustment_logs (
        id              SERIAL PRIMARY KEY,
        admin_username  VARCHAR NOT NULL,
        target_username VARCHAR NOT NULL,
        adjustment_type VARCHAR NOT NULL,
        old_value       INT,
        new_value       INT NOT NULL,
        reason          VARCHAR DEFAULT '',
        room            VARCHAR NOT NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.error('建立 admin_adjustment_logs 表失敗', err);
  }
})();

/* ================= 使用者查自己的發言（可選日期 / 預設最近 2 天） ================= */
adminRouter.post("/my-message-logs", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: "未登入" });

    const { page = 1, pageSize = 50, keyword, room, from, to } = req.body;
    const offset = (page - 1) * pageSize;

    const conditions = [`(username = $1 OR target = $1)`];
    const values = [user.username];
    let i = 2;

    // 🔹 日期條件
    if (from) {
      conditions.push(`created_at >= $${i++}`);
      values.push(from);
    }
    if (to) {
      conditions.push(`created_at <= $${i++}`);
      values.push(to);
    }
    if (!from && !to) {
      conditions.push(`created_at >= NOW() - INTERVAL '2 days'`);
    }

    if (keyword) {
      conditions.push(`message ILIKE $${i++}`);
      values.push(`%${keyword}%`);
    }

    conditions.push(`room = $${i++}`);
    values.push(ROOM);

    const whereSql = `WHERE ${conditions.join(" AND ")}`;

    // 總筆數
    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM message_logs ${whereSql}`,
      values
    );
    const total = parseInt(totalRes.rows[0].count, 10);

    // 資料
    const dataRes = await pool.query(
      `
      SELECT
        id,
        room,
        username,
        role,
        message,
        message_type,
        mode,
        target,
        created_at
      FROM message_logs
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${i++} OFFSET $${i++}
      `,
      [...values, pageSize, offset]
    );

    res.json({ page, pageSize, total, logs: dataRes.rows });
  } catch (err) {
    console.error("查詢自己的發言失敗", err);
    res.status(500).json({ error: "查詢失敗" });
  }
});

