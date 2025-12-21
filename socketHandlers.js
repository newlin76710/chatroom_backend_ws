import { songState } from "./song.js";
import { callAISongComment } from "./ai.js";

export function songSocket(io, socket) {
  socket.on("start-singing", ({ room, singer }) => {
    if (!songState[room]) songState[room] = { queue: [], currentSinger: null, scores: {}, listeners: [], scoreTimer: null };
    const state = songState[room];
    if (state.currentSinger) return;
    state.currentSinger = singer;
    if (!state.scores[singer]) state.scores[singer] = [];

    socket.join(room);
    io.to(room).emit("user-start-singing", { singer });
  });

  socket.on("stop-singing", ({ room, singer }) => {
    const state = songState[room];
    if (!state || state.currentSinger !== singer) return;
    state.currentSinger = null;

    io.to(room).emit("user-stop-singing", { singer });

    if (state.scoreTimer) clearTimeout(state.scoreTimer);

    const scores = state.scores[singer] || [];
    const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 0;
    io.to(room).emit("songResult", { singer, avg, count: scores.length });

    callAISongComment({ singer, avg })
      .then(comment => io.to(room).emit("message", comment))
      .catch(console.error);

    // 踢出所有聽眾
    if (Array.isArray(state.listeners)) {
      state.listeners.forEach(id => {
        const socketObj = io.sockets.sockets.get(id);
        if (socketObj) socketObj.emit("listener-left", { listenerId: id });
      });
    }
    state.listeners = [];
    io.to(room).emit("update-listeners", { listeners: [] });
  });

  socket.on("scoreSong", ({ room, score }) => {
    const state = songState[room];
    if (!state || !state.currentSinger) return;
    const singer = state.currentSinger;
    if (!state.scores[singer]) state.scores[singer] = [];
    state.scores[singer].push(score);
    socket.emit("scoreAck", { singer, score });
  });

  socket.on("listener-ready", ({ room, listenerId }) => {
    if (!songState[room]) songState[room] = { queue: [], currentSinger: null, scores: {}, listeners: [], scoreTimer: null };
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
    state.listeners = state.listeners.filter(id => id !== listenerId);

    const singerId = state.currentSinger;
    if (singerId) io.to(singerId).emit("listener-left", { listenerId });

    io.to(room).emit("update-listeners", { listeners: state.listeners });
  });
}

export function webrtcHandlers(io, socket) {
  function forward(event, data) {
    if (!data.to) return;
    const target = io.sockets.sockets.get(data.to);
    if (target) target.emit(event, { ...data, from: socket.id });
  }

  socket.on("webrtc-offer", data => forward("webrtc-offer", data));
  socket.on("webrtc-answer", data => forward("webrtc-answer", data));
  socket.on("webrtc-candidate", data => forward("webrtc-candidate", data));
}
