import { pool } from "./db.js";
import { callAI, aiNames, aiProfiles } from "./ai.js";
import { expForNextLevel } from "./utils.js";
import { songState, playNextSinger } from "./song.js";

export const rooms = {};
export const roomContext = {};
export const aiTimers = {};
export const videoState = {};
export const displayQueue = {};

// Socket.io 聊天邏輯
export function chatHandlers(io, socket) {

    // --- 加入房間 ---
    socket.on("joinRoom", async ({ room, user }) => {
        socket.join(room);
        let name = user.name || "訪客" + Math.floor(Math.random() * 9999);
        socket.data.name = name;
        io.to(room).emit("new-user", { socketId: socket.id, name });
        let level = 1, exp = 0, gender = "女", avatar = "/avatars/g01.gif";
        let type = user.type || "guest";

        try {
            const res = await pool.query(`SELECT username, level, exp, gender, avatar FROM users WHERE username=$1`, [user.name]);
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

        socket.data = { room, name, level, gender, avatar, type };

        if (!rooms[room]) rooms[room] = [];
        if (!rooms[room].find(u => u.name === name)) {
            rooms[room].push({ id: socket.id, name, type, level, exp, gender, avatar });
        }

        // 加入 AI
        aiNames.forEach(ai => {
            if (!rooms[room].find(u => u.name === ai)) {
                rooms[room].push({
                    id: ai,
                    name: ai,
                    type: "AI",
                    level: aiProfiles[ai]?.level || 99,
                    gender: aiProfiles[ai]?.gender || "女",
                    avatar: aiProfiles[ai]?.avatar || null
                });
            }
        });

        if (!roomContext[room]) roomContext[room] = [];
        if (!videoState[room]) videoState[room] = { currentVideo: null, queue: [] };
        if (!songState[room]) songState[room] = { currentSinger: null, scores: [], scoreTimer: null };

        io.to(room).emit("updateSingingStatus", { currentSinger: songState[room].currentSinger });
        io.to(room).emit("systemMessage", `${name} 加入房間`);
        io.to(room).emit("updateUsers", rooms[room]);
        io.to(room).emit("videoUpdate", videoState[room].currentVideo);
        io.to(room).emit("videoQueueUpdate", videoState[room].queue);

        startAIAutoTalk(io, room);
    });

    // --- 聊天訊息 ---
    socket.on("message", async ({ room, message, user, target, mode }) => {
        if (!roomContext[room]) roomContext[room] = [];
        roomContext[room].push({ user: user.name, text: message });
        if (roomContext[room].length > 20) roomContext[room].shift();

        const msgPayload = { user, message, target: target || "", mode };

        // 更新 EXP / LV
        try {
            const res = await pool.query(`SELECT id, level, exp, gender, avatar, account_type FROM users WHERE username=$1`, [user.name]);
            const dbUser = res.rows[0];
            if (dbUser) {
                let { level, exp, gender, avatar, account_type } = dbUser;
                exp += 5;
                while (exp >= expForNextLevel(level)) {
                    exp -= expForNextLevel(level);
                    level += 1;
                }
                await pool.query(`UPDATE users SET level=$1, exp=$2 WHERE id=$3`, [level, exp, dbUser.id]);
                if (rooms[room]) {
                    const roomUser = rooms[room].find(u => u.name === user.name);
                    if (roomUser) {
                        roomUser.level = level; roomUser.exp = exp; roomUser.gender = gender;
                        roomUser.avatar = avatar || roomUser.avatar || "/avatars/g01.gif";
                        roomUser.type = account_type || roomUser.type || "guest";
                    }
                }
            }
        } catch (err) { console.error("更新 EXP/LV/使用者資料 失敗：", err); }

        // 廣播訊息
        if (mode === "private" && target) {
            const sockets = Array.from(io.sockets.sockets.values());
            sockets.forEach(s => {
                if (s.data.name === target || s.data.name === user.name) s.emit("message", msgPayload);
            });
        } else io.to(room).emit("message", msgPayload);

        // AI 回覆
        if (target && aiProfiles[target]) {
            const reply = await callAI(message, target);
            const aiMsg = { user: { name: target }, message: reply, target: user.name, mode };
            if (mode === "private") {
                const sockets = Array.from(io.sockets.sockets.values());
                sockets.forEach(s => { if (s.data.name === target || s.data.name === user.name) s.emit("message", aiMsg); });
            } else io.to(room).emit("message", aiMsg);

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

    // --- 取得房間使用者 ---
    socket.on("getRoomUsers", (room, callback) => {
        const users = (rooms[room] || []).filter(u => u.id !== socket.id);
        callback(users);
    });

    // --- 離開房間 / 斷線 ---
    const removeUser = () => {
        const { room, name } = socket.data || {};
        if (!room || !rooms[room]) return;
        rooms[room] = rooms[room].filter(u => u.id !== socket.id && u.name !== name);
        socket.leave(room);

        if (name) {
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
