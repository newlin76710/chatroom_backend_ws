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

const chocolatePoems = [
    "一方黑巧入掌心，甜苦交織是深情；無聲勝過千言語，融化你我此刻心。",
    "可可香氣漫夜空，一片深情輕輕送；甜蜜不需多言語，巧克力裡藏溫柔。",
    "黑巧如墨映月光，苦中帶甜似你樣；今夜一片輕相贈，願你心中暖洋洋。",
    "可可田裡藏秘語，一顆一顆釀成詩；贈你這份苦甜味，希望你能懂我意。",
    "絲滑巧克力入喉，甜意悄悄上心頭；不說愛你說太早，先讓巧克力開口。",
    "一塊巧克力，一片真心意；甜蜜藏其中，請你細細品。",
    "可可香濃夜未央，贈君一片暖心房；苦後回甘如人生，願你事事皆如願。",
    "深夜送上小巧克，一份心意莫推辭；甜蜜滋味慢慢品，願你笑顏常如此。",
    "黑巧融入白月光，你的笑容比糖甜；一片巧克力輕輕放，願你今晚好夢甜。",
    "可可豆裡種下情，烘焙成詩贈給你；每一口都是思念，每一塊都是心意。",
    "巧克力如你眼眸，深邃甜蜜又溫柔；今夜一片輕輕送，望你夢裡有我候。",
    "苦甜交融是巧克，人生滋味亦如此；贈你一片小心意，願苦少來甜常隨。",
    "可可香從遠方來，化作甜蜜入心懷；一片巧克力相贈，願你開心每一天。",
    "深夜的巧克力香，像你留下的溫暖；一口甜蜜一口念，思念藏在可可間。",
    "黑巧白巧皆是情，今夜贈你最真心；願這甜蜜陪你夢，夢裡笑聲不停歇。",
    "巧克力碎輕輕落，如星灑落在你前；一片一片都是愛，請你慢慢細細嚐。",
    "可可飄香過長夜，一片真情難言說；甜蜜滋味君自知，願你心中有暖陽。",
    "輕輕一片巧克力，重重一份心裡情；不敢多說愛你語，先把甜蜜送到你。",
    "可可豆香繞指尖，融化心間是思念；今夜贈你小甜蜜，願你笑顏如花展。",
    "一方巧克力在手，千言萬語化成甜；贈你今夜好心情，願你夢裡盡是歡。"
];
export function randomChocolatePoem() {
    return chocolatePoems[Math.floor(Math.random() * chocolatePoems.length)];
}

