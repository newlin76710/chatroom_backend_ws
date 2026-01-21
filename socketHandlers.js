// socketHandlers.js
import { songState } from "./song.js";

export function songSocket(io, socket) {

  // ===== 廣播當前隊列與拿麥克風的人 =====
  function broadcastMicState(room) {
    const state = songState[room];
    if (!state) return;
    console.log(`[broadcastMicState] room=${room}, currentSinger=${state.currentSinger}, queue=[${state.queue.map(u => u.name).join(", ")}]`);
    io.to(room).emit("micStateUpdate", {
      queue: state.queue.map(u => u.name),
      currentSinger: state.currentSinger || null
    });
  }

  // ===== 播放下一位歌手 =====
  function playNextSinger(room) {
    const state = songState[room];
    if (!state || !state.queue.length) return;

    const nextSinger = state.queue.shift();
    state.currentSinger = nextSinger.name;
    state.currentSingerSocketId = nextSinger.socketId;

    console.log(`[playNextSinger] Next singer=${nextSinger.name} in room=${room}`);

    broadcastMicState(room);

    // 通知下一位開始唱
    io.to(nextSinger.socketId).emit("update-room-phase", { phase: "singing", singer: nextSinger.name });

    // 其他人在聽
    state.queue.forEach(u => {
      io.to(u.socketId).emit("update-room-phase", { phase: "listening", singer: nextSinger.name });
    });
  }

  // ===== 加入隊列 =====
  socket.on("joinQueue", ({ room, singer }) => {
    if (!songState[room]) songState[room] = { queue: [], currentSinger: null, currentSingerSocketId: null, scores: {}, scoreTimer: null };
    const state = songState[room];

    if (!state.queue.find(u => u.name === singer) && state.currentSinger !== singer) {
      state.queue.push({ name: singer, socketId: socket.id });
      console.log(`[joinQueue] ${singer} joined queue in room=${room}`);
    }

    if (!state.currentSinger) playNextSinger(room);
    else broadcastMicState(room);
  });

  // ===== 離開隊列 =====
  socket.on("leaveQueue", ({ room, singer }) => {
    const state = songState[room];
    if (!state) return;

    state.queue = state.queue.filter(u => u.name !== singer);
    console.log(`[leaveQueue] ${singer} left queue in room=${room}`);

    if (state.currentSinger === singer) {
      if (state.scoreTimer) clearTimeout(state.scoreTimer);
      state.currentSinger = null;
      state.currentSingerSocketId = null;
      if (state.queue.length > 0) playNextSinger(room);
      else broadcastMicState(room);
    } else {
      broadcastMicState(room);
    }
  });

  // ===== 錄音完成後通知 =====
  socket.on("songReady", ({ room, singer, url, duration }) => {
    const state = songState[room];
    if (!state) return;

    state.currentSinger = singer;
    state.currentSingerSocketId = socket.id;
    state.scores[singer] = [];

    console.log(`[songReady] ${singer} ready to play in room=${room}, duration=${duration}s`);

    io.to(room).emit("playSong", { url, duration, singer });
    broadcastMicState(room);

    if (state.scoreTimer) clearTimeout(state.scoreTimer);
    state.scoreTimer = setTimeout(() => {
      const scores = state.scores[singer] || [];
      const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      io.to(room).emit("songResult", { avg, count: scores.length });

      state.currentSinger = null;
      state.currentSingerSocketId = null;
      state.scoreTimer = null;

      if (state.queue.length > 0) playNextSinger(room);
      else broadcastMicState(room);
    }, duration * 1000);
  });

  // ===== 評分 =====
  socket.on("scoreSong", ({ room, score }) => {
    const state = songState[room];
    if (!state || !state.currentSinger) return;
    const singer = state.currentSinger;
    if (!state.scores[singer]) state.scores[singer] = [];
    state.scores[singer].push(score);
    console.log(`[scoreSong] ${singer} got score=${score} in room=${room}`);
  });

  // ===== 斷線清理 =====
  socket.on("disconnect", () => {
    console.log(`[socket] ${socket.id} disconnected`);
    for (const room in songState) {
      const state = songState[room];
      if (!state) continue;

      const wasInQueue = state.queue.find(u => u.socketId === socket.id);
      state.queue = state.queue.filter(u => u.socketId !== socket.id);

      if (state.currentSingerSocketId === socket.id) {
        console.log(`[disconnect] current singer ${state.currentSinger} disconnected in room=${room}`);
        if (state.scoreTimer) clearTimeout(state.scoreTimer);
        state.currentSinger = null;
        state.currentSingerSocketId = null;
        if (state.queue.length > 0) playNextSinger(room);
        else broadcastMicState(room);
      } else if (wasInQueue) {
        broadcastMicState(room);
      }
    }
  });

  // ===== WebRTC =====
  socket.on("webrtc-offer", ({ room, offer, singer }) => socket.to(room).emit("webrtc-offer", { offer, singer }));
  socket.on("webrtc-answer", ({ room, answer }) => socket.to(room).emit("webrtc-answer", { answer }));
  socket.on("webrtc-ice", ({ room, candidate }) => socket.to(room).emit("webrtc-ice", { candidate }));
  socket.on("webrtc-stop", ({ room }) => socket.to(room).emit("webrtc-stop"));
}
