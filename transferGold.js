// transferGold.js
import express from "express";
import { pool } from "./db.js";
import { rooms } from "./chat.js";
import { authMiddleware } from "./auth.js";

export const createTransferRouter = (io) => {
    const router = express.Router();
    const ROOM = process.env.ROOMNAME || "windsong";
    const MAX_GOLD_APPLES = parseInt(process.env.MAX_GOLD_APPLES || "999999999", 10);
    const AML = process.env.ADMIN_MAX_LEVEL || 99;
    const ANL = process.env.ADMIN_MIN_LEVEL || 91;
    router.post("/transfer-gold", authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const sender = req.user;

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
            // 🔹 廣播給聊天室所有人
            if (io) {
                // 🔹 更新聊天室金蘋果
                const senderMem = rooms[ROOM].find(u => u.name === sender.username);
                const targetMem = rooms[ROOM].find(u => u.name === targetUsername);

                if (senderMem) senderMem.gold_apples -= actualTransfer;
                if (targetMem) targetMem.gold_apples += actualTransfer;

                // 廣播整個 user list
                io.to(ROOM).emit("updateUsers", rooms[ROOM]);
            }
            return res.json({ success: true, requested: amount, transferred: actualTransfer, to: targetUsername });
        } catch (err) {
            await client.query("ROLLBACK");
            console.error("金蘋果轉移失敗", err);
            return res.json({ success: false, transferred: 0, reason: err.message || "操作失敗" });
        } finally {
            client.release();
        }
    });
    /* ================= 設定使用者金蘋果數量（直接指定） ================= */
    router.post("/set-gold-apples", authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const admin = req.user;
            const { username, count } = req.body; // count 直接是要設的數量

            if (!admin || admin.level < AML)
                return res.status(403).json({ error: "權限不足" });

            if (!username || typeof count !== "number")
                return res.status(400).json({ error: "參數錯誤" });

            const newAmount = Math.max(0, Math.min(MAX_GOLD_APPLES, count));

            await client.query("BEGIN");

            // 🔹 找到目標使用者
            const targetRes = await client.query(
                `SELECT u.id AS user_id, urs.gold_apples
       FROM users u
       JOIN user_room_stats urs ON u.id = urs.user_id
       WHERE u.username = $1 AND urs.room = $2 FOR UPDATE`,
                [username, ROOM]
            );

            if (!targetRes.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ error: "使用者不存在或未加入聊天室" });
            }

            const targetId = targetRes.rows[0].user_id;

            // 🔹 更新金蘋果數量
            await client.query(
                `UPDATE user_room_stats
       SET gold_apples = $1
       WHERE user_id = $2 AND room = $3`,
                [newAmount, targetId, ROOM]
            );

            // 🔹 廣播給聊天室所有人
            if (io) {
                const userMem = rooms[ROOM].find(u => u.name === username);
                if (userMem) userMem.gold_apples = newAmount;
                // 廣播整個 user list
                io.to(ROOM).emit("updateUsers", rooms[ROOM]);
            }

            await client.query("COMMIT");

            res.json({
                success: true,
                message: `已將 ${username} 的金蘋果設為 ${newAmount}`,
                username,
                gold_apples: newAmount
            });

        } catch (err) {
            await client.query("ROLLBACK");
            console.error("設定使用者金蘋果失敗", err);
            res.status(500).json({ error: "操作失敗" });
        } finally {
            client.release();
        }
    });

    /* ================= 金蘋果排行榜 ================= */
    router.get("/gold-apple-leaderboard", authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const TOP_N = parseInt(req.query.top || "30", 10); // 可透過 query ?top=10 調整

            // 查該聊天室所有使用者金蘋果數量，排除管理員
            const leaderboardRes = await client.query(
                `SELECT u.username, urs.gold_apples, urs.level
             FROM users u
             JOIN user_room_stats urs ON u.id = urs.user_id
             WHERE urs.room = $1
               AND urs.level < $2
             ORDER BY urs.gold_apples DESC, u.username ASC
             LIMIT $3`,
                [ROOM, ANL, TOP_N]
            );

            res.json({
                success: true,
                leaderboard: leaderboardRes.rows, // [{ username, gold_apples, level }, ...]
            });
        } catch (err) {
            console.error("查詢金蘋果排行榜失敗", err);
            res.status(500).json({ success: false, error: "查詢失敗" });
        } finally {
            client.release();
        }
    });
    const SHOP_ITEMS = {
        // rose: { name: "🌹 玫瑰", price: 15, type: "gift" },
        // firework: { name: "🎆 煙火", price: 50, type: "gift" },
        // crown: { name: "👑 皇冠", price: 200, type: "gift" },
        rename: { name: "✏️ 升級卡", price: 1000, type: "levelUp" },
    };
    router.post("/shop/buy", authMiddleware, async (req, res) => {
        const { itemId } = req.body;
        const buyer = req.user;
        const item = SHOP_ITEMS[itemId];

        if (!item) return res.status(400).json({ error: "商品暫不開放" });

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            // 查使用者金蘋果和等級
            const userRes = await client.query(
                "SELECT id AS user_id, gold_apples, level FROM user_room_stats WHERE user_id = $1 AND room = $2 FOR UPDATE",
                [buyer.id, ROOM]
            );

            if (!userRes.rows.length) {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "你在此聊天室不存在金蘋果" });
            }

            const userStats = userRes.rows[0];
            if (userStats.gold_apples < item.price) {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "金蘋果不足" });
            }

            let newLevel = userStats.level;
            // 升級卡
            if (item.type === "levelUp") {
                const MAX_LEVEL = ANL - 1; 
                if (userStats.level >= MAX_LEVEL) {
                    await client.query("ROLLBACK");
                    return res.status(400).json({ error: `已達最高等級 Lv.${MAX_LEVEL}` });
                }
                newLevel = newLevel + 1;
            }

            // 扣金蘋果 & 更新等級（如果是升級卡）
            await client.query(
                "UPDATE user_room_stats SET gold_apples = gold_apples - $1, level = $2 WHERE user_id = $3 AND room = $4",
                [item.price, newLevel, buyer.id, ROOM]
            );

            // 更新 rooms 緩存
            const mem = rooms[ROOM]?.find(u => u.name === buyer.username);
            if (mem) {
                mem.gold_apples -= item.price;
                if (item.type === "levelUp") mem.level = newLevel;
            }

            // 廣播聊天室訊息
            if (io) {
                let systemMsg = "";
                if (item.type === "levelUp") {
                    systemMsg = `${buyer.username} 使用升級卡，等級提升到 Lv.${newLevel}`;
                } else {
                    systemMsg = `${buyer.username} 使用 ${item.name}`;
                }
                io.to(ROOM).emit("systemMessage", systemMsg);
                io.to(ROOM).emit("updateUsers", rooms[ROOM]);
            }

            await client.query("COMMIT");

            return res.json({
                success: true,
                item: item.name,
                remaining: userStats.gold_apples - item.price,
                newLevel: newLevel,
            });
        } catch (err) {
            await client.query("ROLLBACK");
            console.error("購買失敗", err);
            return res.status(500).json({ error: "操作失敗" });
        } finally {
            client.release();
        }
    });
    return router;
};