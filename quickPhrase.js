import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js";

export const quickPhraseRouter = express.Router();

/* ================= 取得常用語 ================= */
quickPhraseRouter.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT id, content, sort_order
       FROM quick_phrase
       WHERE user_id = $1
       ORDER BY sort_order, id`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("get quick phrases error:", err);
    res.status(500).json({ error: "取得常用語失敗" });
  }
});

/* ================= 新增（最多 10） ================= */
quickPhraseRouter.post("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: "content 不可為空" });
    }

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM quick_phrase
       WHERE user_id = $1`,
      [userId]
    );

    if (countRes.rows[0].count >= 10) {
      return res.status(400).json({ error: "最多只能設定 10 個常用語" });
    }

    const insertRes = await pool.query(
      `INSERT INTO quick_phrase (user_id, content, sort_order)
       VALUES (
         $1,
         $2,
         COALESCE(
           (SELECT MAX(sort_order) FROM quick_phrase WHERE user_id = $1),
           0
         ) + 1
       )
       RETURNING id, content, sort_order`,
      [userId, content.trim()]
    );

    res.json(insertRes.rows[0]);
  } catch (err) {
    console.error("add quick phrase error:", err);
    res.status(500).json({ error: "新增常用語失敗" });
  }
});

/* ================= 修改 ================= */
quickPhraseRouter.put("/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: "content 不可為空" });
    }

    const result = await pool.query(
      `UPDATE quick_phrase
       SET content = $1, updated_at = now()
       WHERE id = $2 AND user_id = $3
       RETURNING id, content, sort_order`,
      [content.trim(), id, userId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "常用語不存在" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("update quick phrase error:", err);
    res.status(500).json({ error: "修改常用語失敗" });
  }
});

/* ================= 刪除 ================= */
quickPhraseRouter.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    await pool.query(
      `DELETE FROM quick_phrase
       WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("delete quick phrase error:", err);
    res.status(500).json({ error: "刪除常用語失敗" });
  }
});

/* ================= 重新排序（拖曳用） ================= */
/*
body example:
[
  { "id": 3, "sort_order": 1 },
  { "id": 5, "sort_order": 2 }
]
*/
quickPhraseRouter.put("/reorder", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const list = req.body;

  if (!Array.isArray(list)) {
    return res.status(400).json({ error: "格式錯誤" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const item of list) {
      await client.query(
        `UPDATE quick_phrase
         SET sort_order = $1
         WHERE id = $2 AND user_id = $3`,
        [item.sort_order, item.id, userId]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("reorder quick phrase error:", err);
    res.status(500).json({ error: "排序失敗" });
  } finally {
    client.release();
  }
});
