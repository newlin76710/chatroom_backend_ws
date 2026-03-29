import { pool } from "./db.js";
import { callAI, aiNames, aiProfiles } from "./ai.js";
import { expForNextLevel } from "./utils.js";
import { songState, getRoomState } from "./socketHandlers.js";
import { ioTokens } from "./auth.js";
import { addUserIP, removeUserIP } from "./ip.js";
const AML = process.env.ADMIN_MAX_LEVEL || 99;
const ANL = parseInt(process.env.ADMIN_MIN_LEVEL, 10) || 91;
const GUEST = process.env.OPENGUEST === "true";
const OPENAI = process.env.OPENAI === "true"

export const aiTimers = {};
export const rooms = {};
export const roomContext = {};
export const videoState = {};
export const displayQueue = {};
export const onlineUsers = new Map();
export const pendingReconnect = new Map();
export const onlineRewardTimers = {};
export const onlineRewardTracker = new Map();
// ================= 防洗版 =================
const userSpamCache = new Map();
// key: username
// value: { lastMessage, lastTime }

// ================= 禁言系統 =================
const muteMap = new Map();
// key: username
// value: muteUntil (timestamp)
/* ================= 工具 ================= */

function getClientIP(socket) {
    return socket?.handshake?.headers
        ? socket.handshake.headers["x-forwarded-for"]?.split(",")[0]
        || socket.handshake.headers["cf-connecting-ip"]
        || socket.handshake.address
        : socket?.handshake?.address;
}

function startOnlineReward(io, room) {
    if (onlineRewardTimers[room]) return;
    onlineRewardTimers[room] = setInterval(async () => {
        const now = Date.now();
        const users = rooms[room] || [];
        for (const u of users) {
            if (u.type !== "account") continue;
            const lastSeen = onlineUsers.get(u.name);
            if (!lastSeen || now - lastSeen > 5 * 60 * 1000) continue;
            const lastReward = onlineRewardTracker.get(u.name) || 0;
            // ⭐ 核心：每個人自己的30分鐘
            if (now - lastReward < 30 * 60 * 1000) continue;
            try {
                const res = await pool.query(`
                    SELECT u.id, urs.level, urs.exp
                    FROM users u
                    JOIN user_room_stats urs
                    ON u.id = urs.user_id
                    WHERE u.username = $1 AND urs.room = $2
                `, [u.name, room]);
                const dbUser = res.rows[0];
                if (!dbUser) continue;
                let { level, exp } = dbUser;
                if (level >= ANL - 1) continue;
                exp += 10;
                while (level < ANL - 1 && exp >= expForNextLevel(level)) {
                    exp -= expForNextLevel(level);
                    level++;
                }
                await pool.query(`
                    UPDATE user_room_stats
                    SET level=$1, exp=$2
                    WHERE user_id=$3 AND room=$4
                `, [level, exp, dbUser.id, room]);

                // ⭐ 更新領獎時間（超重要）
                onlineRewardTracker.set(u.name, now);
                // 同步記憶體
                const roomUser = rooms[room].find(x => x.name === u.name);
                if (roomUser) {
                    roomUser.level = level;
                    roomUser.exp = exp;
                }
                const socket = Array.from(io.sockets.sockets.values())
                    .find(s => s.data?.name === u.name);
                if (socket) {
                    socket.emit("systemMessage", `${u.name} 在線獎勵🎁 +10 積分`);
                }
            } catch (err) {
                console.error("在線獎勵錯誤:", err);
            }
        }
        io.to(room).emit("updateUsers", rooms[room]);
    }, 60 * 1000); // ⭐ 改成每1分鐘檢查（不是30分鐘！）
}

