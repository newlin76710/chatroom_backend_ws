import express from "express";
import { authMiddleware } from "./auth.js";
import { pool } from "./db.js";

export const adminRouter = express.Router();

/* ================= 登入紀錄 API (支援分頁) ================= */
adminRouter.post("/login-logs", authMiddleware, async (req, res) => {
  try {
    const { username, page = 1, pageSize = 20 } = req.body;

    // 只有等級達門檻可查看
    if (!req.user || req.user.level < 99)
      return res.status(403).json({ error: "權限不足" });

    const offset = (page - 1) * pageSize;

    const logs = await pool.query(
      `SELECT * FROM login_logs 
       ORDER BY login_at DESC 
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );

    res.json({
      page,
      pageSize,
      logs: logs.rows.map(l => ({
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
