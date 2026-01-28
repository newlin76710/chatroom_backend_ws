import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js"; // 你原本的

export const announcementRouter = express.Router();

/* ===== 取得公告（所有人） ===== */
announcementRouter.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT content, updated_by, updated_at
       FROM announcements
       ORDER BY id DESC
       LIMIT 1`
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "載入公告失敗" });
  }
});

/* ===== 更新公告（Lv.99） ===== */
announcementRouter.post("/update", authMiddleware, async (req, res) => {
  try {
    const { content } = req.body;
    const { username, level } = req.user;

    if (level < 99) {
      return res.status(403).json({ error: "權限不足" });
    }

    await pool.query(
      `UPDATE announcements
       SET content=$1, updated_by=$2, updated_at=NOW()
       WHERE id=1`,
      [content, username]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "更新公告失敗" });
  }
});
