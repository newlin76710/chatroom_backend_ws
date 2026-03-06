// transferGold.js
import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js";

export const createTransferRouter = (io) => {
  const router = express.Router();
  const ROOM = process.env.ROOMNAME || "windsong";
  const MAX_GOLD_APPLES = parseInt(process.env.MAX_GOLD_APPLES || "9999", 10);

  router.post("/transfer-gold", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
      const sender = req.user;
      //console.log("[transfer-gold] sender =", sender);

      let { targetUsername, amount } = req.body;
      amount = Number(amount);

      if (!sender) return res.status(401).json({ error: "未登入" });
      if (!targetUsername || isNaN(amount) || amount <= 0)
        return res.status(400).json({ error: "參數錯誤" });

      if (targetUsername === sender.username)
        return res.status(400).json({ error: "不能轉給自己" });

      await client.query("BEGIN");

      // 查 sender
      const senderRes = await client.query(
        `SELECT u.id AS user_id, urs.gold_apples
         FROM users u
         JOIN user_room_stats urs ON u.id = urs.user_id
         WHERE u.username = $1 AND urs.room = $2 FOR UPDATE`,
        [sender.username, ROOM]
      );
      if (!senderRes.rows.length) {
        await client.query("ROLLBACK");
        return res.json({ success: false, transferred: 0, reason: "你在此聊天室不存在金蘋果" });
      }

      const senderStats = senderRes.rows[0];
      if (senderStats.gold_apples <= 0) {
        await client.query("ROLLBACK");
        return res.json({ success: false, transferred: 0, reason: "你的金蘋果不足" });
      }

      // 查 target
      const targetRes = await client.query(
        `SELECT u.id AS user_id, urs.gold_apples
         FROM users u
         JOIN user_room_stats urs ON u.id = urs.user_id
         WHERE u.username = $1 AND urs.room = $2 FOR UPDATE`,
        [targetUsername, ROOM]
      );
      if (!targetRes.rows.length) {
        await client.query("ROLLBACK");
        return res.json({ success: false, transferred: 0, reason: "目標使用者不存在" });
      }

      const targetStats = targetRes.rows[0];
      const actualTransfer = Math.min(amount, senderStats.gold_apples, MAX_GOLD_APPLES - targetStats.gold_apples);

      if (actualTransfer <= 0) {
        await client.query("ROLLBACK");
        return res.json({ success: false, transferred: 0, reason: "目標使用者金蘋果已達上限或你沒有足夠蘋果" });
      }

      // 更新金蘋果
      await client.query(
        `UPDATE user_room_stats SET gold_apples = gold_apples - $1 WHERE user_id = $2 AND room = $3`,
        [actualTransfer, senderStats.user_id, ROOM]
      );
      await client.query(
        `UPDATE user_room_stats SET gold_apples = gold_apples + $1 WHERE user_id = $2 AND room = $3`,
        [actualTransfer, targetStats.user_id, ROOM]
      );

      const systemMessage = `${sender.username} 已給 ${targetUsername} ${actualTransfer} 金蘋果 以示獎勵`;

      await client.query(
        `INSERT INTO message_logs
         (room, username, role, message, message_type, mode, target, created_at, ip)
         VALUES ($1, $2, 'system', $3, 'system', 'reward', $4, NOW(), '0.0.0.0')`,
        [ROOM, sender.username, systemMessage, targetUsername]
      );

      await client.query("COMMIT");

      io.to(ROOM).emit("transferMessage", {
        room: ROOM,
        username: sender.username,
        role: "system",
        message: systemMessage,
        message_type: "system",
        mode: "reward",
        amount: actualTransfer,
        target: targetUsername,
        created_at: new Date(),
      });

      return res.json({ success: true, requested: amount, transferred: actualTransfer, to: targetUsername });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("金蘋果轉移失敗", err);
      return res.json({ success: false, transferred: 0, reason: err.message || "操作失敗" });
    } finally {
      client.release();
    }
  });

  return router;
};