import { songState } from "./song.js";
import { callAISongComment } from "./ai.js";

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

    // ===== 開始唱歌 =====
    socket.on("start-singing", ({ room, singer }) => {
        const state = getRoomState(room);
        if (state.currentSinger) return;
        state.currentSinger = singer;
        if (!state.scores[singer]) state.scores[singer] = [];
        state.phase = "singing";
        socket.join(room);
        state.scores[singer] = [];
        const avg = 0;
        const count = 0;
        // 廣播前端重置上一輪分數
        io.to(room).emit("songResult", { avg, count });
        io.to(room).emit("user-start-singing", { singer });
        io.to(singer).emit("update-room-phase", { phase: "singing" }); // 唱歌者自己
        io.to(room).except(singer).emit("update-room-phase", { phase: "canListen", singer });
        console.log(`[start-singing] ${singer} 開始唱歌`);
    });

    // ===== 停止唱歌 → 評分開始 =====
    socket.on("stop-singing", ({ room, singer }) => {
        const state = getRoomState(room);
        if (!state || state.currentSinger !== singer) return;

        state.phase = "scoring"; // 評分階段
        // 通知房間停止唱歌
        io.to(room).emit("user-stop-singing", { singer });
        io.to(room).emit("update-room-phase", { phase: state.phase, singer });
        console.log(`[stop-singing] ${singer} 停止唱歌`);

        // 廣播評分開始
        io.to(room).emit("scoring-start");
        console.log(`[scoring-start] 評分開始`);
        // 確保本輪 scores 為空
        if (!state.scores[singer]) state.scores[singer] = [];

        // 15 秒後計算平均分
        if (state.scoreTimer) clearTimeout(state.scoreTimer);
        state.scoreTimer = setTimeout(() => {
            const scores = state.scores[singer] || [];
            const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

            io.to(room).emit("songResult", { singer, avg, count: scores.length });
            console.log(`[songResult] ${singer} 平均 ${avg} (${scores.length} 人)`);

            callAISongComment({ singer, avg })
                .then(comment => io.to(room).emit("message", comment))
                .catch(console.error);

            state.scoreTimer = null;

            // 清空聽眾隊列（重新開始下一輪）
            if (Array.isArray(state.listeners)) {
                state.listeners.forEach(id => {
                    const socketObj = io.sockets.sockets.get(id);
                    if (socketObj) socketObj.emit("listener-left", { listenerId: id });
                });
            }
            state.listeners = [];
            state.currentSinger = null;
            state.phase = "idle"; // 評分結束回到 idle
            io.to(room).emit("update-listeners", { listeners: [] });
            io.to(room).emit("update-room-phase", { phase: state.phase });
        }, 15000);
    });

    // ===== 評分接收 =====
    socket.on("scoreSong", ({ room, score }) => {
        const state = songState[room];
        if (!state || !state.currentSinger) return;
        const singer = state.currentSinger;
        if (!state.scores[singer]) state.scores[singer] = [];
        console.log(`Before push, scores[singer]:`, state.scores[singer]);
        state.scores[singer].push(score);
        console.log(`After push, scores[singer]:`, state.scores[singer]);
        socket.emit("scoreAck", { singer, score });
        console.log(`[scoreSong] ${socket.id} 給 ${singer} 評分 ${score}`);
    });

    // ===== 聽眾準備接收 WebRTC =====
    socket.on("listener-ready", ({ room, listenerId }) => {
        if (!songState[room]) songState[room] = { queue: [], currentSinger: null, scores: {}, listeners: [], scoreTimer: null };
        const state = songState[room];
        if (!Array.isArray(state.listeners)) state.listeners = [];
        if (!state.listeners.includes(listenerId)) state.listeners.push(listenerId);

        const singerId = state.currentSinger;
        if (singerId) io.to(singerId).emit("new-listener", { listenerId });
        io.to(room).emit("update-listeners", { listeners: state.listeners });
        console.log(`[listener-ready] ${listenerId} 開始聽歌`);
    });

    socket.on("stop-listening", ({ room, listenerId }) => {
        const state = songState[room];
        if (!state || !Array.isArray(state.listeners)) return;
        state.listeners = state.listeners.filter(id => id !== listenerId);

        const singerId = state.currentSinger;
        if (singerId) io.to(singerId).emit("listener-left", { listenerId });

        io.to(room).emit("update-listeners", { listeners: state.listeners });
        console.log(`[stop-listening] ${listenerId} 離開聽眾`);
    });

    socket.on("disconnect", () => {
        console.log(`[disconnect] ${socket.id} 離線`);

        // 遍歷所有房間
        for (const room in songState) {
            const state = songState[room];
            if (!state || !Array.isArray(state.listeners)) continue;

            // 移除這個 listener
            state.listeners = state.listeners.filter(id => id !== socket.id);

            // 如果這個 listener 正在看唱歌者的 WebRTC，也通知唱歌者
            const singerId = state.currentSinger;
            if (singerId) {
                const singerSocket = io.sockets.sockets.get(singerId);
                if (singerSocket) singerSocket.emit("listener-left", { listenerId: socket.id });
            }

            // 廣播更新聽眾列表
            io.to(room).emit("update-listeners", { listeners: state.listeners });
        }
    });

}

// ===== WebRTC 信令 =====
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
