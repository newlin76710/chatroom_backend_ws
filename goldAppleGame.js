// goldAppleGame.js — 撈金蘋果遊戲（兩種模式）
// 遊戲一：多顆金蘋果，搶多少拿多少，共1分鐘
// 遊戲二：一顆大金蘋果，第一個點到的人獲得全部獎勵

import { pool } from "./db.js";
import { rooms } from "./chat.js";
import { ioTokens } from "./auth.js";

const ROOM = process.env.ROOMNAME || 'windsong';
const TW_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8

// ─── Module-level io reference ───────────────────────────────────────────────
let _io = null;

// ─── Game state ───────────────────────────────────────────────────────────────
let game1State = null; // { active, apples, catches, reward, timer }
let game2State = null; // { active, winner, winTime, reward, timer }

// ─── Schedule timers ─────────────────────────────────────────────────────────
let game1ScheduleTimer = null;
let game2ScheduleTimer = null;
let game1WarnTimer = null;
let game2WarnTimer = null;

// ─── DB Schema ────────────────────────────────────────────────────────────────
async function ensureSchema() {
  // 遊戲設定欄位加到 room_settings
  const cols = [
    ['game1_enabled',      'BOOLEAN DEFAULT true'],
    ['game1_hour',         'INT DEFAULT 20'],
    ['game1_minute',       'INT DEFAULT 30'],
    ['game1_apple_count',  'INT DEFAULT 5'],
    ['game1_reward',       'INT DEFAULT 1'],
    ['game2_enabled',      'BOOLEAN DEFAULT true'],
    ['game2_hour',         'INT DEFAULT 20'],
    ['game2_minute',       'INT DEFAULT 35'],
    ['game2_reward',       'INT DEFAULT 25'],
  ];
  for (const [col, def] of cols) {
    await pool.query(
      `ALTER TABLE room_settings ADD COLUMN IF NOT EXISTS ${col} ${def}`
    );
  }

  // 遊戲紀錄表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_game_logs (
      id           SERIAL PRIMARY KEY,
      room         VARCHAR NOT NULL,
      game_type    SMALLINT NOT NULL,   -- 1 or 2
      started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at     TIMESTAMPTZ,
      result       JSONB                -- game1: { catches:{user:count} }, game2: { winner }
    )
  `);
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function getGameSettings() {
  const res = await pool.query(
    `SELECT
       COALESCE(game1_enabled,      true) AS game1_enabled,
       COALESCE(game1_hour,         20)   AS game1_hour,
       COALESCE(game1_minute,       30)   AS game1_minute,
       COALESCE(game1_apple_count,  5)    AS game1_apple_count,
       COALESCE(game1_reward,       1)    AS game1_reward,
       COALESCE(game2_enabled,      true) AS game2_enabled,
       COALESCE(game2_hour,         20)   AS game2_hour,
       COALESCE(game2_minute,       35)   AS game2_minute,
       COALESCE(game2_reward,       25)   AS game2_reward
     FROM room_settings WHERE room = $1`,
    [ROOM]
  );
  return res.rows[0] || {
    game1_enabled: true, game1_hour: 20, game1_minute: 30,
    game1_apple_count: 5, game1_reward: 1,
    game2_enabled: true, game2_hour: 20, game2_minute: 35, game2_reward: 25,
  };
}

// ─── Award gold apples ────────────────────────────────────────────────────────
async function awardGold(username, amount, gameType) {
  try {
    const userRes = await pool.query(
      `SELECT u.id FROM users u
       JOIN user_room_stats urs ON u.id = urs.user_id
       WHERE u.username = $1 AND urs.room = $2`,
      [username, ROOM]
    );
    if (!userRes.rows.length) return false;
    const userId = userRes.rows[0].id;

    await pool.query(
      `UPDATE user_room_stats SET gold_apples = gold_apples + $1
       WHERE user_id = $2 AND room = $3`,
      [amount, userId, ROOM]
    );

    await pool.query(
      `INSERT INTO gift_logs (room, sender, receiver, receiver_id, item_type, amount, created_at)
       VALUES ($1, $2, $3, $4, 'gold_apples', $5, NOW())`,
      [ROOM, `system_game${gameType}`, username, userId, amount]
    );

    // 更新記憶體
    if (rooms[ROOM]) {
      const u = rooms[ROOM].find(u => u.name === username);
      if (u) u.gold_apples = (u.gold_apples || 0) + amount;
    }
    return true;
  } catch (err) {
    console.error('[GoldGame] awardGold error:', err);
    return false;
  }
}

// ─── Schedule helpers ─────────────────────────────────────────────────────────
/** 計算下一次「台灣時間 hour:minute」的 UTC 毫秒時間戳 */
function getNextTWTime(hour, minute) {
  const now = Date.now();
  // 取得台灣今日日期元件（UTC+8）
  const twNow = new Date(now + TW_OFFSET_MS);
  const twYear  = twNow.getUTCFullYear();
  const twMonth = twNow.getUTCMonth();
  const twDay   = twNow.getUTCDate();

  // 台灣 hour:minute 轉換為 UTC（hour - 8）
  // Date.UTC 會自動處理負小時（往前滾到前一天）
  const todayUTC = Date.UTC(twYear, twMonth, twDay, hour - 8, minute, 0, 0);

  // 至少還有 10 秒才觸發，否則排明天
  return todayUTC > now + 10000 ? todayUTC : todayUTC + 24 * 60 * 60 * 1000;
}

function scheduleGame1(io) {
  clearTimeout(game1ScheduleTimer);
  clearTimeout(game1WarnTimer);

  getGameSettings().then(settings => {
    if (!settings.game1_enabled) {
      console.log('[GoldGame1] 已停用，不排程');
      return;
    }

    const targetUTC = getNextTWTime(settings.game1_hour, settings.game1_minute);
    const delay     = targetUTC - Date.now();
    const twStr     = new Date(targetUTC).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    console.log(`[GoldGame1] 下次開始: ${twStr}（${Math.round(delay / 60000)} 分後）`);

    // 提前30秒預告
    if (delay > 30000) {
      game1WarnTimer = setTimeout(() => {
        io.to(ROOM).emit('systemMessage', '⏰ 撈金蘋果遊戲將在 30 秒後開始！準備好了嗎？');
      }, delay - 30000);
    }

    game1ScheduleTimer = setTimeout(() => startGame1(io, settings), delay);
  }).catch(err => console.error('[GoldGame1] 排程失敗:', err));
}

function scheduleGame2(io) {
  clearTimeout(game2ScheduleTimer);
  clearTimeout(game2WarnTimer);

  getGameSettings().then(settings => {
    if (!settings.game2_enabled) {
      console.log('[GoldGame2] 已停用，不排程');
      return;
    }

    const targetUTC = getNextTWTime(settings.game2_hour, settings.game2_minute);
    const delay     = targetUTC - Date.now();
    const twStr     = new Date(targetUTC).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    console.log(`[GoldGame2] 下次開始: ${twStr}（${Math.round(delay / 60000)} 分後）`);

    if (delay > 30000) {
      game2WarnTimer = setTimeout(() => {
        io.to(ROOM).emit('systemMessage', '⏰ 大金蘋果將在 30 秒後出現！準備搶！');
      }, delay - 30000);
    }

    game2ScheduleTimer = setTimeout(() => startGame2(io, settings), delay);
  }).catch(err => console.error('[GoldGame2] 排程失敗:', err));
}

// ─── Game 1: 多顆金蘋果 ───────────────────────────────────────────────────────
async function startGame1(io, settings) {
  if (game1State?.active) return;

  const appleCount = settings.game1_apple_count;
  const apples = Array.from({ length: appleCount }, (_, i) => ({
    id: `g1-${Date.now()}-${i}`,
    caught: false,
  }));

  // 記錄 DB
  let logId = null;
  try {
    const logRes = await pool.query(
      `INSERT INTO gold_game_logs (room, game_type) VALUES ($1, 1) RETURNING id`,
      [ROOM]
    );
    logId = logRes.rows[0].id;
  } catch (err) {
    console.error('[GoldGame1] log insert error:', err);
  }

  game1State = {
    active:        true,
    apples,
    catches:       {},  // username → count
    lastCatchTime: {},  // username → timestamp（節流用）
    reward:        settings.game1_reward,
    logId,
    timer:         null,
  };

  io.to(ROOM).emit('goldGame1Start', {
    duration:   60,
    appleCount,
    appleIds:   apples.map(a => a.id),
    reward:     settings.game1_reward,
  });
  io.to(ROOM).emit('systemMessage', `🍎 撈金蘋果遊戲開始！螢幕上有 ${appleCount} 顆金蘋果，快搶！共一分鐘！`);

  game1State.timer = setTimeout(() => endGame1(io), 60 * 1000);

  // 排程明天
  scheduleGame1(io);
}

async function endGame1(io) {
  if (!game1State?.active) return;

  const { catches, logId } = game1State;
  if (game1State.timer) clearTimeout(game1State.timer);
  game1State = null;

  io.to(ROOM).emit('goldGame1End', { catches });

  const entries = Object.entries(catches).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    io.to(ROOM).emit('systemMessage', '🍎 撈金蘋果遊戲結束！沒有人撈到金蘋果');
  } else {
    const summary = entries.map(([name, count]) => `${name} ${count}顆`).join('、');
    io.to(ROOM).emit('systemMessage', `🍎 撈金蘋果遊戲結束！本次得獎：${summary}`);
  }

  io.to(ROOM).emit('updateUsers', rooms[ROOM]);

  // 更新 DB 紀錄
  if (logId) {
    pool.query(
      `UPDATE gold_game_logs SET ended_at = NOW(), result = $1 WHERE id = $2`,
      [JSON.stringify({ catches }), logId]
    ).catch(err => console.error('[GoldGame1] log update error:', err));
  }

  console.log('[GoldGame1] 遊戲結束', catches);
}

async function handleCatchApple1(io, socket, { token, appleId }) {
  // 先同步判斷，避免競態
  const state = game1State;
  if (!state?.active) return;

  const userData = ioTokens.get(token);
  if (!userData) return;
  const username = userData.username;

  // ① 每人 300ms 節流（畫面卡住積累的點擊一次過來時全擋掉）
  const now = Date.now();
  const last = state.lastCatchTime[username] || 0;
  if (now - last < 300) return;
  state.lastCatchTime[username] = now;

  // ② 找到未被撈的蘋果（同步，JS 單執行緒安全）
  const apple = state.apples.find(a => a.id === appleId && !a.caught);
  if (!apple) return;  // 已被撈過（server 端最終防線）

  // ③ 標記為已撈（同步，確保同一顆蘋果不會被雙重獎勵）
  apple.caught = true;
  state.catches[username] = (state.catches[username] || 0) + 1;
  const userTotal = state.catches[username];
  const reward    = state.reward;

  // 新增一顆補上（同步，在 await 前完成）
  const newApple = {
    id:     `g1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    caught: false,
  };
  state.apples.push(newApple);

  // 廣播（立即，不等 DB）
  io.to(ROOM).emit('goldAppleCaught1', {
    appleId,
    catcher:    username,
    newAppleId: newApple.id,
    catches:    { ...state.catches },
  });
  io.to(ROOM).emit('systemMessage', `🍎 ${username} 撈到了一顆金蘋果！（累計 ${userTotal} 顆）`);

  // 非同步獎勵 DB（失敗不影響遊戲流程）
  awardGold(username, reward, 1).then(ok => {
    if (ok) io.to(ROOM).emit('updateUsers', rooms[ROOM]);
  });
}

