import { pool } from "./db.js";
import { expForNextLevel } from "./utils.js";
import { rooms, pendingReconnect } from "./chat.js";
import { AccessToken } from "livekit-server-sdk";

export const pendingMicReconnect = new Map(); // 斷線暫存 10 秒
export const forceStopSet = new Set(); // 強制踢的人 socketId
export const songState = {};
export function getRoomState(room) {
  if (!songState[room]) {
    songState[room] = {
      queue: [],
      currentSinger: null,
      currentSingerSocketId: null,
      singStartTime: null,
      currentScore: null,
      scoreTimer: null
    };
  }
  return songState[room];
}

export function songSocket(io, socket) {
  // ===== 給唱歌超過 2 分鐘加 EXP =====
  async function giveExpForSinging(room, singer) {
    const state = songState[room];
    if (!state || !state.singStartTime) return;

    const MINUTE_2 = 2 * 60 * 1000;
    const expToAdd = 100;
    const applesToAdd = 2; // ⭐ 每次唱歌給 2 顆金蘋果

    const duration = Date.now() - state.singStartTime;
    state.singStartTime = null; // 清掉計時器 / 時間紀錄

    if (duration < MINUTE_2) return; // 未達 2 分鐘，不加

    try {
      const res = await pool.query(
        `
    SELECT u.id, urs.level, urs.exp
    FROM users u
    JOIN user_room_stats urs ON u.id = urs.user_id
    WHERE u.username = $1 AND urs.room = $2
    `,
        [singer, room]
      );

      const dbUser = res.rows[0];
      if (!dbUser) return;

      let { level, exp } = dbUser;

      // ⭐ EXP 計算
      exp += expToAdd;

      while (level < 90 && exp >= expForNextLevel(level)) {
        exp -= expForNextLevel(level);
        level += 1;
      }

      // ✅ 1️⃣ 只更新 level / exp
      await pool.query(
        `
    UPDATE user_room_stats
    SET level = $1, exp = $2
    WHERE user_id = $3 AND room = $4
    `,
        [level, exp, dbUser.id, room]
      );

      // ✅ 2️⃣ 金蘋果用「累加」
      await pool.query(
        `
    UPDATE user_room_stats
    SET gold_apples = gold_apples + $1
    WHERE user_id = $2 AND room = $3
    `,
        [applesToAdd, dbUser.id, room]
      );

      // ✅ 3️⃣ log（這你原本就對）
      await pool.query(
        `
    INSERT INTO gift_logs 
    (room, sender, receiver, receiver_id, item_type, amount, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `,
        [room, 'system', singer, dbUser.id, 'gold_apples', applesToAdd]
      );

      // 🔹 更新記憶體（用 +，不要覆蓋）
      if (rooms[room]) {
        const roomUser = rooms[room].find(u => u.name === singer);
        if (roomUser) {
          roomUser.level = level;
          roomUser.exp = exp;
          roomUser.gold_apples = (roomUser.gold_apples || 0) + applesToAdd;
        }
      }

      io.to(room).emit("updateUsers", rooms[room]);

      console.log(`[Debug] ${singer} +${expToAdd} EXP, +${applesToAdd} 🍎`);

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
  function clearSingerTimer(state) {
    if (state.scoreTimer) {
      clearTimeout(state.scoreTimer);
      state.scoreTimer = null;
    }
  }
  function nextSinger(room) {
    const state = songState[room];
    if (!state) return;
    clearSingerTimer(state);
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
    socket.data = { name, room };
    socket.join(`song-${room}`);
    const state = getRoomState(room);

    // 如果 10 秒內重連，清掉暫存 timer
    const oldTimer = pendingMicReconnect.get(name);
    if (oldTimer) {
      clearTimeout(oldTimer);
      pendingMicReconnect.delete(name);
    }

    // 更新 socketId
    state.queue.forEach(u => { if (u.name === name) u.socketId = socket.id; });
    if (state.currentSinger === name) state.currentSingerSocketId = socket.id;

    broadcastMicState(room);
  });

  socket.on("joinQueue", ({ room, name }) => {
    if (!songState[room]) getRoomState(room);

    const state = songState[room];

    const existing = state.queue.find(u => u.name === name);

    if (existing) {
      existing.socketId = socket.id;
      console.log(`[Debug] 重連只更新 socket ${name} 加入 song queue ${room}`);
      return;
    }
    state.queue.push({
      name,
      socketId: socket.id,
    });
    console.log(`[Debug] ${name} 加入 song queue ${room}`);
    // ⭐⭐⭐ 加這段
    if (!state.currentSinger) {
      nextSinger(room);
    } else {
      broadcastMicState(room);
    }
  });
  socket.on("leaveQueue", ({ room, name }) => {
    const state = songState[room];
    if (!state) return;

    state.queue = state.queue.filter(u => u.name !== name);
    if (!state.currentSinger) {
      nextSinger(room);
    } else {
      broadcastMicState(room);
    }
  });

  socket.on("grabMic", async ({ room, singer }) => {
    if (!songState[room]) getRoomState(room);
    const state = songState[room];
    state.singStartTime = Date.now();
    clearSingerTimer(state);
    state.scoreTimer = setTimeout(() => {
      if (state.currentSinger === singer) {
        giveExpForSinging(room, singer);

        state.currentSinger = null;
        state.currentSingerSocketId = null;

        io.to(`song-${room}`).emit("systemMessage", {
          message: `${singer} 唱歌時間已達 8 分鐘，自動下麥`
        });

        broadcastMicState(room);
        nextSinger(room);
      }
    }, 8 * 60 * 1000); // 8 分鐘
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
    if (!songState[room]) getRoomState(room);
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

    let target = state.queue.find(u => u.name === singer && u.socketId) ||
      (state.currentSinger === singer ? { socketId: state.currentSingerSocketId } : null);

    if (!target?.socketId) return;

    // 立即踢，不管暫存
    forceStopSet.add(target.socketId);

    if (state.currentSinger === singer) {
      clearSingerTimer(state);
      giveExpForSinging(room, singer);
      state.currentSinger = null;
      state.currentSingerSocketId = null;
      nextSinger(room);
    }

    state.queue = state.queue.filter(u => u.name !== singer);
    broadcastMicState(room);
  });

  socket.on("stopSing", ({ room, singer }) => {
    if (!songState[room]) getRoomState(room);
    const state = songState[room];
    if (!state) return;
    clearSingerTimer(state);
    if (state.currentSinger === singer) {
      giveExpForSinging(room, singer);
      state.currentSinger = null;
      state.currentSingerSocketId = null;
      broadcastMicState(room); // 全體更新
      nextSinger(room);
    }
  });

  socket.on("disconnect", () => {
    const { name, room } = socket.data || {};
    if (!name || !room) return;
    const state = songState[room];
    if (!state) return;

    // 先檢查是否被 forceStop
    if (forceStopSet.has(socket.id)) {
      forceStopSet.delete(socket.id);
      return; // 已被踢，不用暫存
    }

    // 上麥的人
    if (state.currentSinger === name && state.currentSingerSocketId === socket.id) {
      // 設定 10 秒暫存
      const timer = setTimeout(() => {
        // 10 秒沒回來才清掉
        state.currentSinger = null;
        state.currentSingerSocketId = null;
        nextSinger(room);
        broadcastMicState(room);
        pendingMicReconnect.delete(name);
      }, 10000);

      pendingMicReconnect.set(name, timer);
    }

    // 排麥的人
    state.queue.forEach(u => {
      if (u.name === name && u.socketId === socket.id) {
        const timer = setTimeout(() => {
          state.queue = state.queue.filter(q => q.name !== name);
          broadcastMicState(room);
          pendingMicReconnect.delete(name);
        }, 10000);

        pendingMicReconnect.set(name, timer);
        u.socketId = null; // 暫時清掉 socketId，保留順序
      }
    });

    broadcastMicState(room);
  });

  socket.on("rateSinger", ({ room, singer, score }) => {
    if (!songState[room]) getRoomState(room);
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
