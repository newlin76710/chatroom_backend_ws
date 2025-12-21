import { songState } from "./song.js";
import { callAISongComment } from "./ai.js";

export function songSocket(io, socket) {
  // --- 開始唱歌 ---
  socket.on("start-singing", ({ room, singer }) => {
    if (!songState[room]) {
      songState[room] = {
        queue: [],
        currentSinger: null,
        scores: {},
        scoreTimer: null,
        listeners: [],
      };
    }
    const state = songState[room];

    if (state.currentSinger) return; // 已有人在唱
    state.currentSinger = singer;
    if (!state.scores[singer]) state.scores[singer] = [];

    socket.to(room).emit("user-start-singing", { singer });
    console.log("✅ start-singing emitted public", singer);
  });

  // --- 停止唱歌 ---
  socket.on("stop-singing", ({ room, singer }) => {
    const state = songState[room];
    if (!state || state.currentSinger !== singer) return;

    state.currentSinger = null;
    socket.to(room).emit("user-stop-singing", { singer });
    console.log("🛑 stop-singing emitted public", singer);

    if (state.scoreTimer) clearTimeout(state.scoreTimer);

    // 處理評分
    const scores = state.scores[singer] || [];
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    io.to(room).emit("songResult", { singer, avg, count: scores.length });

    callAISongComment({ singer, avg })
      .then((aiComment) => io.to(room).emit("message", aiComment))
      .catch((err) => console.error("AI song comment error:", err));

    // 播放下一位
    state.scoreTimer = setTimeout(() => {
      const currentState = songState[room];
      if (!currentState) return;

      if (!Array.isArray(currentState.queue)) currentState.queue = [];

      if (currentState.queue.length > 0) {
        const next = currentState.queue.shift();
        currentState.currentSinger = next;
        currentState.scores[next] = currentState.scores[next] || [];

        io.to(room).emit("next-singer", { singer: next });
        io.to(room).emit("user-start-singing", { singer: next });

        // 設定自動結束
        currentState.scoreTimer = setTimeout(() => {
          socket.emit("stop-singing", { room, singer: next });
        }, 15000);
      } else {
        currentState.currentSinger = null;
        io.to(room).emit("updateSingingStatus", { currentSinger: null });
      }
    }, 100); // 確保先處理結果再下一位
  });

  // --- 接收評分 ---
  socket.on("scoreSong", ({ room, score }) => {
    const state = songState[room];
    if (!state || !state.currentSinger) return;

    const singer = state.currentSinger;
    if (!state.scores[singer]) state.scores[singer] = [];
    state.scores[singer].push(score);
  });

  // --- 聽眾準備接收 WebRTC ---
  socket.on("listener-ready", ({ room, listenerId }) => {
    const state = songState[room];
    const singerId = state?.currentSinger;
    if (!singerId) return;

    if (!state.listeners) state.listeners = [];
    if (!state.listeners.includes(listenerId)) state.listeners.push(listenerId);

    io.to(singerId).emit("new-listener", { listenerId });
    console.log("👂 listener-ready:", listenerId);
  });

  socket.on("stop-listening", ({ room, listenerId }) => {
    const state = songState[room];
    if (!state) return;

    // 移除聽眾
    state.listeners = state.listeners.filter((id) => id !== listenerId);

    // 通知唱歌者
    io.to(state.currentSinger).emit("listener-left", { listenerId });
    console.log("🛑 stop-listening:", listenerId);
  });
}

// -------------------------
// WebRTC 信令處理
// -------------------------
export function webrtcHandlers(io, socket) {
  function forward(event, data) {
    if (!data.to) return;
    const target = io.sockets.sockets.get(data.to);
    if (target) {
      target.emit(event, { ...data, from: socket.id });
      console.log(`[WebRTC] ${event} from ${socket.id} → ${data.to}`);
    }
  }

  socket.on("webrtc-offer", (data) => forward("webrtc-offer", data));
  socket.on("webrtc-answer", (data) => forward("webrtc-answer", data));
  socket.on("webrtc-candidate", (data) => forward("webrtc-candidate", data));
}
