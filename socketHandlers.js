import { pool } from "./db.js";
import { expForNextLevel } from "./utils.js";
import { songState } from "./song.js";
import { rooms } from "./chat.js";
import { AccessToken } from "livekit-server-sdk";

export function songSocket(io, socket) {
  // ===== 給唱歌超過 2 分鐘加 EXP =====
  async function giveExpForSinging(room, singer) {
    const state = songState[room];
    if (!state || !state.singStartTime) return;

    const MINUTE_2 = 2 * 60 * 1000;
    const expToAdd = 100;

    const duration = Date.now() - state.singStartTime;
    state.singStartTime = null; // ⭐ 清掉計時器 / 時間紀錄

    if (duration < MINUTE_2) return; // 未達 2 分鐘，不加

    try {
      const res = await pool.query(
        `
            SELECT u.id, urs.level, urs.exp
            FROM users u
            JOIN user_room_stats urs
            ON u.id = urs.user_id
            WHERE u.username = $1
            AND urs.room = $2
            `,
        [singer, room]
      );

      const dbUser = res.rows[0];
      if (!dbUser) return;

      let { level, exp } = dbUser;
      exp += expToAdd;

      while (level < 90 && exp >= expForNextLevel(level)) {
        exp -= expForNextLevel(level);
        level += 1;
      }
      await pool.query(
        `
            UPDATE user_room_stats
            SET level = $1, exp = $2
            WHERE user_id = $3 AND room = $4
            `,
        [level, exp, dbUser.id, room]
      );

      // 更新記憶體 rooms[room]
      if (rooms[room]) {
        const roomUser = rooms[room].find(u => u.name === singer);
        if (roomUser) {
          roomUser.level = level;
          roomUser.exp = exp;
        }
      }

      io.to(room).emit("updateUsers", rooms[room]);
      console.log(`[Debug] ${singer} +${expToAdd} EXP (唱歌超過 2 分鐘)`);
    } catch (err) {
      console.error("給 EXP 失敗：", err);
    }
  }

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
    state.currentScore = {
      total: 0,
      count: 0
    };
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
    state.singStartTime = Date.now();
    // 如果有人正在唱，先踢掉
    if (state.currentSingerSocketId && state.currentSingerSocketId !== socket.id) {
      io.to(state.currentSingerSocketId).emit("forceStopSing");
      state.queue.unshift({ name: state.currentSinger, socketId: state.currentSingerSocketId });
    }

    state.currentSinger = singer;
    state.currentSingerSocketId = socket.id;
    state.currentScore = {
      total: 0,
      count: 0
    };
    state.queue = state.queue.filter(u => u.socketId !== socket.id);

    broadcastMicState(room); // 全體更新

    // 發 token 給自己
    await sendLiveKitToken(socket.id, room, singer);
  });

  socket.on("adminMoveQueue", ({ room, fromIndex, toIndex }) => {
    const state = songState[room];
    if (!state) return;

    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= state.queue.length ||
      toIndex >= state.queue.length
    ) return;

    const item = state.queue.splice(fromIndex, 1)[0];
    state.queue.splice(toIndex, 0, item);

    broadcastMicState(room);
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
      giveExpForSinging(room, singer);
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
      giveExpForSinging(room, singer);
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
        giveExpForSinging(room, state.currentSinger);
        state.currentSinger = null;
        state.currentSingerSocketId = null;
        broadcastMicState(room);
        nextSinger(room);
      }

      // 從 queue 移除自己
      state.queue = state.queue.filter(u => u.socketId !== socket.id);
      console.log(`[Debug] 斷線: ${socket.id} in room ${room}`);
    }
  });

  socket.on("rateSinger", ({ room, singer, score }) => {
    const state = songState[room];
    if (!state) return;

    if (!state.currentSinger || state.currentSinger !== singer) return;
    if (!state.currentScore) return;
    if (score < 1 || score > 5) return;

    state.currentScore.total += score;
    state.currentScore.count += 1;

    const avg = (
      state.currentScore.total / state.currentScore.count
    ).toFixed(2);

    io.to(`song-${room}`).emit("scoreUpdate", {
      singer,
      average: avg,
      count: state.currentScore.count
    });
  });

}
