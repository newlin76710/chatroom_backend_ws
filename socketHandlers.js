import { songState } from "./song.js";
import { AccessToken } from "livekit-server-sdk";

export function songSocket(io, socket) {

  function broadcastMicState(room) {
    const state = songState[room];
    if (!state) return;

    io.to(`song-${room}`).emit("micStateUpdate", {
      queue: state.queue.map(u => u.name),
      currentSinger: state.currentSinger || null,
    });

    console.log(`[Debug] broadcastMicState for room "${room}": currentSinger=${state.currentSinger}`);
  }

  async function sendLiveKitToken(socketId, room, identity) {
    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity, ttl: 600 }
    );

    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await token.toJwt();
    io.to(socketId).emit("livekit-token", { token: jwt, identity });
  }

  socket.on("joinRoom", ({ room, name }) => {
    if (!songState[room]) songState[room] = { queue: [], currentSinger: null };

    socket.join(`song-${room}`);

    // 新進的人立即收到當前演唱者
    const state = songState[room];
    socket.emit("micStateUpdate", {
      queue: state.queue.map(u => u.name),
      currentSinger: state.currentSinger || null
    });

    console.log(`[Debug] ${name} 加入 song room ${room}`);
  });

  socket.on("grabMic", async ({ room, singer }) => {
    if (!songState[room]) songState[room] = { queue: [], currentSinger: null, currentSingerSocketId: null };
    const state = songState[room];

    // 如果有人正在唱，先踢掉
    if (state.currentSingerSocketId && state.currentSingerSocketId !== socket.id) {
      io.to(state.currentSingerSocketId).emit("forceStopSing");
      state.queue.unshift({ name: state.currentSinger, socketId: state.currentSingerSocketId });
    }

    state.currentSinger = singer;
    state.currentSingerSocketId = socket.id;
    state.queue = state.queue.filter(u => u.socketId !== socket.id);

    broadcastMicState(room); // 全體更新

    // 發 token 給自己
    await sendLiveKitToken(socket.id, room, singer);
  });

  socket.on("stopSing", ({ room, singer }) => {
    const state = songState[room];
    if (!state) return;

    if (state.currentSinger === singer) {
      state.currentSinger = null;
      state.currentSingerSocketId = null;
      broadcastMicState(room); // 全體更新
    }
  });

  socket.on("disconnect", () => {
    for (const room in songState) {
      const state = songState[room];
      if (!state) continue;

      if (state.currentSingerSocketId === socket.id) {
        state.currentSinger = null;
        state.currentSingerSocketId = null;
        broadcastMicState(room);
      }

      // 從 queue 移除自己
      state.queue = state.queue.filter(u => u.socketId !== socket.id);
    }
  });
}
