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

    console.log(`[Debug] ${name} 進入 song room ${room}`);
  });

  socket.on("grabMic", async ({ room, singer }) => {
    const state = songState[room];
    if (!state) return;

    const first = state.queue[0];

    // 只有排第一位才可以上麥
    if (!first || first.socketId !== socket.id) {
      console.log("[Song] 非法 grabMic");
      return;
    }

    // 正式移除 queue 第一位
    state.queue.shift();

    state.currentSinger = singer;
    state.currentSingerSocketId = socket.id;

    broadcastMicState(room);

    await sendLiveKitToken(socket.id, room, singer);
  });


  function nextSinger(room) {
    const state = songState[room];
    if (!state || state.currentSinger || !state.queue.length) return;

    const next = state.queue[0]; // ⭐ 不 shift

    io.to(next.socketId).emit("yourTurnToSing", {
      room,
      singer: next.name,
    });

    console.log(`[Song] 通知 ${next.name} 上麥`);
  }


  socket.on("joinQueue", ({ room, name }) => {
    if (!songState[room]) {
      songState[room] = {
        queue: [],
        currentSinger: null,
        currentSingerSocketId: null,
      };
    }

    const state = songState[room];

    // 已經在唱 → 不能排
    if (state.currentSingerSocketId === socket.id) {
      return;
    }

    // 已經在 queue → 不重複加入
    const alreadyInQueue = state.queue.find(
      (u) => u.socketId === socket.id
    );
    if (alreadyInQueue) {
      return;
    }

    // 加入排隊
    state.queue.push({
      name,
      socketId: socket.id,
    });

    console.log(`[Song] ${name} 加入排隊 room=${room}`);

    // 廣播排隊狀態
    broadcastMicState(room);

    // 如果現在沒人在唱 → 嘗試叫下一位
    nextSinger(room);
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
