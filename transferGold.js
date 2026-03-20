// transferGold.js
import express from "express";
import { pool } from "./db.js";
import { rooms } from "./chat.js";
import { authMiddleware } from "./auth.js";
import { expForNextLevel } from "./utils.js";
const rosePoems = [
    "玫香隨夜落，花影入窗紅；輕風傳愛意，一朵寄君中。",
    "春風開玫瑰，幽香滿小樓；誰人輕贈我，笑意在心頭。",
    "紅花藏月色，香氣動人心；一枝傳遠意，情到夜深深。",
    "玫影搖春夜，花香入夢長；君心如月白，一朵寄柔腸。",
    "一枝紅似火，春意滿人間；輕贈知心客，花開笑語間。",
    "玫香隨風去，月色照花枝；今夜誰相贈，情深不自知。",
    "紅花開小院，微雨潤芳心；贈君千里意，香遠入春林。",
    "一朵紅玫瑰，輕落夜窗前；不語情先到，花香滿世間。",
    "花開春正好，玫影動微風；此意誰相識，幽香入夢中。",
    "紅蕊映燈火，花香入酒杯；今宵誰贈我，一笑滿樓梅。"
];
export function randomRosePoem() {
    return rosePoems[Math.floor(Math.random() * rosePoems.length)];
}

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

            // 🔹 用 user_id 查 sender stats
            const senderRes = await client.query(
                `SELECT urs.user_id, urs.gold_apples
             FROM user_room_stats urs
             WHERE urs.user_id = $1 AND urs.room = $2
             FOR UPDATE`,
                [sender.id, ROOM]
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

            // 🔹 查 target user_id
            const targetUserRes = await client.query(
                `SELECT id AS user_id, username
             FROM users
             WHERE username = $1`,
                [targetUsername]
            );

            if (!targetUserRes.rows.length) {
                await client.query("ROLLBACK");
                return res.json({ success: false, transferred: 0, reason: "目標使用者不存在" });
            }

            const targetUser = targetUserRes.rows[0];

            const targetStatsRes = await client.query(
                `SELECT user_id, gold_apples
             FROM user_room_stats
             WHERE user_id = $1 AND room = $2
             FOR UPDATE`,
                [targetUser.user_id, ROOM]
            );

            if (!targetStatsRes.rows.length) {
                await client.query("ROLLBACK");
                return res.json({ success: false, transferred: 0, reason: "目標使用者未加入聊天室" });
            }

            const targetStats = targetStatsRes.rows[0];
            const actualTransfer = Math.min(amount, senderStats.gold_apples, MAX_GOLD_APPLES - targetStats.gold_apples);

            if (actualTransfer <= 0) {
                await client.query("ROLLBACK");
                return res.json({ success: false, transferred: 0, reason: "目標使用者金蘋果已達上限或你沒有足夠蘋果" });
            }

            // 🔹 更新金蘋果 (用 user_id)
            await client.query(
                `UPDATE user_room_stats
             SET gold_apples = gold_apples - $1
             WHERE user_id = $2 AND room = $3`,
                [actualTransfer, senderStats.user_id, ROOM]
            );

            await client.query(
                `UPDATE user_room_stats
             SET gold_apples = gold_apples + $1
             WHERE user_id = $2 AND room = $3`,
                [actualTransfer, targetStats.user_id, ROOM]
            );

            // 🔹 寫入 gift_logs (保留 username)
            await client.query(
                `INSERT INTO gift_logs 
   (room, sender, receiver, receiver_id, item_type, amount)
   VALUES 
   ($1, $2, $3, $4, $5, $6),
   ($7, $8, $9, $10, $11, $12)`,

                [
                    // sender 扣
                    ROOM, sender.username, sender.username, sender.id, "gold_apples", -actualTransfer,

                    // receiver 加
                    ROOM, sender.username, targetUser.username, targetUser.user_id, "gold_apples", actualTransfer
                ]
            );

            const systemMessage = `${sender.username} 已給 ${targetUser.username} ${actualTransfer} 金蘋果 以示獎勵`;

            await client.query(
                `INSERT INTO message_logs (room, username, role, message, message_type, mode, target, created_at, ip)
             VALUES ($1, $2, 'system', $3, 'system', 'reward', $4, NOW(), '0.0.0.0')`,
                [ROOM, sender.username, systemMessage, targetUser.username]
            );

            await client.query("COMMIT");

            // 🔹 廣播 socket
            if (io) {
                io.to(ROOM).emit("transferMessage", {
                    room: ROOM,
                    username: sender.username,
                    role: "system",
                    message: systemMessage,
                    message_type: "system",
                    mode: "reward",
                    amount: actualTransfer,
                    target: targetUser.username,
                    created_at: new Date(),
                });

                const senderMem = rooms[ROOM]?.find(u => u.name === sender.username);
                const targetMem = rooms[ROOM]?.find(u => u.name === targetUser.username);

                if (senderMem) senderMem.gold_apples -= actualTransfer;
                if (targetMem) targetMem.gold_apples += actualTransfer;

                io.to(ROOM).emit("updateUsers", rooms[ROOM]);
            }

            return res.json({ success: true, requested: amount, transferred: actualTransfer, to: targetUser.username });
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
            const { username, count } = req.body;

            if (!admin || admin.level < AML)
                return res.status(403).json({ error: "權限不足" });

            if (!username || typeof count !== "number")
                return res.status(400).json({ error: "參數錯誤" });

            const newAmount = Math.max(0, Math.min(MAX_GOLD_APPLES, count));

            await client.query("BEGIN");

            // 🔹 查使用者（含舊金額）
            const targetRes = await client.query(
                `SELECT u.id AS user_id, u.username, urs.gold_apples, urs.level
             FROM users u
             JOIN user_room_stats urs ON u.id = urs.user_id
             WHERE u.username = $1 
               AND urs.room = $2 
               AND urs.level BETWEEN $3 AND $4
             FOR UPDATE`,
                [username, ROOM, ANL, AML]
            );

            if (!targetRes.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({
                    error: `使用者不存在、未加入聊天室，或等級不在 ${ANL}~${AML} 範圍`
                });
            }

            const target = targetRes.rows[0];
            const targetId = target.user_id;
            const oldAmount = target.gold_apples;

            // 🔹 計算差額（核心）
            const diff = newAmount - oldAmount;

            // 🔹 更新主表
            await client.query(
                `UPDATE user_room_stats
             SET gold_apples = $1
             WHERE user_id = $2 AND room = $3`,
                [newAmount, targetId, ROOM]
            );

            // 🔥 補 log（關鍵）
            if (diff !== 0) {
                await client.query(
                    `INSERT INTO gift_logs 
                 (room, sender, receiver, receiver_id, item_type, amount)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        ROOM,
                        admin.username,     // 誰改的
                        target.username,    // 被改的人
                        targetId,
                        "gold_apples",
                        diff                // 差額（正=補發，負=扣除）
                    ]
                );
            }

            // 🔹 廣播
            if (io) {
                const userMem = rooms[ROOM]?.find(u => u.name === username);
                if (userMem) userMem.gold_apples = newAmount;

                io.to(ROOM).emit("updateUsers", rooms[ROOM]);
            }

            await client.query("COMMIT");

            return res.json({
                success: true,
                message: `已將 ${username} 的金蘋果設為 ${newAmount}`,
                username,
                gold_apples: newAmount,
                diff // 👉 方便你 debug
            });

        } catch (err) {
            await client.query("ROLLBACK");
            console.error("設定使用者金蘋果失敗", err);
            return res.status(500).json({ error: "操作失敗" });
        } finally {
            client.release();
        }
    });

    /* ================= 積分排行榜 ================= */
    router.get("/exp-leaderboard", authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const TOP_N = parseInt(req.query.top || "10", 10); // 可透過 query ?top=10 調整

            // 總排行：level + exp 排序，只選擇 ANL 以下的玩家
            const expRes = await client.query(
                `SELECT u.username, urs.level, urs.exp, (urs.level*1000000 + urs.exp) AS total_points
             FROM users u
             JOIN user_room_stats urs ON u.id = urs.user_id
             WHERE urs.room = $1 AND urs.level < $2
             ORDER BY total_points DESC
             LIMIT $3`,
                [ROOM, ANL, TOP_N]
            );

            res.json({
                success: true,
                leaderboard: expRes.rows
            });
        } catch (err) {
            console.error("查詢積分排行榜失敗", err);
            res.status(500).json({ success: false, error: "查詢失敗" });
        } finally {
            client.release();
        }
    });

    router.get("/gold-apple-leaderboard", authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const { type = "gold_apples", range = "monthly" } = req.query;
            const TOP_N = parseInt(req.query.top || "10", 10);

            if (!["gold_apples", "rose", "firework"].includes(type)) {
                return res.status(400).json({ success: false, error: "type 參數錯誤" });
            }

            const now = new Date();
            let startDate = null;
            let endDate = null;

            if (range === "monthly") {
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1); // ✅ 下個月1號
            }

            if (range === "lastMonth") {
                startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                endDate = new Date(now.getFullYear(), now.getMonth(), 1);
            }

            let result;

            if (range === "total") {
                // 總量直接從 user_room_stats 拿值，排除 ANL 以上
                const columnMap = {
                    gold_apples: "gold_apples",
                    rose: "rose",
                    firework: "firework"
                };
                const col = columnMap[type];

                const totalRes = await client.query(
                    `SELECT u.username, urs.${col} AS amount
                 FROM users u
                 JOIN user_room_stats urs ON u.id = urs.user_id
                 WHERE urs.room = $1 AND urs.level < $2
                 ORDER BY urs.${col} DESC
                 LIMIT $3`,
                    [ROOM, ANL, TOP_N]
                );

                result = totalRes.rows;
            } else {
                // 當月 / 上月 用 gift_logs + 排除 ANL 以上
                let query = `
                SELECT u.username,
                       SUM(CASE WHEN gl.item_type=$1 THEN gl.amount ELSE 0 END) AS amount
                FROM users u
                JOIN user_room_stats urs ON u.id = urs.user_id
                JOIN gift_logs gl ON u.id = gl.receiver_id
                WHERE gl.room = $2
                  AND urs.room = $2
                  AND urs.level < $3
            `;
                const params = [type, ROOM, ANL];

                if (startDate) {
                    params.push(startDate);
                    query += ` AND gl.created_at >= $${params.length}`;
                }
                if (endDate) {
                    params.push(endDate);
                    query += ` AND gl.created_at <= $${params.length}`;
                }

                query += `
                GROUP BY u.username
                ORDER BY amount DESC
                LIMIT $${params.length + 1}
            `;
                params.push(TOP_N);

                const monthlyRes = await client.query(query, params);
                result = monthlyRes.rows;
            }

            res.json({
                success: true,
                type,
                range,
                leaderboard: result
            });
        } catch (err) {
            console.error("查詢排行榜失敗", err);
            res.status(500).json({ success: false, error: "查詢失敗" });
        } finally {
            client.release();
        }
    });

    const SHOP_ITEMS = {
        rose: { name: "🌹 玫瑰", price: 5, type: "gift", image: "/gifts/rose.gif" },
        firework: { name: "🎆 放煙火", price: 15, type: "firework", image: "/gifts/firework.gif" },
        ball: { name: "🔮 積分球", price: 30, type: "exp", exp: 1000 },
        rename: { name: "✏️ 升級卡", price: 1000, type: "levelUp" },
    };
    router.post("/shop/buy", authMiddleware, async (req, res) => {
        const { itemId } = req.body;
        const buyer = req.user;
        const item = SHOP_ITEMS[itemId];
        const MAX_LEVEL = ANL - 1;
        if (!item) return res.status(400).json({ error: "商品暫不開放" });

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            // 查使用者金蘋果和等級
            const userRes = await client.query(
                "SELECT id AS user_id, gold_apples, level, exp FROM user_room_stats WHERE user_id = $1 AND room = $2 FOR UPDATE",
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

            let addExp = 0;
            if (item.type === "exp") {
                if (userStats.level >= MAX_LEVEL) {
                    await client.query("ROLLBACK");
                    return res.status(400).json({ error: `已達積分上限` });
                }
                addExp = item.exp || 0;
            }
            let newExp = userStats.exp + addExp;
            let newLevel = userStats.level;

            while (newExp >= expForNextLevel(newLevel) && newLevel < MAX_LEVEL) {
                newExp -= expForNextLevel(newLevel);
                newLevel++;
            }
            // 升級卡
            if (item.type === "levelUp") {
                if (userStats.level >= MAX_LEVEL) {
                    await client.query("ROLLBACK");
                    return res.status(400).json({ error: `已達升級上限` });
                }
                newLevel = newLevel + 1;
            }
            if (item.type === "gift") {
                const { targetName } = req.body;
                if (!targetName) {
                    await client.query("ROLLBACK");
                    return res.status(400).json({ error: "請指定要送給誰" });
                }

                const target = rooms[ROOM]?.find(u => u.name === targetName);
                if (!target) {
                    await client.query("ROLLBACK");
                    return res.status(400).json({ error: "對方不在線上" });
                }
                const poem = randomRosePoem();
                // ⭐ 寫入 gift_logs
                const targetRes = await client.query(
                    `SELECT id FROM users WHERE username = $1`,
                    [targetName]
                );

                const receiverId = targetRes.rows[0]?.id;
                if (!receiverId) {
                    await client.query("ROLLBACK");
                    return res.status(400).json({ error: "使用者不存在" });
                }
                await client.query(
                    `INSERT INTO gift_logs 
   (room, sender, receiver, receiver_id, item_type, amount)
   VALUES ($1, $2, $3, $4, $5, $6)`,

                    [ROOM, buyer.username, targetName, receiverId, "rose", 1]
                );
                // 🔹 更新 user_room_stats 對方的 rose
                await client.query(
                    `UPDATE user_room_stats
   SET rose = COALESCE(rose, 0) + 1
   WHERE user_id = $1 AND room = $2`,
                    [receiverId, ROOM]
                );
                // 廣播專屬禮物訊息
                io.to(ROOM).emit("giftMessage", {
                    from: buyer.username,
                    to: targetName,
                    item: item.name,
                    // 這裡可放玫瑰大圖 URL 或 GIF
                    imageUrl: item.image,
                    message: `獻上一朵玫瑰 🌹\n${poem}`
                });
                // 🔹 更新 rooms 緩存
                if (target) target.rose = (target.rose || 0) + 1;
            }
            if (item.type === "firework") {
                // ⭐ 寫入 gift_logs
                await client.query(
                    `INSERT INTO gift_logs 
   (room, sender, receiver, receiver_id, item_type, amount)
   VALUES ($1, $2, $3, $4, $5, $6)`,

                    [ROOM, buyer.username, buyer.username, buyer.id, "firework", 1]
                );
                // 🔹 更新 user_room_stats 自己的 firework
                await client.query(
                    `UPDATE user_room_stats
         SET firework = COALESCE(firework, 0) + 1
         WHERE user_id = $1 AND room = $2`,
                    [buyer.id, ROOM]
                );
                // 🔥 滿屏煙花廣播
                io.to(ROOM).emit("fireworkShow", {
                    from: buyer.username,
                    item: item.name,
                    imageUrl: item.image,
                    message: `${buyer.username} 施放煙花 🎆 全場慶祝!`
                });
            }
            // 扣金蘋果 & 更新等級（如果是升級卡）
            await client.query(
                "UPDATE user_room_stats SET gold_apples = gold_apples - $1, level = $2, exp = $3 WHERE user_id = $4 AND room = $5",
                [item.price, newLevel, newExp, buyer.id, ROOM]
            );
            // 🔹 加入金蘋果紀錄（負值表示自己花掉）
            await client.query(
                `INSERT INTO gift_logs 
     (room, sender, receiver, receiver_id, item_type, amount)
     VALUES ($1, $2, $3, $4, $5, $6)`,

                [ROOM, buyer.username, buyer.username, buyer.id, "gold_apples", -item.price]
            );
            // 更新 rooms 緩存
            const mem = rooms[ROOM]?.find(u => u.name === buyer.username);
            if (mem) {
                mem.gold_apples -= item.price;
                mem.level = newLevel;
                mem.exp = newExp;
                if (item.type === "firework") {
                    mem.firework = (mem.firework || 0) + 1;
                }
            }

            // 廣播聊天室訊息
            if (io) {
                let systemMsg = "";
                if (item.type === "exp") {
                    if (newLevel > userStats.level) {
                        systemMsg = `${buyer.username} 使用積分球 🔮 獲得 ${addExp} 積分，升級到 Lv.${newLevel}`;
                    } else {
                        systemMsg = `${buyer.username} 使用積分球 🔮 獲得 ${addExp} 積分`;
                    }
                }

                if (item.type === "levelUp") {
                    systemMsg = `${buyer.username} 使用升級卡，等級提升到 Lv.${newLevel}`;
                }

                if (item.type === "firework") {
                    systemMsg = `${buyer.username} 施放煙花 🎆 全場慶祝!`;
                }

                if (systemMsg) {
                    io.to(ROOM).emit("systemMessage", systemMsg);
                }
                io.to(ROOM).emit("updateUsers", rooms[ROOM]);
            }

            await client.query("COMMIT");

            return res.json({
                success: true,
                item: item.name,
                remaining: mem?.gold_apples ?? (userStats.gold_apples - item.price),
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