async function logMessage({ room, username, role, message, mode = "public", target = '', message_type = "text", socket }) {
    try {
        const ip = getClientIP(socket);
        await pool.query(
            `INSERT INTO message_logs
       (room, username, role, message, message_type, mode, target, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [room, username, role, message, message_type, mode, target, ip || null]
        );
    } catch (err) {
        console.error("❌ 發言紀錄寫入失敗：", err);
    }
}
// Socket.io 聊天邏輯
export function chatHandlers(io, socket) {
    // --- 進入房間 ---
    socket.on("joinRoom", async ({ room, user }) => {
        const token = user.token || null;
        let name = user.name || "訪客" + Math.floor(Math.random() * 9999);
        const ip = getClientIP(socket);

        // 🔹 重連 restore
        const oldTimer = pendingReconnect.get(name);
        if (oldTimer) {
            clearTimeout(oldTimer);
            pendingReconnect.delete(name);
            console.log("♻️ reconnect restore:", name);
        }

        socket.join(room);
        if (!rooms[room]) rooms[room] = [];

        // 清理 ghost user
        rooms[room] = rooms[room].filter(u => u.type === "AI" || io.sockets.sockets.has(u.socketId));

        // 預設資料
        let level = 1, exp = 0, gender = "女", avatar = "/avatars/g01.gif";
        let type = user.type || "guest";
        let gold_apples = 0;

        if (type === "guest" && !GUEST) {
            socket.emit("joinFailed", { reason: "本聊天室禁止訪客登入" });
            socket.disconnect(true);
            return;
        }

        // 從 DB 取得資料
        try {
            const res = await pool.query(`
            SELECT u.username, u.gender, u.avatar, urs.level, urs.exp, urs.gold_apples
            FROM users u
            LEFT JOIN user_room_stats urs
            ON u.id = urs.user_id AND urs.room = $2
            WHERE u.username = $1
        `, [user.name, room]);
            const dbUser = res.rows[0];
            if (dbUser) {
                name = dbUser.username;
                level = dbUser.level || 1;
                exp = dbUser.exp || 0;
                gold_apples = dbUser.gold_apples || 0;
                gender = dbUser.gender || "女";
                avatar = dbUser.avatar || avatar;
                type = type === "account" ? "account" : type;
            }
        } catch (err) {
            console.error("joinRoom DB error:", err);
        }

        console.log("🟢 join", room, socket.id, name);

        // ⭐ 設定 socket.data
        socket.data = { ...socket.data, room, name, token, level, exp, gold_apples, gender, avatar, type };

        // ⭐ 踢掉同名舊 socket（forceLogout）
        const oldUser = rooms[room].find(u => u.name === name && u.socketId !== socket.id);
        if (oldUser) {
            const oldSocket = io.sockets.sockets.get(oldUser.socketId);
            if (oldSocket) {
                oldSocket.data = oldSocket.data || {};
                oldSocket.data.forceLogout = true;
                oldSocket.emit("forceLogout", { reason: "帳號已在其他地方登入" });
                oldSocket.disconnect(true); // 斷線時才會刪 token
            }
            rooms[room] = rooms[room].filter(u => u.socketId !== oldUser.socketId);
        }

        // ⭐ 註冊新 socket token
        if (token) ioTokens.set(token, { username: name, socketId: socket.id, ip, ts: Date.now() });

        // rooms 更新
        let existing = rooms[room].find(u => u.name === name);
        if (!existing) {
            rooms[room].push({ socketId: socket.id, name, type, level, exp, gold_apples, gender, avatar });
            io.to(room).emit("systemMessage", `${name} 進入聊天室`);
        } else {
            existing.socketId = socket.id;
            existing.level = level;
            existing.exp = exp;
            existing.gold_apples = gold_apples;
            existing.gender = gender;
            existing.avatar = avatar;
            existing.type = type;
        }

        // onlineUsers / IP
        onlineUsers.set(name, Date.now());
        addUserIP(ip, name);
        onlineRewardTracker.set(name, Date.now());
        // 初始化房間狀態
        if (!roomContext[room]) roomContext[room] = [];
        if (!videoState[room]) videoState[room] = { currentVideo: null, queue: [] };
        if (!songState[room]) getRoomState(room);

        // 廣播更新
        io.to(room).emit("updateUsers", rooms[room]);
        io.to(room).emit("videoUpdate", videoState[room].currentVideo);
        io.to(room).emit("videoQueueUpdate", videoState[room].queue);
        if (OPENAI) startAIAutoTalk(io, room);
        startOnlineReward(io, room);
    });

    // --- 聊天訊息 ---
    socket.on("message", async ({ room, message, user, target, mode, color }) => {
        const now = Date.now();
        const username = user.name;
        // ===== 1️⃣ 檢查是否被禁言 =====
        const muteUntil = muteMap.get(username);
        if (muteUntil && now < muteUntil) {
            socket.emit("systemMessage", `你已被禁言 ${Math.ceil((muteUntil - now) / 1000)} 秒`);
            return;
        }
        // ===== 2️⃣ 10秒內不能重複相同內容 =====
        const cleanMsg = message.trim();
        const record = userSpamCache.get(username);
        if (record) {
            const timeDiff = now - record.lastTime;
            if (record.lastMessage === cleanMsg && timeDiff <= 10000) {
                socket.emit("systemMessage", "❌ 10秒內不能重複相同發言");
                return;
            }
        }
        userSpamCache.set(username, {
            lastMessage: cleanMsg,
            lastTime: now
        });
        if (!roomContext[room]) roomContext[room] = [];
        roomContext[room].push({ user: user.name, text: message });
        if (roomContext[room].length > 20) roomContext[room].shift();

        // ⭐ 加上 ip
        const ip = getClientIP(socket);
        const msgPayload = { user, message, target: target || "", mode, color, ip };
        // 廣播訊息
        if (mode === "private" && target) {
            const sockets = Array.from(io.sockets.sockets.values());
            sockets.forEach(s => {
                // 私聊對象收到訊息
                if (s.data?.name === target || s.data?.name === user.name) {
                    s.emit("message", msgPayload);
                }
                // ⭐ Lv.99 監控私聊
                else if (Number(s.data?.level) === Number(AML)) {
                    s.emit("message", { ...msgPayload, monitored: true });
                }
            });
        } else {
            // 公聊直接廣播
            io.to(room).emit("message", msgPayload);
        }

        // 更新 EXP / LV
        try {
            const res = await pool.query(
                `
        SELECT u.id, urs.level, urs.exp,
               u.gender, u.avatar, u.account_type
        FROM users u
        JOIN user_room_stats urs
        ON u.id = urs.user_id
        WHERE u.username = $1
        AND urs.room = $2
        `,
                [user.name, room]
            );

            const dbUser = res.rows[0];

            if (dbUser) {
                let { level, exp, gender, avatar, account_type } = dbUser;

                exp += 5;

                while (level < ANL - 1 && exp >= expForNextLevel(level)) {
                    exp -= expForNextLevel(level);
                    level += 1;
                }

                // ✅ 不更新 gold_apples
                await pool.query(
                    `
            UPDATE user_room_stats
            SET level = $1, exp = $2
            WHERE user_id = $3 AND room = $4
            `,
                    [level, exp, dbUser.id, room]
                );

                // 🔹 記憶體同步（⚠️ 這裡才拿舊的 gold_apples）
                if (rooms[room]) {
                    const roomUser = rooms[room].find(u => u.name === user.name);
                    if (roomUser) {
                        roomUser.level = level;
                        roomUser.exp = exp;
                        // ❌ 不要改 gold_apples
                        roomUser.gender = gender;
                        roomUser.avatar = avatar || roomUser.avatar || "/avatars/g01.gif";
                        roomUser.type = account_type || roomUser.type || "guest";
                    }
                }

                io.to(room).emit("updateUsers", rooms[room]);
            }

        } catch (err) {
            console.error("更新 EXP/LV/使用者資料 失敗：", err);
        }

        // ⭐ 寫入 DB（使用者）
        await logMessage({
            room,
            username: user.name,
            role: socket.data?.type || "guest",
            message,
            mode,
            target,
            socket
        });

        // AI 回覆
        if (target && aiProfiles[target]) {
            const reply = await callAI(message, target);
            const aiMsg = { user: { name: target }, message: reply, target: user.name, mode, color: "#ff99aa", ip };
            if (mode === "private") {
                const sockets = Array.from(io.sockets.sockets.values());
                sockets.forEach(s => {
                    if (s.data?.name === target || s.data?.name === user.name) {
                        s.emit("message", aiMsg);
                    }
                    else if (Number(s.data?.level) === Number(AML)) {
                        s.emit("message", { ...aiMsg, monitored: true });
                    }
                });
            } else io.to(room).emit("message", aiMsg);

            // ⭐ 寫入 AI 發言紀錄
            await logMessage({
                room,
                username: target,
                role: "AI",
                message: reply,
                mode,
                target: user.name,
                message_type: "ai",
                socket
            });

            roomContext[room].push({ user: target, text: reply });
            if (roomContext[room].length > 20) roomContext[room].shift();
        }
    });


    // --- YouTube ---
    socket.on("playVideo", ({ room, url, user }) => {
        if (!displayQueue[room]) displayQueue[room] = [];
        displayQueue[room].push({ type: "video", name: user?.name || "訪客", title: "點播影片" });

        if (!videoState[room]) videoState[room] = { currentVideo: null, queue: [] };
        const video = { url, user };
        videoState[room].currentVideo = video;
        videoState[room].queue.push(video);

        io.to(room).emit("displayQueueUpdate", displayQueue[room]);
        io.to(room).emit("videoUpdate", video);
        io.to(room).emit("videoQueueUpdate", videoState[room].queue);
    });
    // ================= 管理員禁言 =================
    socket.on("muteUser", ({ room, targetName }) => {

        const users = rooms[room];
        if (!users) return;

        const admin = users.find(u => u.socketId === socket.id);
        if (!admin || admin.level < ANL) {
            socket.emit("systemMessage", "權限不足");
            return;
        }

        if (admin.name === targetName) {
            socket.emit("systemMessage", "不能禁言自己");
            return;
        }

        const muteSeconds = 30;
        const muteUntil = Date.now() + muteSeconds * 1000;

        muteMap.set(targetName, muteUntil);

        io.to(room).emit("systemMessage", `${targetName} 被禁言 30 秒`);
    });

    // socketHandlers/chat.js 或 server.js
    socket.on("kickUser", async ({ room, targetName }) => {
        console.log("🔹 kickUser received:", room, targetName);

        const users = rooms[room];
        if (!users) return;

        const kicker = users.find(u => u.socketId === socket.id);
        if (!kicker || kicker.level < ANL) {
            socket.emit("kickFailed", { reason: "權限不足" });
            return;
        }

        if (kicker.name === targetName) {
            socket.emit("kickFailed", { reason: "不能踢自己" });
            return;
        }

        const target = users.find(u => u.name === targetName);
        if (!target || !target.socketId) return;

        const targetSocket = io.sockets.sockets.get(target.socketId);
        if (!targetSocket) return;

        console.log(`👢 ${kicker.name} 踢出 ${targetName}`);

        /* =========================
           ⭐ 關鍵：對齊後登入踢前
        ========================= */

        onlineUsers.delete(targetName);
        // 2️⃣ 通知前端
        targetSocket.data.forceLogout = true;
        targetSocket.emit("forceLogout", {
            reason: "你已被管理員踢出"
        });

        // 3️⃣ 強制斷線（會自動觸發你原本的 disconnect → removeUser）
        targetSocket.disconnect(true);

        /* ========================= */

        io.to(room).emit("systemMessage", `${targetName} 被管理員踢出`);
    });


    // --- 取得房間使用者 ---
    socket.on("getRoomUsers", (room, callback) => {
        const users = (rooms[room] || []);
        callback(users);
    });

    // ================== 離開房間 ==================
    const removeUser = () => {
        if (socket.data.hasLeft) return;
        socket.data.hasLeft = true;

        const { room, name, token } = socket.data || {};
        if (!room || !rooms[room]) return;
        if (rooms[room]?.length === 0) {
            clearInterval(onlineRewardTimers[room]);
            delete onlineRewardTimers[room];
        }
        const wasInRoom = rooms[room].some(u => u.socketId === socket.id);

        rooms[room] = rooms[room].filter(u => u.type === "AI" || u.socketId !== socket.id);
        socket.leave(room);

        if (name && wasInRoom) {
            io.to(room).emit("systemMessage", `${name} 離開聊天室`);
            io.to(room).emit("updateUsers", rooms[room]);
            console.log("leave", room, socket.id, name);
        }

        if (name) {
            onlineUsers.delete(name);
            onlineRewardTracker.delete(name);
        } 
        removeUserIP(getClientIP(socket), name);

        // ⭐ 只刪自己的 token
        if (token) {
            const current = ioTokens.get(token);
            if (current && current.socketId === socket.id) {
                ioTokens.delete(token);
            }
        }
    };

    socket.on("leaveRoom", () => {
        socket.data.manualLeave = true;
        removeUser();
    });

    socket.on("disconnect", () => {
        const { forceLogout, manualLeave, name } = socket.data || {};

        if (forceLogout || manualLeave) {
            removeUser();
            return;
        }

        if (!name) return;

        // reconnect 機制 10 秒
        const oldTimer = pendingReconnect.get(name);
        if (oldTimer) clearTimeout(oldTimer);

        const timer = setTimeout(() => {
            const stillOnline = rooms[socket.data.room]?.some(
                u => u.name === name && u.socketId !== socket.id
            );

            if (stillOnline) {
                console.log("♻️ skip removeUser (reconnected):", name);
                pendingReconnect.delete(name);
                return;
            }

            removeUser();
            pendingReconnect.delete(name);
        }, 10000);

        pendingReconnect.set(name, timer);
    });

    socket.on("updateMyName", ({ room, oldName, newName }) => {
        if (socket.data.name === oldName) {
            socket.data.name = newName;
        }
        if (rooms[room]) {
            const u = rooms[room].find(u => u.name === oldName);
            if (u) u.name = newName;
            io.to(room).emit("updateUsers", rooms[room]);
        }
    });

    // ⭐ Heartbeat 事件
    socket.on("heartbeat", () => {
        const name = socket.data.name;
        if (!name) return;
        onlineUsers.set(name, Date.now());
    });
}

export function startAIAutoTalk(io, room) {
    // 如果已經在跑，就不要再啟動
    if (aiTimers[room]) return;

    const aiBusy = {}; // key: AI name，避免同時生成回覆

    async function safeCallAI(aiName, prompt) {
        if (aiBusy[aiName]) return null; // 正在處理，跳過
        aiBusy[aiName] = true;
        try {
            return await callAI(prompt, aiName);
        } catch (err) {
            console.error(`AI ${aiName} 回覆失敗:`, err);
            return null;
        } finally {
            aiBusy[aiName] = false;
        }
    }

    async function loop() {
        try {
            // 確保 AI 在房間裡
            if (!rooms[room]) rooms[room] = [];
            aiNames.forEach(ai => {
                if (!rooms[room].find(u => u.name === ai)) {
                    rooms[room].push({
                        name: ai,
                        type: "AI",
                        level: aiProfiles[ai]?.level || AML,
                        gender: aiProfiles[ai]?.gender || "女",
                        avatar: aiProfiles[ai]?.avatar || null,
                        socketId: null
                    });
                }
            });

            const aiList = (rooms[room] || []).filter(u => u.type === "AI");

            if (aiList.length) {
                const speaker = aiList[Math.floor(Math.random() * aiList.length)];
                const context = (roomContext[room] || [])
                    .slice(-10)
                    .map(c => `${c.user}:${c.text}`)
                    .join("\n");

                // 30% 機率 AI 互聊
                let prompt;
                if (Math.random() < 0.3 && aiList.length > 1) {
                    let otherAI;
                    do {
                        otherAI = aiList[Math.floor(Math.random() * aiList.length)];
                    } while (otherAI.name === speaker.name);
                    prompt = `
                    聊天室最近聊天：
                    ${context}
                    你看到「${otherAI.name}」剛剛講了一句話，
                    請自然接話聊天
                                        `;
                } else {
                    prompt = `
                    聊天室最近聊天：
                    ${context}
                    請自然加入聊天
                    `;
                }

                const reply = await safeCallAI(speaker.name, prompt);
                if (reply) {
                    io.to(room).emit("message", { user: { name: speaker.name }, message: reply });

                    if (!roomContext[room]) roomContext[room] = [];
                    roomContext[room].push({ user: speaker.name, text: reply });
                    if (roomContext[room].length > 20) roomContext[room].shift();
                }
            }
        } catch (err) {
            console.error("AI 自動聊天 loop 發生錯誤:", err);
        } finally {
            // 無論房間有沒有 AI，都確保下一次 loop 會跑
            aiTimers[room] = setTimeout(loop, 30000 + Math.random() * 15000);
        }
    }

    loop();
}