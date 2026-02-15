// admin.js
import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js"; // 驗證 token 並填 req.user

export const adminRouter = express.Router();
const AML = process.env.ADMIN_MAX_LEVEL || 99;

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

/* ================= 發言紀錄 API（搜尋 / 分頁 / target / 最近 2 天） ================= */
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
      target
    } = req.body;

    const offset = (page - 1) * pageSize;

    const conditions = [`created_at >= NOW() - INTERVAL '2 days'`]; // 🔹 最近 2 天
    const values = [];
    let i = 1;

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

    const whereSql = `WHERE ${conditions.join(" AND ")}`;

    // 🔹 使用 username/target 索引快速計算總筆數
    let total = 0;
    if (username) {
      const totalRes = await pool.query(
        `SELECT SUM(cnt) AS total FROM (
            SELECT COUNT(*) AS cnt FROM message_logs WHERE username=$1 AND created_at >= NOW() - INTERVAL '2 days'
            UNION ALL
            SELECT COUNT(*) AS cnt FROM message_logs WHERE target=$1 AND created_at >= NOW() - INTERVAL '2 days'
        ) t`,
        [username]
      );
      total = parseInt(totalRes.rows[0].total, 10) || 0;
    } else {
      // 無 username 時就算整體條件的筆數
      const totalRes = await pool.query(
        `SELECT COUNT(*) FROM message_logs ${whereSql}`,
        values
      );
      total = parseInt(totalRes.rows[0].count, 10);
    }

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

    res.json({
      page,
      pageSize,
      total,
      logs: dataRes.rows,
    });
  } catch (err) {
    console.error("查詢發言紀錄失敗", err);
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

    const values = [];
    let where = "WHERE u.account_type = 'account'";

    if (keyword) {
      where += " AND u.username ILIKE $1";
      values.push(`%${keyword}%`);
    }

    const offset = (page - 1) * pageSize;

    // 總筆數
    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM users u ${where}`,
      values
    );
    const total = parseInt(totalRes.rows[0].count, 10);

    // 使用者資料 + 最近登入
    const dataRes = await pool.query(
      `
      SELECT 
        u.id,
        u.username,
        u.level,
        u.created_at,
        MAX(l.login_at) AS last_login_at
      FROM users u
      LEFT JOIN login_logs l
        ON u.username = l.username
      ${where}
      GROUP BY u.id
      ORDER BY u.level DESC, u.created_at ASC
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

    const targetRes = await pool.query(
      `SELECT id, level FROM users WHERE username = $1`,
      [username]
    );

    if (!targetRes.rows.length)
      return res.status(404).json({ error: "使用者不存在" });

    if (level > admin.level)
      return res.status(400).json({ error: "不能設定高於自己的等級" });

    await pool.query(
      `UPDATE users SET level = $1 WHERE username = $2`,
      [level, username]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("調整使用者等級失敗", err);
    res.status(500).json({ error: "操作失敗" });
  }
});

/* ================= 刪除使用者（硬刪除） ================= */
adminRouter.post("/delete-user", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const admin = req.user;
    const { username } = req.body;

    if (!admin || admin.level < AML)
      return res.status(403).json({ error: "權限不足" });

    if (!username)
      return res.status(400).json({ error: "缺少 username" });

    if (username === admin.username)
      return res.status(400).json({ error: "不能刪除自己" });

    await client.query("BEGIN");

    // 先確認目標使用者存在 & 等級
    const targetRes = await client.query(
      `SELECT id, level FROM users WHERE username = $1`,
      [username]
    );

    if (!targetRes.rows.length)
      throw new Error("使用者不存在");

    const target = targetRes.rows[0];

    if (target.level > admin.level)
      throw new Error("不能刪除等級更高的使用者");

    // 🔥 刪除 users
    await client.query(
      `DELETE FROM users WHERE username = $1`,
      [username]
    );

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("刪除使用者失敗", err);
    res.status(400).json({ error: err.message || "刪除失敗" });
  } finally {
    client.release();
  }
});

/* ================= 會員查自己的發言（只算最近 2 天） ================= */
adminRouter.post("/my-message-logs", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    if (!user)
      return res.status(401).json({ error: "未登入" });

    const {
      page = 1,
      pageSize = 50,
      keyword,
      room
    } = req.body;

    const offset = (page - 1) * pageSize;

    const conditions = [`(username = $1 OR target = $1)`];
    const values = [user.username];
    let i = 2;

    // 限制最近 2 天
    conditions.push(`created_at >= NOW() - INTERVAL '2 days'`);

    if (room) {
      conditions.push(`room = $${i++}`);
      values.push(room);
    }

    if (keyword) {
      conditions.push(`message ILIKE $${i++}`);
      values.push(`%${keyword}%`);
    }

    const whereSql = `WHERE ${conditions.join(" AND ")}`;

    // 🔹 使用索引快速計算總筆數（username/target）
    const totalRes = await pool.query(
      `SELECT SUM(cnt) AS total FROM (
          SELECT COUNT(*) AS cnt FROM message_logs WHERE username=$1 AND created_at >= NOW() - INTERVAL '2 days'
          UNION ALL
          SELECT COUNT(*) AS cnt FROM message_logs WHERE target=$1 AND created_at >= NOW() - INTERVAL '2 days'
      ) t`,
      [user.username]
    );

    const total = parseInt(totalRes.rows[0].total, 10) || 0;

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

    res.json({
      page,
      pageSize,
      total,
      logs: dataRes.rows,
    });

  } catch (err) {
    console.error("查詢自己的發言失敗", err);
    res.status(500).json({ error: "查詢失敗" });
  }
});
