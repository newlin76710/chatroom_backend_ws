import express from "express";
import { pool } from "./db.js";

export const ipRouter = express.Router();

// 取得所有被封鎖 IP
ipRouter.get("/", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM blocked_ips ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "無法取得封鎖 IP 列表" });
  }
});

// 新增封鎖 IP
ipRouter.post("/block", async (req, res) => {
  try {
    const { ip, reason } = req.body;
    if (!ip) return res.status(400).json({ error: "IP 必填" });

    const result = await pool.query(
      `INSERT INTO blocked_ips (ip, reason) VALUES ($1, $2)
       ON CONFLICT (ip) DO UPDATE SET reason = EXCLUDED.reason, created_at = NOW()
       RETURNING *`,
      [ip, reason || null]
    );

    res.json({ success: true, blocked: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "封鎖失敗" });
  }
});

// 移除封鎖 IP
ipRouter.post("/unblock", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "ID 必填" });

    await pool.query(`DELETE FROM blocked_ips WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "解除封鎖失敗" });
  }
});