// ─── Game 2: 一顆大金蘋果 ─────────────────────────────────────────────────────
async function startGame2(io, settings) {
  if (game2State?.active) return;

  let logId = null;
  try {
    const logRes = await pool.query(
      `INSERT INTO gold_game_logs (room, game_type) VALUES ($1, 2) RETURNING id`,
      [ROOM]
    );
    logId = logRes.rows[0].id;
  } catch (err) {
    console.error('[GoldGame2] log insert error:', err);
  }

  game2State = {
    active:  true,
    winner:  null,
    winTime: null,
    reward:  settings.game2_reward,
    logId,
    // 不限時，有人搶到才結束
  };

  io.to(ROOM).emit('goldGame2Start', {
    reward: settings.game2_reward,
  });
  io.to(ROOM).emit('systemMessage', `🔥 搶金蘋果！第一個點到的人可得 ${settings.game2_reward} 顆金蘋果！`);

  // 排程明天
  scheduleGame2(io);
}

async function endGame2(io) {
  if (!game2State?.active) return;

  const { winner, logId } = game2State;
  game2State = null;

  io.to(ROOM).emit('goldGame2End', { winner });

  if (logId) {
    pool.query(
      `UPDATE gold_game_logs SET ended_at = NOW(), result = $1 WHERE id = $2`,
      [JSON.stringify({ winner }), logId]
    ).catch(err => console.error('[GoldGame2] log update error:', err));
  }

  console.log('[GoldGame2] 遊戲結束', winner ? `獲獎者: ${winner}` : '無人獲獎');
}

