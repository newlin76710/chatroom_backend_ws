// songWebRTC.js
import { songState } from "./song.js";
import { callAISongComment } from "./ai.js";

export function songSocket(io, socket) {
  // --- 開始唱歌 ---
  socket.on("start-singing", ({ room, singer }) => {
    if (!songState[room]) songState[room] = { queue: [], currentSinger: null, scores: {}, scoreTimer: null };
    const state = songState[room];

    if (state.currentSinger) return; // 已有人在唱
    state.currentSinger = singer;
    if (!state.scores[singer]) state.scores[singer] = [];

    socket.to(room).emit("user-start-singing", { singer });
    console.log("✅ start-singing emitted public", singer);
  });

  // --- 停止唱歌 / 自動下一位 ---
  socket.on("stop-singing", ({ room, singer }) => {
    const state = songState[room];
    if (!state || state.currentSinger !== singer) return;

    state.currentSinger = null;
    socket.to(room).emit("user-stop-singing", { singer });
    console.log("🛑 stop-singing emitted public", singer);

    if (state.scoreTimer) clearTimeout(state.scoreTimer);

    // 計算分數
    state.scoreTimer = setTimeout(async () => {
      const scores = state.scores[singer] || [];
      const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 0;

      io.to(room).emit("songResult", { singer, avg, count: scores.length });

      try {
        const aiComment = await callAISongComment({ singer, avg });
        io.to(room).emit("message", aiComment);
      } catch(err) {
        console.error("AI song comment error:", err);
      }

      // 播放下一位
      if (state.queue.length > 0) {
        const next = state.queue.shift();
        state.currentSinger = next;
        state.scores[next] = state.scores[next] || [];
        io.to(room).emit("next-singer", { singer: next });
        io.to(room).emit("user-start-singing", { singer: next });

        state.scoreTimer = setTimeout(() => {
          socket.emit("stop-singing", { room, singer: next });
        }, 15000);
      } else {
        state.currentSinger = null;
        io.to(room).emit("updateSingingStatus", { currentSinger: null });
      }
    }, 15000);
  });

  // --- 接收評分 ---
  socket.on("scoreSong", ({ room, score }) => {
    const state = songState[room];
    if (!state || !state.currentSinger) return;
    const singer = state.currentSinger;
    if (!state.scores[singer]) state.scores[singer] = [];
    state.scores[singer].push(score);
    console.log(`[🎵 評分] ${singer} +${score}`);
  });

  // --- 聽眾準備接收 WebRTC ---
  socket.on("listener-ready", ({ room, listenerId }) => {
    const singerId = songState[room]?.currentSinger;
    if (!singerId) return;

    // 告訴唱歌者建立 WebRTC 連線給這個聽眾
    io.to(singerId).emit("new-listener", { listenerId });
    console.log("👂 listener-ready:", listenerId, "→ 通知唱歌者", singerId);
  });
  // --- 聽眾取消聽歌 ---
  socket.on("stop-listening", ({ room, listenerId }) => {
    if (!songState[room]) return;
    const state = songState[room];
    state.listeners = state.listeners.filter((id) => id !== listenerId);

    // 通知唱歌者移除對應 PC
    io.to(state.currentSinger).emit("remove-listener", { listenerId });
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
