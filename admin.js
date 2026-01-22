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
        message AS content,   -- 方便前端 l.content
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

