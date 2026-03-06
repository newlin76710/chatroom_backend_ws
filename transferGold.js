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
            console.log("[transfer-gold] sender =", sender); // 🔹 這裡 log 出來
            const { targetUsername, amount } = req.body;
            // 🔹 強制轉成數字
            amount = Number(amount);
            if (!sender) return res.status(401).json({ error: "未登入" });
            if (!targetUsername || isNaN(amount) || amount <= 0)
                return res.status(400).json({ error: "參數錯誤" });

            if (targetUsername === sender.username)
                return res.status(400).json({ error: "不能轉給自己" });

            await client.query("BEGIN");

            const senderRes = await client.query(
                `SELECT u.id AS user_id, urs.gold_apples
         FROM users u
         JOIN user_room_stats urs ON u.id = urs.user_id
         WHERE u.username = $1 AND urs.room = $2 FOR UPDATE`,
                [sender.username, ROOM]
            );
            if (!senderRes.rows.length) throw new Error("你在此聊天室不存在金蘋果");

            const senderStats = senderRes.rows[0];
            if (senderStats.gold_apples < amount) throw new Error("金蘋果不足");

            const targetRes = await client.query(
                `SELECT u.id AS user_id, urs.gold_apples
         FROM users u
         JOIN user_room_stats urs ON u.id = urs.user_id
         WHERE u.username = $1 AND urs.room = $2 FOR UPDATE`,
                [targetUsername, ROOM]
            );
            if (!targetRes.rows.length) throw new Error("目標使用者不存在");

            const targetStats = targetRes.rows[0];
            const actualTransfer = Math.min(amount, MAX_GOLD_APPLES - targetStats.gold_apples);
            if (actualTransfer <= 0) throw new Error("目標使用者金蘋果已達上限");

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

            // 存入資料庫
            await client.query(
                `INSERT INTO message_logs
         (room, username, role, message, message_type, mode, target, created_at, ip)
         VALUES ($1, $2, 'system', $3, 'system', 'reward', $4, NOW(), '0.0.0.0')`,
                [ROOM, sender.username, systemMessage, targetUsername]
            );

            await client.query("COMMIT");

            // 🔹 廣播給聊天室
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

            res.json({ success: true, requested: amount, transferred: actualTransfer, to: targetUsername });
        } catch (err) {
            await client.query("ROLLBACK");
            console.error("金蘋果轉移失敗", err);
            res.status(400).json({ error: err.message || "操作失敗" });
        } finally {
            client.release();
        }
    });

    return router;
};