import { pool } from "./db.js";
import { callAI, aiNames, aiProfiles } from "./ai.js";
import { expForNextLevel } from "./utils.js";
import { songState } from "./song.js";
import { ioTokens } from "./auth.js";
import { addUserIP, removeUserIP } from "./ip.js";
const AML = process.env.ADMIN_MAX_LEVEL || 99;
const ANL = process.env.ADMIN_MIN_LEVEL || 91;

const OPENAI = process.env.OPENAI === "true"
export const rooms = {};
export const roomContext = {};
export const aiTimers = {};
export const videoState = {};
export const displayQueue = {};
export const onlineUsers = new Map();

/* ================= 工具 ================= */
function getClientIP(socket) {
    return socket?.handshake?.headers
        ? socket.handshake.headers["x-forwarded-for"]?.split(",")[0]
        || socket.handshake.headers["cf-connecting-ip"]
        || socket.handshake.address
        : socket?.handshake?.address;
}

function getRoomState(room) {
    if (!songState[room]) {
        songState[room] = {
            queue: [],
            currentSinger: null,
            scores: {},
            listeners: [],
            phase: "idle",
            scoreTimer: null,
        };
    }
    return songState[room];
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
        const state = getRoomState(room);
        const ip = getClientIP(socket);
        socket.join(room);

        if (!rooms[room]) rooms[room] = [];

        let name = user.name || "訪客" + Math.floor(Math.random() * 9999);
        let level = 1, exp = 0, gender = "女", avatar = "/avatars/g01.gif";
        let type = user.type || "guest";
        let token = user.token || "";
        try {
            const res = await pool.query(
                `
                SELECT u.username, u.gender, u.avatar,
                    urs.level, urs.exp
                FROM users u
                LEFT JOIN user_room_stats urs
                ON u.id = urs.user_id AND urs.room = $2
                WHERE u.username = $1
                `,
                [user.name, room]
            );
            const dbUser = res.rows[0];
            if (dbUser) {
                name = dbUser.username;
                level = dbUser.level || 1;
                exp = dbUser.exp || 0;
                gender = dbUser.gender || "女";
                avatar = dbUser.avatar || avatar;
                type = type === "account" ? "account" : type;
            }
        } catch (err) {
            console.error("joinRoom取得使用者資料錯誤：", err);
        }
        console.log("🟢 join", room, socket.id, name);
        // 更新 socket.data
        socket.data = { room, name, level, exp, gender, avatar, type };

        // 🔥 用 token 判斷真正雙開
        if (token) {
            const existing = ioTokens.get(token);
            if (existing && existing.socketId !== socket.id) {
                const oldSocket = io.sockets.sockets.get(existing.socketId);
                if (oldSocket) {
                    oldSocket.emit("forceLogout", {
                        reason: "帳號已在其他地方登入"
                    });
                    oldSocket.disconnect(true);
                    console.log("forceLogout", room, socket.id, name);
                }
            }
            // 更新 token 綁定
            ioTokens.set(token, {
                username: name,
                socketId: socket.id,
                ip
            });
        }

        // 加入或更新房間列表
        const exists = rooms[room].find(u => u.name === name);
        if (!exists) {
            rooms[room].push({ id: socket.id, socketId: socket.id, name, type, level, exp, gender, avatar });
        } else {
            const oldSocket = io.sockets.sockets.get(exists.socketId);
            if (oldSocket) {
                oldSocket.emit("forceLogout", {
                    reason: "帳號已在其他地方登入"
                });
                oldSocket.disconnect(true);
                console.log("踢掉重複forceLogout", room, exists.socketId, name);
            }
            // 如果已存在，更新 socketId 或其他資訊
            exists.id = socket.id;
            exists.socketId = socket.id;
            exists.level = level;
            exists.exp = exp;
            exists.gender = gender;
            exists.avatar = avatar;
            exists.type = type;
            console.log("重複登入", room, socket.id, name);
        }

        onlineUsers.set(name, Date.now());
        addUserIP(ip, name);

        // 加入 AI（如果沒加入過）
        aiNames.forEach(ai => {
            if (!rooms[room].find(u => u.name === ai)) {
                rooms[room].push({
                    id: ai,
                    name: ai,
                    type: "AI",
                    level: aiProfiles[ai]?.level || AML,
                    gender: aiProfiles[ai]?.gender || "女",
                    avatar: aiProfiles[ai]?.avatar || null,
                    socketId: null
                });
            }
        });

        // 初始化房間狀態
        if (!roomContext[room]) roomContext[room] = [];
        if (!videoState[room]) videoState[room] = { currentVideo: null, queue: [] };
        if (!songState[room]) songState[room] = { currentSinger: null, scores: [], scoreTimer: null };

        // 廣播更新
        io.to(room).emit("systemMessage", `${name} 進入聊天室`);
        io.to(room).emit("updateUsers", rooms[room]);
        io.to(room).emit("videoUpdate", videoState[room].currentVideo);
        io.to(room).emit("videoQueueUpdate", videoState[room].queue);

        if (OPENAI) startAIAutoTalk(io, room);
    });

    // --- 聊天訊息 ---
    socket.on("message", async ({ room, message, user, target, mode, color }) => {
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
                SELECT u.id, urs.level, urs.exp, u.gender, u.avatar, u.account_type
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
                while (level < 90 && exp >= expForNextLevel(level)) {
                    exp -= expForNextLevel(level);
                    level += 1;
                }
                await pool.query(
                    `
                    UPDATE user_room_stats
                    SET level = $1, exp = $2
                    WHERE user_id = $3 AND room = $4
                    `,
                    [level, exp, dbUser.id, room]
                );
                if (rooms[room]) {
                    const roomUser = rooms[room].find(u => u.name === user.name);
                    if (roomUser) {
                        roomUser.level = level;
                        roomUser.exp = exp;
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
        const users = (rooms[room] || []).filter(u => u.id !== socket.id);
        callback(users);
    });

    // ================== 離開房間 ==================
    const removeUser = () => {
        if (socket.data.hasLeft) return; // 避免重複
        socket.data.hasLeft = true;

        const { room, name } = socket.data || {};
        if (!room || !rooms[room]) return;

        const wasInRoom = rooms[room].some(u => u.id === socket.id);
        const ip = getClientIP(socket);
        rooms[room] = rooms[room].filter(u => u.id !== socket.id);
        socket.leave(room);

        if (name && wasInRoom) {
            if (songState[room]?.currentSinger === name) {
                clearTimeout(songState[room].scoreTimer);
                songState[room].currentSinger = null;
                songState[room].scoreTimer = null;
                io.to(room).emit("user-stop-singing", { singer: name });
            }
            io.to(room).emit("systemMessage", `${name} 離開聊天室`);
            io.to(room).emit("updateUsers", rooms[room]);
            console.log("leave", room, socket.id, name);
        }
        if (!name) return;
        onlineUsers.delete(name);
        removeUserIP(ip, name)
    };

    socket.on("leaveRoom", removeUser);
    socket.on("disconnect", removeUser);
    // ⭐ Heartbeat 事件
    socket.on("heartbeat", () => {
        const name = socket.data.name;
        if (!name) return;
        onlineUsers.set(name, Date.now());
    });
}

// --- AI 自動對話 ---
export function startAIAutoTalk(io, room) {
    if (aiTimers[room]) return;

    async function loop() {
        const aiList = (rooms[room] || []).filter(u => u.type === "AI");
        if (!aiList.length) return;

        const speaker = aiList[Math.floor(Math.random() * aiList.length)];
        const reply = await callAI("繼續延續話題但不要提到我們正在延續話題這幾個字", speaker.name);

        io.to(room).emit("message", { user: { name: speaker.name }, message: reply });
        if (!roomContext[room]) roomContext[room] = [];
        roomContext[room].push({ user: speaker.name, text: reply });
        if (roomContext[room].length > 20) roomContext[room].shift();

        aiTimers[room] = setTimeout(loop, 30000 + Math.random() * 15000);
    }

    loop();
}
