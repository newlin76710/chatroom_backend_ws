import { songState } from "./song.js";
import { callAISongComment } from "./ai.js";

function getRoomState(room) {
    if (!songState[room]) {
        songState[room] = {
            queue: [],
            currentSinger: null,
            recordedSongUrl: null,
            scores: {},
            listeners: [],
            phase: "idle",
            scoreTimer: null,
        };
    }
    return songState[room];
}

export function songSocket(io, socket) {
    // ===== 加入隊列唱歌 =====
    socket.on("joinQueue", ({ room, singer }) => {
        const state = getRoomState(room);
        socket.join(room);

        if (!state.queue.includes(singer) && state.currentSinger !== singer) {
            state.queue.push(singer);
            console.log(`[joinQueue] ${singer} 加入隊列`, state.queue);
        }

        // 如果沒人在唱歌，自動開始下一位
        if (!state.currentSinger && state.queue.length > 0) {
            const next = state.queue.shift();
            state.currentSinger = next;
            state.phase = "recording"; // 轉為錄音階段
            if (!state.scores[next]) state.scores[next] = [];

            io.to(room).emit("queueUpdate", { queue: state.queue, current: next });
            io.to(next).emit("update-room-phase", { phase: "recording" });
            io.to(room).except(next).emit("update-room-phase", { phase: "canListen", singer: next });
            console.log(`[queue] ${next} 自動開始錄音`);
        } else {
            io.to(room).emit("queueUpdate", { queue: state.queue, current: state.currentSinger });
        }
    });

    // ===== 錄音完成，上傳音檔 =====
    socket.on("songReady", ({ room, singer, url, duration }) => {
        const state = getRoomState(room);
        if (state.currentSinger !== singer) return;

        state.recordedSongUrl = url;
        state.phase = "scoring";

        io.to(room).emit("playSong", { url, duration }); // 廣播給聽眾播放
        io.to(room).emit("update-room-phase", { phase: "scoring", singer });

        // 開始評分倒數
        if (state.scoreTimer) clearTimeout(state.scoreTimer);
        state.scoreTimer = setTimeout(() => {
            const scores = state.scores[singer] || [];
            const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

            io.to(room).emit("songResult", { singer, avg, count: scores.length });

            callAISongComment({ singer, avg })
                .then(comment => io.to(room).emit("message", comment))
                .catch(console.error);

            // 清空 listeners
            state.listeners.forEach(id => {
                const sock = io.sockets.sockets.get(id);
                if (sock) sock.emit("listener-left", { listenerId: id });
            });
            state.listeners = [];
            state.currentSinger = null;
            state.recordedSongUrl = null;
            state.phase = "idle";

            // 自動輪到下一位
            if (state.queue.length > 0) {
                const next = state.queue.shift();
                state.currentSinger = next;
                state.phase = "recording";
                if (!state.scores[next]) state.scores[next] = [];

                io.to(room).emit("queueUpdate", { queue: state.queue, current: next });
                io.to(next).emit("update-room-phase", { phase: "recording" });
                io.to(room).except(next).emit("update-room-phase", { phase: "canListen", singer: next });
                console.log(`[queue] ${next} 自動開始錄音`);
            } else {
                io.to(room).emit("update-room-phase", { phase: "idle" });
            }

            state.scoreTimer = null;
        }, duration * 1000); // 使用錄音檔長度作為倒數
    });

    // ===== 評分 =====
    socket.on("scoreSong", ({ room, score }) => {
        const state = getRoomState(room);
        if (!state || !state.currentSinger) return;

        const singer = state.currentSinger;
        if (!state.scores[singer]) state.scores[singer] = [];
        state.scores[singer].push(score);

        socket.emit("scoreAck", { singer, score });
        console.log(`[scoreSong] ${socket.id} 給 ${singer} 評分 ${score}`);
    });

    // ===== 聽眾管理 =====
    socket.on("listener-ready", ({ room, listenerId }) => {
        const state = getRoomState(room);
        if (!state.listeners.includes(listenerId)) state.listeners.push(listenerId);

        const singerId = state.currentSinger;
        if (singerId) io.to(singerId).emit("new-listener", { listenerId });
        io.to(room).emit("update-listeners", { listeners: state.listeners });
    });

    socket.on("stop-listening", ({ room, listenerId }) => {
        const state = getRoomState(room);
        if (!state || !Array.isArray(state.listeners)) return;
        state.listeners = state.listeners.filter(id => id !== listenerId);

        const singerId = state.currentSinger;
        if (singerId) io.to(singerId).emit("listener-left", { listenerId });
        io.to(room).emit("update-listeners", { listeners: state.listeners });
    });

    // ===== 離線 / 離開房間自動清理 =====
    function cleanUpUser(userId) {
        for (const room in songState) {
            const state = songState[room];
            if (!state) continue;

            if (Array.isArray(state.listeners)) {
                state.listeners = state.listeners.filter(id => id !== userId);
            }

            if (state.currentSinger === userId) {
                console.log(`[cleanup] ${userId} 正在錄音，停止中...`);
                state.currentSinger = null;
                state.recordedSongUrl = null;
                state.phase = "idle";

                if (state.queue.length > 0) {
                    const next = state.queue.shift();
                    state.currentSinger = next;
                    state.phase = "recording";
                    if (!state.scores[next]) state.scores[next] = [];

                    io.to(room).emit("queueUpdate", { queue: state.queue, current: next });
                    io.to(next).emit("update-room-phase", { phase: "recording" });
                    io.to(room).except(next).emit("update-room-phase", { phase: "canListen", singer: next });
                    console.log(`[queue] ${next} 自動開始錄音`);
                } else {
                    io.to(room).emit("update-room-phase", { phase: "idle" });
                }
            }

            io.to(room).emit("update-listeners", { listeners: state.listeners });
        }
    }

    socket.on("leaveRoom", ({ room, singer }) => {
        console.log(`[leaveRoom] ${singer} 離開房間`);
        cleanUpUser(singer);
    });

    socket.on("disconnect", () => {
        console.log(`[disconnect] ${socket.id} 離線`);
        cleanUpUser(socket.id);
    });
}
