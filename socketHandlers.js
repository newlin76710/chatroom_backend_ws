// songSocket.js
import { songState } from "./song.js";
import { callAISongComment } from "./ai.js";

export function songSocket(io, socket) {
  // =========================
  // 開始唱歌
  // =========================
  socket.on("start-singing", ({ room, singer }) => {
    if (!songState[room]) {
      songState[room] = {
        queue: [],
        currentSinger: null,
        scores: {},
        listeners: [],
        scoreTimer: null,
      };
    }
    const state = songState[room];

    if (state.currentSinger) return; // 已有人在唱
    state.currentSinger = singer;
    if (!state.scores[singer]) state.scores[singer] = [];

    socket.join(room); // 確保在同房間
    io.to(room).emit("user-start-singing", { singer });
    console.log("✅ start-singing emitted public", singer);
  });

  // =========================
  // 停止唱歌
  // =========================
  socket.on("stop-singing", ({ room, singer }) => {
    const state = songState[room];
    if (!state || state.currentSinger !== singer) return;

    state.currentSinger = null;

    // 通知房間停止唱歌
    io.to(room).emit("user-stop-singing", { singer });
    console.log("🛑 stop-singing emitted public", singer);

    if (state.scoreTimer) clearTimeout(state.scoreTimer);

    // 處理評分
    const scores = state.scores[singer] || [];
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    io.to(room).emit("songResult", { singer, avg, count: scores.length });

    callAISongComment({ singer, avg })
      .then((aiComment) => io.to(room).emit("message", aiComment))
      .catch((err) => console.error("AI song comment error:", err));

    // 踢出所有聽眾
    if (Array.isArray(state.listeners)) {
      state.listeners.forEach((listenerId) => {
        io.to(listenerId).emit("listener-left", { listenerId });
      });
    }
    state.listeners = [];
    io.to(room).emit("update-listeners", { listeners: [] });
  });

  // =========================
  // 接收評分
  // =========================
  socket.on("scoreSong", ({ room, score }) => {
    const state = songState[room];
    if (!state || !state.currentSinger) return;

    const singer = state.currentSinger;
    if (!state.scores[singer]) state.scores[singer] = [];
    state.scores[singer].push(score);

    socket.emit("scoreAck", { singer, score });
    console.log(`[評分] ${socket.id} 給 ${singer} 評分 ${score}`);
  });

  // =========================
  // 聽眾準備接收 WebRTC
  // =========================
  socket.on("listener-ready", ({ room, listenerId }) => {
    if (!songState[room]) {
      songState[room] = {
        queue: [],
        currentSinger: null,
        scores: {},
        listeners: [],
        scoreTimer: null,
      };
    }

    const state = songState[room];
    if (!Array.isArray(state.listeners)) state.listeners = [];
    if (!state.listeners.includes(listenerId)) state.listeners.push(listenerId);

    const singerId = state.currentSinger;
    if (singerId) io.to(singerId).emit("new-listener", { listenerId });

    io.to(room).emit("update-listeners", { listeners: state.listeners });
  });

  socket.on("stop-listening", ({ room, listenerId }) => {
    const state = songState[room];
    if (!state || !Array.isArray(state.listeners)) return;

    state.listeners = state.listeners.filter((id) => id !== listenerId);

    const singerId = state.currentSinger;
    if (singerId) io.to(singerId).emit("listener-left", { listenerId });

    io.to(room).emit("update-listeners", { listeners: state.listeners });
    console.log("🛑 stop-listening:", listenerId);
  });

}

// =========================
// WebRTC 信令處理
// =========================
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
