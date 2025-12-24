import { songState } from "./song.js";

export function songSocket(io, socket) {

  // 加入隊列
  socket.on("joinQueue", ({ room, singer }) => {
    if (!songState[room]) songState[room] = { queue: [], currentSinger: null, scores: {} };
    const state = songState[room];

    if (!state.queue.includes(singer) && state.currentSinger !== singer) {
      state.queue.push(singer);
    }

    // 如果沒人在唱歌，自動下一位
    if (!state.currentSinger && state.queue.length > 0) {
      playNextSinger(room, io);
    } else {
      io.to(room).emit("queueUpdate", { queue: state.queue, current: state.currentSinger });
    }
  });

  // 錄音完成後通知
  socket.on("songReady", ({ room, singer, url, duration }) => {
    const state = songState[room];
    if (!state) return;
    state.currentSinger = singer;
    state.scores[singer] = [];

    // 廣播給房間其他人播放
    io.to(room).emit("playSong", { url, duration, singer });

    // 開始倒數評分
    if (state.scoreTimer) clearTimeout(state.scoreTimer);
    state.scoreTimer = setTimeout(() => {
      const scores = state.scores[singer] || [];
      const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      io.to(room).emit("songResult", { avg, count: scores.length });

      state.currentSinger = null;
      state.scoreTimer = null;

      // 自動下一位
      if (state.queue.length > 0) playNextSinger(room, io);

    }, duration * 1000);
  });

  // 評分
  socket.on("scoreSong", ({ room, score }) => {
    const state = songState[room];
    if (!state || !state.currentSinger) return;
    const singer = state.currentSinger;
    if (!state.scores[singer]) state.scores[singer] = [];
    state.scores[singer].push(score);
  });

  // 離開房間
  socket.on("leaveQueue", ({ room, singer }) => {
    const state = songState[room];
    if (!state) return;
    state.queue = state.queue.filter(s => s !== singer);
  });

  // 斷線清理
  socket.on("disconnect", () => {
    for (const room in songState) {
      const state = songState[room];
      if (!state) continue;
      state.queue = state.queue.filter(s => s !== socket.id);
      if (state.currentSinger === socket.id) state.currentSinger = null;
    }
  });

}

// 播放下一位歌手
function playNextSinger(room, io) {
  const state = songState[room];
  if (!state || !state.queue.length) return;

  const nextSinger = state.queue.shift();
  state.currentSinger = nextSinger;
  io.to(room).emit("queueUpdate", { queue: state.queue, current: nextSinger });
  io.to(nextSinger).emit("update-room-phase", { phase: "recording" });
  io.to(room).except(nextSinger).emit("update-room-phase", { phase: "listening", singer: nextSinger });
}
