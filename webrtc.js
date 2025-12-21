// webrtc.js
export function webrtcHandlers(io, socket) {
  // 前端發 offer
  socket.on("webrtc-offer", ({ room, offer, to, sender }) => {
    const s = sender || socket.id;
    if (to) {
      const target = io.sockets.sockets.get(to);
      if (target) target.emit("webrtc-offer", { offer, from: s });
    } else socket.to(room).emit("webrtc-offer", { offer, from: s });
  });

  // answer
  socket.on("webrtc-answer", ({ room, answer, to, sender }) => {
    if (!to) return;
    const target = io.sockets.sockets.get(to);
    if (target) target.emit("webrtc-answer", { answer, from: sender || socket.data.name });
  });

  // ICE
  socket.on("webrtc-candidate", ({ room, candidate, to, sender }) => {
    const s = sender || socket.data.name;
    if (to) {
      const target = io.sockets.sockets.get(to);
      if (target) target.emit("webrtc-candidate", { candidate, from: s });
    } else socket.to(room).emit("webrtc-candidate", { candidate, from: s });
  });
}
