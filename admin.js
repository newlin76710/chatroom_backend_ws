import express from "express";
import { pool } from "./db.js";
import { ADMIN_CONFIG } from "./config.js";

export const adminRouter = express.Router();

/* 權限檢查 middleware */
async function requireAdminLevel(req, res, next) {
  const { username } = req.body;
  if (!username) return res.status(401).json({ error: "no username" });

  const r = await pool.query(
    `SELECT level FROM users_ws WHERE username=$1`,
    [username]
  );

  if (!r.rowCount) {
    return res.status(401).json({ error: "user not found" });
  }

  if (r.rows[0].level < ADMIN_CONFIG.LOGIN_LOG_MIN_LEVEL) {
    return res.status(403).json({ error: "permission denied" });
  }

  req.adminLevel = r.rows[0].level;
  next();
}

/* 查登入紀錄 */
adminRouter.post("/login-logs", requireAdminLevel, async (req, res) => {
  const { limit = 200 } = req.body;

  const result = await pool.query(
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
    ORDER BY login_at DESC
    LIMIT $1
    `,
    [limit]
  );

  res.json(result.rows);
});
