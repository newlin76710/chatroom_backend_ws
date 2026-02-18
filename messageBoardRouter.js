import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js";

const AML = process.env.ADMIN_MAX_LEVEL || 99; // 版主等級門檻
export const messageBoardRouter = express.Router();

messageBoardRouter.get("/", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, content, author_name, author_token, is_private, reply_content, created_at
       FROM message_board
       ORDER BY created_at ASC`
    );

    // 全部送前端，不過保留 is_private 欄位
    res.json(result.rows);
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

    await pool.query(`DELETE FROM message_board WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "刪除留言失敗" });
  }
});


/* ===== 回覆留言（管理員專用） ===== */
messageBoardRouter.post("/reply", authMiddleware, async (req, res) => {
  try {
    const { id, reply } = req.body;
    const { username, level } = req.user;

    if (!id || !reply || reply.trim() === "") {
      return res.status(400).json({ error: "參數錯誤或回覆內容不可空白" });
    }

    if (level < AML) {
      return res.status(403).json({ error: "權限不足，只有管理員可回覆" });
    }

    // 先確認留言存在
    const result = await pool.query(
      `SELECT * FROM message_board WHERE id=$1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "留言不存在" });
    }

    // 更新回覆欄位
    await pool.query(
      `UPDATE message_board
       SET reply_content = $1
       WHERE id = $2`,
      [reply, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("回覆留言失敗", err);
    res.status(500).json({ error: "回覆留言失敗" });
  }
});
