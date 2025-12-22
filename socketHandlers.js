import { songState } from "./song.js";
import { callAISongComment } from "./ai.js";

// 取得或初始化房間狀態
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

export function songSocket(io, socket) {
    // ===== 音訊廣播 =====
    socket.on("audio-chunk", ({ room, chunk }) => {
        socket.to(room).emit("audio-stream", chunk);
    });

    // ===== 加入隊列唱歌 =====
    socket.on("joinQueue", ({ room, singer }) => {
        const state = getRoomState(room);
        if (!state.queue.includes(singer)) state.queue.push(singer);

        // 如果沒人在唱歌，自動開始下一位
        if (!state.currentSinger) {
            const next = state.queue.shift();
            state.currentSinger = next;
            state.phase = "singing";

            io.to(room).emit("queueUpdate", { queue: state.queue, current: next });
            io.to(next).emit("update-room-phase", { phase: "singing" });
            io.to(room).except(next).emit("update-room-phase", { phase: "canListen", singer: next });
            console.log(`[queue] ${next} 開始唱歌`);
        } else {
            io.to(room).emit("queueUpdate", { queue: state.queue, current: state.currentSinger });
        }
    });

    // ===== 開始唱歌（直接觸發，用於前端立即更新狀態） =====
    socket.on("start-singing", ({ room, singer }) => {
        const state = getRoomState(room);
        if (state.currentSinger && state.currentSinger !== singer) return;

        state.currentSinger = singer;
        state.phase = "singing";
        if (!state.scores[singer]) state.scores[singer] = [];
        socket.join(room);

        io.to(room).emit("user-start-singing", { singer });
        io.to(singer).emit("update-room-phase", { phase: "singing" });
        io.to(room).except(singer).emit("update-room-phase", { phase: "canListen", singer });
        console.log(`[start-singing] ${singer} 開始唱歌`);
    });

    // ===== 停止唱歌 → 評分開始 =====
    socket.on("stop-singing", ({ room, singer }) => {
        const state = getRoomState(room);
        if (!state || state.currentSinger !== singer) return;

        state.phase = "scoring";
        io.to(room).emit("user-stop-singing", { singer });
        io.to(room).emit("update-room-phase", { phase: "scoring", singer });
        io.to(room).emit("scoring-start");

        if (!state.scores[singer]) state.scores[singer] = [];

        if (state.scoreTimer) clearTimeout(state.scoreTimer);
        state.scoreTimer = setTimeout(() => {
            const scores = state.scores[singer] || [];
            const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 0;

            io.to(room).emit("songResult", { singer, avg, count: scores.length });
            console.log(`[songResult] ${singer} 平均 ${avg} (${scores.length} 人)`);

            callAISongComment({ singer, avg })
                .then(comment => io.to(room).emit("message", comment))
                .catch(console.error);

            // 清空本輪聽眾
            state.listeners.forEach(id=>{
                const sock = io.sockets.sockets.get(id);
                if(sock) sock.emit("listener-left", { listenerId: id });
            });
            state.listeners = [];
            state.currentSinger = null;
            state.phase = "idle";

            // 自動輪到下一位
            if(state.queue.length>0){
                const next = state.queue.shift();
                state.currentSinger = next;
                state.phase = "singing";

                io.to(room).emit("queueUpdate", { queue: state.queue, current: next });
                io.to(next).emit("update-room-phase", { phase: "singing" });
                io.to(room).except(next).emit("update-room-phase", { phase: "canListen", singer: next });
                console.log(`[queue] ${next} 開始唱歌`);
            } else {
                io.to(room).emit("update-room-phase", { phase: "idle" });
            }

            state.scoreTimer = null;
        }, 15000);
    });

    // ===== 接收評分 =====
    socket.on("scoreSong", ({ room, score }) => {
        const state = songState[room];
        if (!state || !state.currentSinger) return;

        const singer = state.currentSinger;
        if (!state.scores[singer]) state.scores[singer] = [];
        state.scores[singer].push(score);

        socket.emit("scoreAck", { singer, score });
        console.log(`[scoreSong] ${socket.id} 給 ${singer} 評分 ${score}`);
    });

    // ===== WebRTC 聽眾管理 =====
    socket.on("listener-ready", ({ room, listenerId }) => {
        const state = getRoomState(room);
        if (!state.listeners.includes(listenerId)) state.listeners.push(listenerId);

        const singerId = state.currentSinger;
        if (singerId) io.to(singerId).emit("new-listener", { listenerId });
        io.to(room).emit("update-listeners", { listeners: state.listeners });
        console.log(`[listener-ready] ${listenerId} 開始聽歌`);
    });

    socket.on("stop-listening", ({ room, listenerId }) => {
        const state = getRoomState(room);
        if (!state || !Array.isArray(state.listeners)) return;
        state.listeners = state.listeners.filter(id => id !== listenerId);

        const singerId = state.currentSinger;
        if (singerId) io.to(singerId).emit("listener-left", { listenerId });
        io.to(room).emit("update-listeners", { listeners: state.listeners });
        console.log(`[stop-listening] ${listenerId} 離開聽眾`);
    });

    // ===== 離線處理 =====
    socket.on("disconnect", () => {
        console.log(`[disconnect] ${socket.id} 離線`);

        for (const room in songState) {
            const state = songState[room];
            if (!state || !Array.isArray(state.listeners)) continue;

            state.listeners = state.listeners.filter(id => id !== socket.id);

            const singerId = state.currentSinger;
            if (singerId) {
                const singerSocket = io.sockets.sockets.get(singerId);
                if (singerSocket) singerSocket.emit("listener-left", { listenerId: socket.id });
            }

            io.to(room).emit("update-listeners", { listeners: state.listeners });
        }
    });
}
export function webrtcHandlers(io, socket) {
    function forward(event, data) {
        if (!data.to) return;
        const target = io.sockets.sockets.get(data.to);
        if (target) target.emit(event, { ...data, from: socket.id });
        console.log(`[WebRTC] ${event} ${socket.id} → ${data.to}`);
    }

    socket.on("webrtc-offer", data => forward("webrtc-offer", data));
    socket.on("webrtc-answer", data => forward("webrtc-answer", data));
    socket.on("webrtc-candidate", data => forward("webrtc-candidate", data));
}
