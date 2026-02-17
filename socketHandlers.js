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

    console.log(`[Debug] broadcastMicState for room "${room}": currentSinger=${state.currentSinger} queue=${state.queue.map(u => u.name)}`);
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

  function nextSinger(room) {
    const state = songState[room];
    if (!state) return;

    if (state.currentSinger) return; // 有人在唱就不動

    const next = state.queue.shift();
    if (!next) {
      broadcastMicState(room);
      return;
    }

    state.currentSinger = next.name;
    state.currentSingerSocketId = next.socketId;

    // ⭐ 通知他輪到你
    io.to(next.socketId).emit("yourTurn", {});

    broadcastMicState(room);
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

    console.log(`[Debug] ${name} 進入 song room ${room}`);
  });

  socket.on("joinQueue", ({ room, name }) => {
    if (!songState[room])
      songState[room] = { queue: [], currentSinger: null, currentSingerSocketId: null };

    const state = songState[room];

    // 已在 queue 不重複加入
    if (state.queue.find(u => u.socketId === socket.id)) return;

    state.queue.push({
      name,
      socketId: socket.id,
    });

    broadcastMicState(room);
  });
  socket.on("leaveQueue", ({ room, name }) => {
    const state = songState[room];
    if (!state) return;

    state.queue = state.queue.filter(u => u.socketId !== socket.id);
    broadcastMicState(room);
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

  socket.on("forceStopSinger", ({ room, singer }) => {
    const state = songState[room];
    if (!state) return;

    // 找到要踢的 socketId
    const target = state.queue.find(u => u.name === singer) ||
      (state.currentSinger === singer ? { socketId: state.currentSingerSocketId } : null);

    if (!target || !target.socketId) return;

    console.log(`[Debug] 管理員踢下麥: ${singer} in room ${room}`);

    // 如果是正在唱的，直接 force stop
    if (state.currentSinger === singer) {
      io.to(target.socketId).emit("forceStopSing");
      state.currentSinger = null;
      state.currentSingerSocketId = null;
      nextSinger(room);
    }
    // 如果在 queue 中，直接從 queue 移除
    state.queue = state.queue.filter(u => u.name !== singer);
    // 全體更新
    broadcastMicState(room); // 全體更新
  });

  socket.on("stopSing", ({ room, singer }) => {
    const state = songState[room];
    if (!state) return;

    if (state.currentSinger === singer) {
      state.currentSinger = null;
      state.currentSingerSocketId = null;
      broadcastMicState(room); // 全體更新
      nextSinger(room);
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
        nextSinger(room);
      }

      // 從 queue 移除自己
      state.queue = state.queue.filter(u => u.socketId !== socket.id);
    }
  });
}