const cakePoems = [
    "一層一層疊心意，奶油之上寫思念；今日贈你一塊蛋糕，願你每天甜如蜜。",
    "奶油香氣滿屋間，一口蛋糕暖心田；贈你這份小甜蜜，願你笑顏如春天。",
    "草莓點綴在蛋糕，如你笑靨映日光；一塊心意輕輕送，願你生活甜又香。",
    "蛋糕鬆軟似雲朵，奶油細滑如你心；今夜一塊輕相贈，願你夢裡皆是甜。",
    "生日也好平日也好，一塊蛋糕表心跡；甜蜜滋味慢慢品，願你事事都如意。",
    "奶油玫瑰開蛋糕，送上心意送祝福；一口甜蜜一口笑，願你天天樂無憂。",
    "蛋糕香氣隨風來，帶著我的小期待；贈你一塊甜滋味，願你笑口常常開。",
    "多層蛋糕疊情深，每一層都是心聲；今夜輕輕送到你，願你感受到我情。",
    "奶油花開在蛋糕，如你笑顏燦若花；一塊甜蜜輕輕贈，願你快樂無牽掛。",
    "鬆軟蛋糕配奶油，甜蜜滋味說不完；贈你今日一份甜，願你心中無憂愁。",
    "一塊蛋糕藏心語，奶油之間有深情；不說太多只送甜，願你懂得我心意。",
    "蛋糕甜香入夢來，如你溫柔伴我懷；今夜一塊輕相贈，願你笑顏常相開。",
    "奶油疊上又一層，每層都是祝福情；今日贈你蛋糕甜，願你生活更圓滿。",
    "草莓蛋糕送到你，甜中帶酸似人生；願你品得其中味，苦盡甘來好心情。",
    "蛋糕柔軟如你心，奶油香甜如你笑；今夜一塊真心贈，願你長樂又長好。",
    "一刀切下蛋糕時，切出我的一片情；送你甜蜜送心意，願你事事皆稱心。",
    "奶油香氣飄四方，蛋糕甜蜜入心房；今夜贈你這份甜，願你夢裡有陽光。",
    "多層夾心蛋糕裡，藏著我的小秘密；每一口都是心意，願你感受到甜蜜。",
    "蛋糕上的小玫瑰，像是我送你的情；一口甜蜜一口暖，願你永遠都開心。",
    "輕輕送上一塊蛋糕，重重帶著我心意；甜蜜滋味你先嚐，快樂全都歸給你。"
];
export function randomCakePoem() {
    return cakePoems[Math.floor(Math.random() * cakePoems.length)];
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

            // 🔹 贈送上限檢查（每次 + 每日）
            const settingsRes = await client.query(
                `SELECT per_transfer_limit, daily_transfer_limit FROM room_settings WHERE room = $1`,
                [ROOM]
            );
            const settings = settingsRes.rows[0] || {};
            const perTransferLimit = settings.per_transfer_limit || 0;
            const dailyTransferLimit = settings.daily_transfer_limit || 0;

            // 每次上限
            if (perTransferLimit > 0 && actualTransfer > perTransferLimit) {
                await client.query("ROLLBACK");
                return res.json({ success: false, transferred: 0, reason: `每次最多贈送 ${perTransferLimit} 顆` });
            }

            // 每日上限
            if (dailyTransferLimit > 0) {
                const todayTaiwan = (() => {
                    const now = new Date();
                    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
                    const tw = new Date(utc + 8 * 3600000);
                    return tw.toISOString().slice(0, 10);
                })();

                const sentTodayRes = await client.query(
                    `SELECT COALESCE(SUM(amount), 0) AS total_sent
                        FROM gift_logs
                        WHERE room = $1
                        AND sender_id = $2
                        AND receiver_id != $2
                        AND item_type = 'gold_apples'
                        AND amount > 0
                        AND (created_at AT TIME ZONE 'Asia/Taipei')::date = $3::date`,
                    [ROOM, sender.id, todayTaiwan]
                );

                const sentToday = parseInt(sentTodayRes.rows[0].total_sent, 10);
                const remaining = dailyTransferLimit - sentToday;

                if (remaining <= 0) {
                    await client.query("ROLLBACK");
                    return res.json({ success: false, transferred: 0, reason: `今日贈送上限 ${dailyTransferLimit} 顆已達到` });
                }

                if (actualTransfer > remaining) {
                    await client.query("ROLLBACK");
                    return res.json({ success: false, transferred: 0, reason: `今日最多還能贈送 ${remaining} 顆`, remaining });
                }
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
        (room, sender, sender_id, receiver, receiver_id, item_type, amount)
     VALUES 
        ($1, $2, $3, $4, $5, $6, $7),
        ($8, $9, $10, $11, $12, $13, $14)`,
                [
                    // sender 扣
                    ROOM, sender.username, sender.id, sender.username, sender.id, "gold_apples", -actualTransfer,
                    // receiver 加
                    ROOM, sender.username, sender.id, targetUser.username, targetUser.user_id, "gold_apples", actualTransfer
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
            const TOP_N = Math.min(parseInt(req.query.top || "10", 10), 100);

            const CHARM_TYPES = ["rose", "chocolate", "cake"];
            const isCharm = CHARM_TYPES.includes(type);

            if (!["gold_apples", "firework", ...CHARM_TYPES].includes(type)) {
                return res.status(400).json({ success: false, error: "type 參數錯誤" });
            }

            // =============================
            // 🕒 台灣時間 → 轉 UTC 區間
            // =============================
            const OFFSET = 8 * 60 * 60 * 1000;
            const now = new Date();
            const twNow = new Date(now.getTime() + OFFSET);

            let startDate = null;
            let endDate = null;

            function getTWMonthUTC(year, month) {
                const start = new Date(Date.UTC(year, month, 1));
                const end = new Date(Date.UTC(year, month + 1, 1));

                return {
                    start: new Date(start.getTime() - OFFSET),
                    end: new Date(end.getTime() - OFFSET),
                };
            }

            if (range === "monthly") {
                const { start, end } = getTWMonthUTC(
                    twNow.getUTCFullYear(),
                    twNow.getUTCMonth()
                );
                startDate = start;
                endDate = end;
            }

            if (range === "lastMonth") {
                const { start, end } = getTWMonthUTC(
                    twNow.getUTCFullYear(),
                    twNow.getUTCMonth() - 1
                );
                startDate = start;
                endDate = end;
            }

            let result;

            // =============================
            // 🏆 總排行榜（直接統計表）
            // =============================
            if (range === "total") {
                if (isCharm) {
                    // 魅力榜：rose + chocolate + cake 合計，各別回傳
                    const totalRes = await client.query(
                        `
                        SELECT u.username,
                            COALESCE(urs.rose, 0)        AS rose,
                            COALESCE(urs.chocolate, 0)   AS chocolate,
                            COALESCE(urs.cake, 0)        AS cake,
                            (COALESCE(urs.rose, 0) + COALESCE(urs.chocolate, 0) + COALESCE(urs.cake, 0)) AS total
                        FROM users u
                        JOIN user_room_stats urs ON u.id = urs.user_id
                        WHERE urs.room = $1
                          AND urs.level < $2
                        ORDER BY total DESC
                        LIMIT $3
                        `,
                        [ROOM, ANL, TOP_N]
                    );
                    result = totalRes.rows;
                } else {
                    const col = type; // gold_apples or firework
                    const totalRes = await client.query(
                        `
                        SELECT u.username, urs.${col} AS amount
                        FROM users u
                        JOIN user_room_stats urs ON u.id = urs.user_id
                        WHERE urs.room = $1
                          AND urs.level < $2
                        ORDER BY urs.${col} DESC
                        LIMIT $3
                        `,
                        [ROOM, ANL, TOP_N]
                    );
                    result = totalRes.rows;
                }
            } else {
                // =============================
                // 📊 月 / 上月（gift_logs）
                // =============================
                if (isCharm) {
                    // 魅力榜：三種禮物合計，各別回傳
                    let query = `
                        SELECT
                            u.username,
                            COALESCE(SUM(CASE WHEN gl.item_type = 'rose'      THEN gl.amount ELSE 0 END), 0) AS rose,
                            COALESCE(SUM(CASE WHEN gl.item_type = 'chocolate' THEN gl.amount ELSE 0 END), 0) AS chocolate,
                            COALESCE(SUM(CASE WHEN gl.item_type = 'cake'      THEN gl.amount ELSE 0 END), 0) AS cake,
                            COALESCE(SUM(gl.amount), 0) AS total
                        FROM users u
                        JOIN user_room_stats urs ON u.id = urs.user_id
                        JOIN gift_logs gl ON u.id = gl.receiver_id
                        WHERE gl.room = $1
                          AND urs.room = $1
                          AND urs.level < $2
                          AND gl.item_type IN ('rose', 'chocolate', 'cake')
                    `;
                    const params = [ROOM, ANL];
                    if (startDate) { params.push(startDate); query += ` AND gl.created_at >= $${params.length}`; }
                    if (endDate)   { params.push(endDate);   query += ` AND gl.created_at < $${params.length}`; }
                    query += ` GROUP BY u.username ORDER BY total DESC LIMIT $${params.length + 1}`;
                    params.push(TOP_N);
                    const charmRes = await client.query(query, params);
                    result = charmRes.rows;
                } else {
                    let query = `
                        SELECT
                            u.username,
                            COALESCE(SUM(gl.amount), 0) AS amount
                        FROM users u
                        JOIN user_room_stats urs ON u.id = urs.user_id
                        JOIN gift_logs gl ON u.id = gl.receiver_id
                        WHERE gl.room = $1
                          AND urs.room = $1
                          AND urs.level < $2
                          AND gl.item_type = $3
                    `;
                    const params = [ROOM, ANL, type];
                    if (startDate) { params.push(startDate); query += ` AND gl.created_at >= $${params.length}`; }
                    if (endDate)   { params.push(endDate);   query += ` AND gl.created_at < $${params.length}`; }
                    query += ` GROUP BY u.username ORDER BY amount DESC LIMIT $${params.length + 1}`;
                    params.push(TOP_N);
                    const monthlyRes = await client.query(query, params);
                    result = monthlyRes.rows;
                }
            }

            return res.json({
                success: true,
                type,
                range,
                leaderboard: result
            });

        } catch (err) {
            console.error("查詢排行榜失敗", err);
            return res.status(500).json({
                success: false,
                error: "查詢失敗"
            });
        } finally {
            client.release();
        }
    });

    const SHOP_ITEMS = {
        rose:      { name: "🌹 玫瑰",   price: 5,    type: "gift",     image: "/gifts/rose.gif",      poem: randomRosePoem,      giftMsg: (from, to, poem) => `${from} 獻給 ${to} 一朵玫瑰 🌹\n${poem}` },
        chocolate: { name: "🍫 巧克力", price: 5,    type: "gift",     image: "/gifts/chocolate.gif", poem: randomChocolatePoem, giftMsg: (from, to, poem) => `${from} 送給 ${to} 一盒巧克力 🍫\n${poem}` },
        cake:      { name: "🎂 蛋糕",   price: 5,    type: "gift",     image: "/gifts/cake.gif",      poem: randomCakePoem,      giftMsg: (from, to, poem) => `${from} 送給 ${to} 一塊蛋糕 🎂\n${poem}` },
        firework:  { name: "🎆 放煙火", price: 15,   type: "firework", image: "/gifts/firework.gif" },
        ball:      { name: "🔮 積分球", price: 30,   type: "exp",      exp: 1000 },
        rename:    { name: "✏️ 升級卡", price: 1000, type: "levelUp" },
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
                const poem = item.poem();
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
                    [ROOM, buyer.username, targetName, receiverId, itemId, 1]
                );
                // 🔹 更新 user_room_stats 對方對應欄位
                await client.query(
                    `UPDATE user_room_stats
   SET ${itemId} = COALESCE(${itemId}, 0) + 1
   WHERE user_id = $1 AND room = $2`,
                    [receiverId, ROOM]
                );
                // 🔹 好感度 +5
                await client.query(
                    `INSERT INTO user_affinity (from_user_id, to_user_id, affinity, updated_at)
                     VALUES ($1, $2, 5, NOW())
                     ON CONFLICT (from_user_id, to_user_id)
                     DO UPDATE SET affinity = user_affinity.affinity + 5, updated_at = NOW()`,
                    [buyer.id, receiverId]
                );
                // 廣播專屬禮物訊息
                io.to(ROOM).emit("giftMessage", {
                    from: buyer.username,
                    to: targetName,
                    item: item.name,
                    imageUrl: item.image,
                    message: item.giftMsg(buyer.username, targetName, poem)
                });
                // 🔹 更新 rooms 緩存
                if (target) target[itemId] = (target[itemId] || 0) + 1;
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