async function handleCatchApple2(io, socket, { token }) {
  const state = game2State;
  if (!state?.active) return;

  const userData = ioTokens.get(token);
  if (!userData) return;
  const username = userData.username;

  const now = Date.now();

  if (state.winner) {
    // 已有人撈到，通知晚了幾秒
    const secLate = Math.ceil((now - state.winTime) / 1000);
    socket.emit('goldGame2Late', {
      winner:      state.winner,
      secondsLate: secLate,
    });
    return;
  }

  // 第一個撈到！（同步標記）
  const reward = state.reward;
  state.winner  = username;
  state.winTime = now;

  // 立即結束遊戲（不限時，無 timer 需清除）
  game2State = null;

  // 廣播獲獎
  io.to(ROOM).emit('goldGame2Won', { winner: username, reward });
  io.to(ROOM).emit('goldGame2End', { winner: username });
  io.to(ROOM).emit('systemMessage', `🎉 ${username} 搶到了金蘋果！獲得 ${reward} 顆金蘋果！`);

  // DB 獎勵（非同步）
  const { logId } = state;
  awardGold(username, reward, 2).then(ok => {
    if (ok) io.to(ROOM).emit('updateUsers', rooms[ROOM]);
  });
  if (logId) {
    pool.query(
      `UPDATE gold_game_logs SET ended_at = NOW(), result = $1 WHERE id = $2`,
      [JSON.stringify({ winner: username }), logId]
    ).catch(err => console.error('[GoldGame2] log update error:', err));
  }
}

// ─── Socket event registration ────────────────────────────────────────────────
export function goldGameSocket(io, socket) {
  socket.on('catchApple1', data => {
    handleCatchApple1(io, socket, data || {})
      .catch(err => console.error('[GoldGame1] handleCatch error:', err));
  });

  socket.on('catchApple2', data => {
    handleCatchApple2(io, socket, data || {})
      .catch(err => console.error('[GoldGame2] handleCatch error:', err));
  });
}

// ─── Public: 設定變更後重新排程 ────────────────────────────────────────────────
export function rescheduleGoldGames() {
  if (!_io) return;
  scheduleGame1(_io);
  scheduleGame2(_io);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
export async function initGoldGameScheduler(io) {
  try {
    _io = io;
    await ensureSchema();
    scheduleGame1(io);
    scheduleGame2(io);
    console.log('[GoldGame] 初始化完成');
  } catch (err) {
    console.error('[GoldGame] 初始化失敗:', err);
  }
}
