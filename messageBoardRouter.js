import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js";

const AML = process.env.ADMIN_MAX_LEVEL || 99; // 版主等級門檻
export const messageBoardRouter = express.Router();

/* ===== 取得留言 ===== */
messageBoardRouter.get("/", authMiddleware, async (req, res) => {
  try {
    const { username, level } = req.user;
    const isAdmin = level >= AML;

    const result = await pool.query(
      `SELECT id, content, author_name, author_token, is_private, created_at
       FROM message_board
       ORDER BY created_at ASC`
    );

    // 過濾私密留言：只給版主或留言者本人
    const messages = result.rows.filter(msg => {
      if (!msg.is_private) return true;          // 公開留言
      if (isAdmin) return true;                  // 版主可見
      if (msg.author_name === username) return true; // 留言者本人可見
      return false;
    });

    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "載入留言失敗" });
  }
});

/* ===== 新增留言 ===== */
messageBoardRouter.post("/create", authMiddleware, async (req, res) => {
  try {
    const { content, isPrivate } = req.body;
    const { username, token } = req.user;

    if (!content || content.trim() === "") {
      return res.status(400).json({ error: "留言內容不可為空" });
    }

    const result = await pool.query(
      `INSERT INTO message_board (content, is_private, author_name, author_token, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id`,
      [content, !!isPrivate, username, token]
    );

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "新增留言失敗" });
  }
});

/* ===== 刪除留言（POST） ===== */
messageBoardRouter.post("/delete", authMiddleware, async (req, res) => {
  try {
    const { id } = req.body;
    const { username, token, level } = req.user;
    const isAdmin = level >= AML;

    // 先找留言
    const result = await pool.query(
      `SELECT * FROM message_board WHERE id=$1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "留言不存在" });
    }

    const message = result.rows[0];

    // 權限判斷：版主或留言者本人可刪
    if (!isAdmin && message.author_token !== token) {
      return res.status(403).json({ error: "無權限刪除此留言" });
    }

    await pool.query(`DELETE FROM message_board WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "刪除留言失敗" });
  }
});
