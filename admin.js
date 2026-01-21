// admin.js
import express from "express";
import { pool } from "./db.js"; // 你的 PostgreSQL 連線
import { authMiddleware } from "./auth.js"; // 驗證 token 並填 req.user

export const adminRouter = express.Router();

// 設定最低等級可以看登入紀錄
const MIN_LEVEL_VIEW_LOGIN_LOG = 99;

// 取得登入紀錄（支援分頁）
adminRouter.get("/login-logs", authMiddleware, async (req, res) => {
  try {
    // 權限檢查
    if (!req.user || req.user.level < MIN_LEVEL_VIEW_LOGIN_LOG) {
      return res.status(403).json({ error: "權限不足" });
    }

    // 解析 query
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    // 先查總數
    const totalResult = await pool.query(`SELECT COUNT(*) FROM login_logs`);
    const total = parseInt(totalResult.rows[0].count, 10);

    // 查資料
    const result = await pool.query(
      `
      SELECT username, ip, success, created_at
      FROM login_logs
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    res.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data: result.rows,
    });
  } catch (err) {
    console.error("取得登入紀錄失敗", err);
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// 後端紀錄登入 API 範例（可在登入成功/失敗時呼叫）
adminRouter.post("/login-log", async (req, res) => {
  try {
    const { username, ip, success } = req.body;

    if (!username || !ip || typeof success !== "boolean") {
      return res.status(400).json({ error: "參數錯誤" });
    }

    await pool.query(
      `INSERT INTO login_logs (username, ip, success, created_at) VALUES ($1, $2, $3, NOW())`,
      [username, ip, success]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("紀錄登入失敗", err);
    res.status(500).json({ error: "伺服器錯誤" });
  }
});
