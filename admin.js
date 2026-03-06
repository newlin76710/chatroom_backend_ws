// admin.js
import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js"; // 驗證 token 並填 req.user

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
        s.gold_apples AS "goldApples",
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
    const { username, level } = req.body;

    if (!admin || admin.level < AML)
      return res.status(403).json({ error: "權限不足" });

    if (!username || typeof level !== "number")
      return res.status(400).json({ error: "參數錯誤" });

    if (username === admin.username)
      return res.status(400).json({ error: "不能修改自己的等級" });

    // 🔹 先找到 user_id
    const targetRes = await pool.query(
      `SELECT id FROM users WHERE username = $1`,
      [username]
    );

    if (!targetRes.rows.length)
      return res.status(404).json({ error: "使用者不存在" });

    const userId = targetRes.rows[0].id;

    if (level > admin.level)
      return res.status(400).json({ error: "不能設定高於自己的等級" });

    // 🔥 更新指定 ROOM 的等級
    await pool.query(
      `
      UPDATE user_room_stats
      SET level = $1
      WHERE user_id = $2 AND room = $3
      `,
      [level, userId, ROOM]
    );

    res.json({ success: true });

  } catch (err) {
    console.error("調整使用者等級失敗", err);
    res.status(500).json({ error: "操作失敗" });
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

/* ================= 設定使用者金蘋果數量（直接指定） ================= */
adminRouter.post("/set-gold-apples", authMiddleware, async (req, res) => {
  try {
    const admin = req.user;
    const { username, count } = req.body; // count 直接是要設的數量

    if (!admin || admin.level < AML)
      return res.status(403).json({ error: "權限不足" });

    if (!username || typeof count !== "number")
      return res.status(400).json({ error: "參數錯誤" });

    // 🔹 限制範圍
    const newAmount = Math.max(0, Math.min(MAX_GOLD_APPLES, count));

    // 🔹 找到目標使用者
    const targetRes = await pool.query(
      `SELECT u.id AS user_id FROM users u
       JOIN user_room_stats urs ON u.id = urs.user_id
       WHERE u.username = $1 AND urs.room = $2`,
      [username, ROOM]
    );

    if (!targetRes.rows.length)
      return res.status(404).json({ error: "使用者不存在或未加入聊天室" });

    const targetId = targetRes.rows[0].id;

    // 🔹 更新金蘋果數量
    await pool.query(
      `UPDATE user_room_stats
       SET gold_apples = $1
       WHERE user_id = $2 AND room = $3`,
      [newAmount, targetId, ROOM]
    );

    res.json({
      success: true,
      message: `已將 ${username} 的金蘋果設為 ${newAmount}`
    });

  } catch (err) {
    console.error("設定使用者金蘋果失敗", err);
    res.status(500).json({ error: "操作失敗" });
  }
});
