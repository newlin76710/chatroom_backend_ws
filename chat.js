import { pool } from "./db.js";
import { callAI, aiNames, aiProfiles } from "./ai.js";
import { expForNextLevel } from "./utils.js";
import { songState } from "./song.js";

export const rooms = {};
export const roomContext = {};
export const aiTimers = {};
export const videoState = {};
export const displayQueue = {};

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

    // --- 加入房間 ---
    socket.on("joinRoom", async ({ room, user }) => {
        const state = getRoomState(room);
        socket.join(room);
        console.log("🟢 join", room, socket.id);
        if (!rooms[room]) rooms[room] = [];

        let name = user.name || "訪客" + Math.floor(Math.random() * 9999);
        let level = 1, exp = 0, gender = "女", avatar = "/avatars/g01.gif";
        let type = user.type || "guest";

        try {
            const res = await pool.query(
                `SELECT username, level, exp, gender, avatar FROM users_ws WHERE username=$1`,
                [user.name]
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

        // 更新 socket.data
        socket.data = { room, name, level, exp, gender, avatar, type };

        // 🔥 後登入踢掉前登入
        const existingUser = rooms[room].find(u => u.name === name);
        if (existingUser && existingUser.socketId !== socket.id) {
            const oldSocket = io.sockets.sockets.get(existingUser.socketId);
            if (oldSocket) {
                oldSocket.emit("forceLogout", { reason: `你的帳號被 ${name} 取代` });
                oldSocket.disconnect(true);
            }
            // 移除舊使用者
            rooms[room] = rooms[room].filter(u => u.name !== name);
        }

        // 加入或更新房間列表
        rooms[room].push({ id: socket.id, socketId: socket.id, name, type, level, exp, gender, avatar });

        // 更新 DB 在線狀態 ⭐
        try {
            await pool.query(
                `UPDATE users_ws
                 SET is_online=true, last_seen=NOW()
                 WHERE username=$1`,
                [name]
            );
        } catch (err) {
            console.error("更新 is_online 失敗：", err);
        }

        // 加入 AI（如果沒加入過）
        aiNames.forEach(ai => {
            if (!rooms[room].find(u => u.name === ai)) {
                rooms[room].push({
                    id: ai,
                    name: ai,
                    type: "AI",
                    level: aiProfiles[ai]?.level || 99,
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
        io.to(room).emit("systemMessage", `${name} 加入房間`);
        io.to(room).emit("updateUsers", rooms[room]);
        io.to(room).emit("videoUpdate", videoState[room].currentVideo);
        io.to(room).emit("videoQueueUpdate", videoState[room].queue);

        //startAIAutoTalk(io, room);
    });

    // --- 聊天訊息 ---
    socket.on("message", async ({ room, message, user, target, mode, color }) => {
        if (!roomContext[room]) roomContext[room] = [];
        roomContext[room].push({ user: user.name, text: message });
        if (roomContext[room].length > 20) roomContext[room].shift();

        // ⭐ 加上 ip
        const ip = getClientIP(socket);
        const msgPayload = { user, message, target: target || "", mode, color, ip };

        // 更新 EXP / LV
        try {
            const res = await pool.query(
                `SELECT id, level, exp, gender, avatar, account_type FROM users_ws WHERE username=$1`,
                [user.name]
            );
            const dbUser = res.rows[0];
            if (dbUser) {
                let { level, exp, gender, avatar, account_type } = dbUser;
                exp += 5;
                while (exp >= expForNextLevel(level)) {
                    exp -= expForNextLevel(level);
                    level += 1;
                }
                await pool.query(`UPDATE users_ws SET level=$1, exp=$2 WHERE id=$3`, [level, exp, dbUser.id]);
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

        // 廣播訊息
        if (mode === "private" && target) {
            const sockets = Array.from(io.sockets.sockets.values());
            sockets.forEach(s => {
                // 私聊對象收到訊息
                if (s.data?.name === target || s.data?.name === user.name) {
                    s.emit("message", msgPayload);
                }
                // ⭐ Lv.99 監控私聊
                else if (s.data?.level === 99) {
                    s.emit("message", { ...msgPayload, monitored: true });
                }
            });
        } else {
            // 公聊直接廣播
            io.to(room).emit("message", msgPayload);
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
                    else if (s.data?.level === 99) {
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
        if (!kicker || kicker.level < 99) {
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

        console.log(`👢 Lv99 ${kicker.name} 踢出 ${targetName}`);

        /* =========================
           ⭐ 關鍵：對齊後登入踢前
        ========================= */

        // 1️⃣ DB token 失效（跟後登入踢前一樣）
        await pool.query(
            `UPDATE users_ws
         SET is_online=false, login_token=NULL
         WHERE username=$1`,
            [targetName]
        );

        // 2️⃣ 通知前端
        targetSocket.emit("forceLogout", {
            reason: "你已被 Lv.99 玩家踢出"
        });

        // 3️⃣ 強制斷線（會自動觸發你原本的 disconnect → removeUser）
        targetSocket.disconnect(true);

        /* ========================= */

        io.to(room).emit("systemMessage", `${targetName} 被 Lv.99 玩家踢出`);
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

        rooms[room] = rooms[room].filter(u => u.id !== socket.id);
        socket.leave(room);

        if (name && wasInRoom) {
            if (songState[room]?.currentSinger === name) {
                clearTimeout(songState[room].scoreTimer);
                songState[room].currentSinger = null;
                songState[room].scoreTimer = null;
                io.to(room).emit("user-stop-singing", { singer: name });
            }
            io.to(room).emit("systemMessage", `${name} 離開房間`);
            io.to(room).emit("updateUsers", rooms[room]);
        }
    };

    socket.on("leaveRoom", removeUser);
    socket.on("disconnect", removeUser);
    // ⭐ Heartbeat 事件
    socket.on("heartbeat", async () => {
        const name = socket.data?.name;
        if (!name) return;
        try {
            await pool.query(
                `UPDATE users_ws
             SET is_online=true, last_seen=NOW()
             WHERE username=$1`,
                [name]
            );
        } catch (err) {
            console.error("Heartbeat 更新失敗：", err);
        }
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
