// transfer.js
import express from "express";
import { pool } from "./db.js";
import { authMiddleware } from "./auth.js";

export const transferRouter = express.Router();
const ROOM = process.env.ROOMNAME || "windsong";
const MAX_GOLD_APPLES = parseInt(process.env.MAX_GOLD_APPLES || "9999", 10);

transferRouter.post("/transfer-gold", authMiddleware, async (req, res) => {
    const client = await pool.connect();

    try {
        const sender = req.user;
        const { targetUsername, amount } = req.body;

        if (!sender) return res.status(401).json({ error: "未登入" });
        if (!targetUsername || typeof amount !== "number" || amount <= 0)
            return res.status(400).json({ error: "參數錯誤" });

        if (targetUsername === sender.username)
            return res.status(400).json({ error: "不能轉給自己" });

        await client.query("BEGIN");

        // 取得轉出者
        const senderRes = await client.query(
            `SELECT u.id AS user_id, urs.gold_apples
             FROM users u
             JOIN user_room_stats urs ON u.id = urs.user_id
             WHERE u.username = $1 AND urs.room = $2 FOR UPDATE`,
            [sender.username, ROOM]
        );

        if (!senderRes.rows.length)
            throw new Error("你在此聊天室不存在金蘋果");

        const senderStats = senderRes.rows[0];
        if (senderStats.gold_apples < amount)
            throw new Error("金蘋果不足");

        // 取得轉入者
        const targetRes = await client.query(
            `SELECT u.id AS user_id, urs.gold_apples
             FROM users u
             JOIN user_room_stats urs ON u.id = urs.user_id
             WHERE u.username = $1 AND urs.room = $2 FOR UPDATE`,
            [targetUsername, ROOM]
        );

        if (!targetRes.rows.length)
            throw new Error("目標使用者不存在");

        const targetStats = targetRes.rows[0];

        // 計算可轉移數量
        const actualTransfer = Math.min(amount, MAX_GOLD_APPLES - targetStats.gold_apples);
        if (actualTransfer <= 0)
            throw new Error("目標使用者金蘋果已達上限");

        // 更新轉出者
        await client.query(
            `UPDATE user_room_stats
             SET gold_apples = gold_apples - $1
             WHERE user_id = $2 AND room = $3`,
            [actualTransfer, senderStats.user_id, ROOM]
        );

        // 更新轉入者
        await client.query(
            `UPDATE user_room_stats
             SET gold_apples = gold_apples + $1
             WHERE user_id = $2 AND room = $3`,
            [actualTransfer, targetStats.user_id, ROOM]
        );

        // 🔹 系統訊息：轉移通知
        await client.query(
            `INSERT INTO message_logs
             (room, username, role, message, message_type, mode, target, created_at, ip)
             VALUES ($1, $2, 'system', $3, 'system', 'reward', $4, NOW(), '0.0.0.0')`,
            [
                ROOM,
                sender.username,
                `${sender.username} 已給 ${targetUsername} ${actualTransfer} 金蘋果 以示獎勵`,
                targetUsername
            ]
        );

        await client.query("COMMIT");

        res.json({ success: true, requested: amount, transferred: actualTransfer, to: targetUsername });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("金蘋果轉移失敗", err);
        res.status(400).json({ error: err.message || "操作失敗" });
    } finally {
        client.release();
    }
});