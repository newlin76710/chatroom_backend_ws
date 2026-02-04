import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js";

export const quickPhrasesRouter = express.Router();

/* =================== 取得使用者的常用語 =================== */
quickPhrasesRouter.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT id, content, sort_order 
       FROM quick_phrase 
       WHERE user_id = $1 
       ORDER BY sort_order ASC
       LIMIT 10`,
      [userId]
    );
    res.json({ phrases: result.rows });
  } catch (err) {
    console.error("get quick phrases error:", err);
    res.status(500).json({ error: "取得常用語失敗" });
  }
});

/* =================== 新增常用語 =================== */
quickPhrasesRouter.post("/new", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: "內容不可為空" });

    // 先檢查是否超過 10 個
    const countRes = await pool.query(`SELECT COUNT(*) FROM quick_phrase WHERE user_id=$1`, [userId]);
    if (parseInt(countRes.rows[0].count) >= 20) {
      return res.status(400).json({ error: "最多只能新增 20 個常用語" });
    }

    const sortRes = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM quick_phrase WHERE user_id=$1`, [userId]);
    const nextOrder = sortRes.rows[0].next_order;

    const insertRes = await pool.query(
      `INSERT INTO quick_phrase (user_id, content, sort_order)
       VALUES ($1, $2, $3)
       RETURNING id, content, sort_order`,
      [userId, content.trim(), nextOrder]
    );

    res.json({ phrase: insertRes.rows[0] });
  } catch (err) {
    console.error("create quick phrase error:", err);
    res.status(500).json({ error: "新增常用語失敗" });
  }
});

/* =================== 更新常用語內容 =================== */
quickPhrasesRouter.post("/update", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id, content } = req.body;
    if (!id || !content || !content.trim()) return res.status(400).json({ error: "缺少 id 或內容" });

    const updateRes = await pool.query(
      `UPDATE quick_phrase 
       SET content=$1, updated_at=NOW() 
       WHERE id=$2 AND user_id=$3
       RETURNING id, content, sort_order`,
      [content.trim(), id, userId]
    );

    if (!updateRes.rowCount) return res.status(404).json({ error: "找不到此常用語" });

    res.json({ phrase: updateRes.rows[0] });
  } catch (err) {
    console.error("update quick phrase error:", err);
    res.status(500).json({ error: "更新常用語失敗" });
  }
});

/* =================== 刪除常用語 =================== */
quickPhrasesRouter.post("/delete", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "缺少 id" });

    const delRes = await pool.query(
      `DELETE FROM quick_phrase WHERE id=$1 AND user_id=$2 RETURNING id`,
      [id, userId]
    );

    if (!delRes.rowCount) return res.status(404).json({ error: "找不到此常用語" });

    res.json({ success: true, id });
  } catch (err) {
    console.error("delete quick phrase error:", err);
    res.status(500).json({ error: "刪除常用語失敗" });
  }
});

