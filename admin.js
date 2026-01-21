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
