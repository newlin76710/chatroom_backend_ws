import express from "express";
import { pool } from "./db.js";

export const nicknameRouter = express.Router();
const AML = process.env.ADMIN_MIN_LEVEL || 91;
/**
 * middleware — 限制 91~99
 * 假設 req.user 已經被 authMiddleware 注入
 */
const adminOnly = (req, res, next) => {
  const level = req.user?.level;

  if (level < AML) {
    return res.status(403).json({
      error: "權限不足",
    });
  }

  next();
};


/**
 * 取得所有黑名單
 */
nicknameRouter.get("/", adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM blocked_nicknames
      ORDER BY created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "無法取得暱稱黑名單",
    });
  }
});


/**
 * 新增黑名單
 */
nicknameRouter.post("/block", adminOnly, async (req, res) => {
  try {
    const { nickname, reason } = req.body;

    if (!nickname?.trim()) {
      return res.status(400).json({
        error: "暱稱必填",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO blocked_nicknames (nickname, reason)
      VALUES ($1, $2)

      ON CONFLICT (nickname)
      DO UPDATE
      SET
        reason = EXCLUDED.reason,
        created_at = NOW()

      RETURNING *
      `,
      [nickname.trim(), reason || null]
    );

    res.json({
      success: true,
      blocked: result.rows[0],
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "封鎖失敗",
    });
  }
});


/**
 * 解除封鎖
 */
nicknameRouter.post("/unblock", adminOnly, async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        error: "ID 必填",
      });
    }

    await pool.query(
      `DELETE FROM blocked_nicknames WHERE id=$1`,
      [id]
    );

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "解除封鎖失敗",
    });
  }
});
