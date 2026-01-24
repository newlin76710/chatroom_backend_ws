// admin.js
import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js"; // 驗證 token 並填 req.user

export const adminRouter = express.Router();

/* ================= 登入紀錄 API (支援分頁) ================= */
adminRouter.post("/login-logs", authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 20 } = req.body;
    const user = req.user;

    // ⭐ 權限檢查
    if (!user || user.level < 99)
      return res.status(403).json({ error: "權限不足" });

    const offset = (page - 1) * pageSize;

    // 總筆數
    const totalRes = await pool.query(`SELECT COUNT(*) FROM login_logs`);
    const total = parseInt(totalRes.rows[0].count, 10);

    // 取得資料
    const logsRes = await pool.query(
      `SELECT id, username, login_type, ip_address, success, fail_reason, login_at
       FROM login_logs
       ORDER BY login_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );

    res.json({
      page,
      pageSize,
      total,
      logs: logsRes.rows.map(l => ({
        id: l.id,
        username: l.username,
        login_type: l.login_type,
        ip_address: l.ip_address,
        success: l.success,
        fail_reason: l.fail_reason,
        login_at: l.login_at,
      })),
    });
  } catch (err) {
    console.error("查詢登入紀錄失敗", err);
    res.status(500).json({ error: "查詢失敗" });
  }
});


/* ================= 發言紀錄 API (支援搜尋 / 分頁 / target) ================= */
adminRouter.post("/message-logs", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    // ⭐ 權限檢查
    if (!user || user.level < 99)
      return res.status(403).json({ error: "權限不足" });

    const {
      page = 1,
      pageSize = 50,
      room,
      username,
      keyword,
      role,
      mode,
      target  // <- 新增 target 搜尋條件
    } = req.body;

    const offset = (page - 1) * pageSize;

    // 動態條件
    const conditions = [];
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
      conditions.push(`target = $${i++}`); // <- 加入 target
      values.push(target);
    }

    if (keyword) {
      conditions.push(`message ILIKE $${i++}`);
      values.push(`%${keyword}%`);
    }

    const whereSql =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // ⭐ 總筆數
    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM message_logs ${whereSql}`,
      values
    );
    const total = parseInt(totalRes.rows[0].count, 10);

    // ⭐ 資料
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
      logs: dataRes.rows
    });
  } catch (err) {
    console.error("查詢發言紀錄失敗", err);
    res.status(500).json({ error: "查詢失敗" });
  }
});

/* ================= 等級管理：使用者清單（支援分頁 & 過濾訪客） ================= */
adminRouter.post("/user-levels", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    if (!user || user.level < 99)
      return res.status(403).json({ error: "權限不足" });

    let { keyword = "", page = 1, pageSize = 20 } = req.body;

    // 過濾非帳號（只要 account_type = 'account'）
    const values = [];
    let where = "WHERE account_type = 'account'";

    if (keyword) {
      where += " AND username ILIKE $1";
      values.push(`%${keyword}%`);
    }

    const offset = (page - 1) * pageSize;

    // 總筆數
    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM users_ws ${where}`,
      values
    );
    const total = parseInt(totalRes.rows[0].count, 10);

    // 取得資料（分頁）
    const dataRes = await pool.query(
      `
      SELECT id, username, level, created_at
      FROM users_ws
      ${where}
      ORDER BY level DESC, created_at ASC
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


/* ================= 等級管理：調整等級 ================= */
adminRouter.post("/set-user-level", authMiddleware, async (req, res) => {
  try {
    const admin = req.user;
    const { username, level } = req.body;

    if (!admin || admin.level < 99)
      return res.status(403).json({ error: "權限不足" });

    if (!username || typeof level !== "number")
      return res.status(400).json({ error: "參數錯誤" });

    // 不能調自己
    if (username === admin.username)
      return res.status(400).json({ error: "不能修改自己的等級" });

    // 查目標使用者
    const targetRes = await pool.query(
      `SELECT id, level FROM users_ws WHERE username=$1`,
      [username]
    );

    if (!targetRes.rows.length)
      return res.status(404).json({ error: "使用者不存在" });

    const target = targetRes.rows[0];

    // 不能調到 > 自己
    if (level > admin.level)
      return res.status(400).json({ error: "不能設定高於自己的等級" });

    await pool.query(
      `UPDATE users_ws SET level=$1 WHERE username=$2`,
      [level, username]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("調整使用者等級失敗", err);
    res.status(500).json({ error: "操作失敗" });
  }
});
