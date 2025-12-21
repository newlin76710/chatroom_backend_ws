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
    console.log("✅ start-singing emitted public");
  });

  // --- 停止唱歌 / 自動下一位 ---
  socket.on("stop-singing", ({ room, singer }) => {
    if (!songState[room]) return;
    const state = songState[room];
    if (state.currentSinger !== singer) return;

    state.currentSinger = null;
    socket.to(room).emit("user-stop-singing", { singer });
    console.log("🛑 stop-singing emitted public");

    if (state.scoreTimer) clearTimeout(state.scoreTimer);

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
      if (!Array.isArray(state.queue)) state.queue = [];
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
    if (!songState[room] || !songState[room].currentSinger) return;
    const singer = songState[room].currentSinger;

    if (!songState[room].scores[singer]) songState[room].scores[singer] = [];
    songState[room].scores[singer].push(score);
  });

  // --- 聽眾準備接收 WebRTC ---
  socket.on("listener-ready", ({ room, listenerId }) => {
    const singerId = songState[room]?.currentSinger;
    if (!singerId) return;

    // 告訴唱歌者建立 WebRTC 連線給這個聽眾
    io.to(singerId).emit("new-listener", { listenerId });
    console.log("👂 listener-ready:", listenerId);
  });
}

// -------------------------
// WebRTC 信令處理
// -------------------------
export function webrtcHandlers(io, socket) {
  // 唱歌者/聽眾都會用這三個事件
  socket.on("webrtc-offer", ({ room, offer, to, sender }) => {
    const s = sender || socket.id;
    if (to) {
      const target = io.sockets.sockets.get(to);
      if (target) target.emit("webrtc-offer", { offer, from: s });
    } else socket.to(room).emit("webrtc-offer", { offer, from: s });
  });

  socket.on("webrtc-answer", ({ room, answer, to, sender }) => {
    if (!to) return;
    const target = io.sockets.sockets.get(to);
    if (target) target.emit("webrtc-answer", { answer, from: sender || socket.data.name });
  });

  socket.on("webrtc-candidate", ({ room, candidate, to, sender }) => {
    const s = sender || socket.data.name;
    if (to) {
      const target = io.sockets.sockets.get(to);
      if (target) target.emit("webrtc-candidate", { candidate, from: s });
    } else socket.to(room).emit("webrtc-candidate", { candidate, from: s });
  });
}
