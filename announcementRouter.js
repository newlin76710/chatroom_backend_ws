import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js";

const AML = process.env.ADMIN_MAX_LEVEL || 99;
export const announcementRouter = express.Router();

/* ===== 取得公告（所有人） ===== */
announcementRouter.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, content, updated_by, updated_at
       FROM announcements
       ORDER BY id ASC
       LIMIT 10`
    );
    // 如果沒有公告，回傳空陣列
    res.json(result.rows || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "載入公告失敗" });
  }
});

/* ===== 更新公告（Lv.99） ===== */
announcementRouter.post("/update", authMiddleware, async (req, res) => {
  try {
    const { id, title, content } = req.body; // 需要傳 id 指定要更新哪一則
    const { username, level } = req.user;

    if (level < AML) {
      return res.status(403).json({ error: "權限不足" });
    }

    // 驗證 id 是否存在
    const check = await pool.query(`SELECT id FROM announcements WHERE id=$1`, [id]);
    if (check.rowCount === 0) {
      return res.status(404).json({ error: "公告不存在" });
    }

    await pool.query(
      `UPDATE announcements
       SET title=$1, content=$2, updated_by=$3, updated_at=NOW()
       WHERE id=$4`,
      [title, content, username, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "更新公告失敗" });
  }
});

/* ===== 新增公告（Lv.99） ===== */
announcementRouter.post("/create", authMiddleware, async (req, res) => {
  try {
    const { title, content } = req.body;
    const { username, level } = req.user;

    if (level < AML) {
      return res.status(403).json({ error: "權限不足" });
    }

    // 檢查目前公告數量
    const countResult = await pool.query(`SELECT COUNT(*) FROM announcements`);
    const count = parseInt(countResult.rows[0].count);
    if (count >= 10) {
      return res.status(400).json({ error: "公告已達上限 10 則" });
    }

    const insert = await pool.query(
      `INSERT INTO announcements (title, content, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [title, content, username]
    );

    res.json({ success: true, id: insert.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "新增公告失敗" });
  }
});

/* ===== 刪除公告（Lv.99） ===== */
announcementRouter.post("/delete", authMiddleware, async (req, res) => {
  try {
    const { id } = req.body;
    const { level } = req.user;

    if (level < AML) return res.status(403).json({ error: "權限不足" });

    await pool.query(`DELETE FROM announcements WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "刪除公告失敗" });
  }
});
