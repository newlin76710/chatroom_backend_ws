// whackAppleGame.js — 打金蘋果遊戲（打地鼠風格）
//
// 機制：
//   - 每天固定時間啟動，持續 30 秒（可設定）
//   - 全場玩家各自點金蘋果，每點一顆 +1 hit
//   - Server 以 300ms 節流防刷
//   - 遊戲結束後批次結算：每人 hit 數 × reward 顆金蘋果
//
// Socket events:
//   server → client: whackGameStart { duration, reward }
//   client → server: catchWhackApple { token }
//   server → client: whackGameEnd { scores: { [username]: hitCount } }

import { pool } from "./db.js";
import { rooms } from "./chat.js";
import { ioTokens } from "./auth.js";

const ROOM        = process.env.ROOMNAME || 'windsong';
const TW_OFFSET_MS = 8 * 60 * 60 * 1000;
const THROTTLE_MS  = 300; // 每人最快每 300ms 一次點擊

// ─── Module-level io reference ────────────────────────────────────────────────
let _io = null;

// ─── Game state ───────────────────────────────────────────────────────────────
// { active, scores, lastHitTime, reward, duration, timer, logId }
let whackState = null;

// ─── Schedule timers ──────────────────────────────────────────────────────────
let scheduleTimer = null;
let warnTimer     = null;

// ─── DB Schema ────────────────────────────────────────────────────────────────
async function ensureSchema() {
  const cols = [
    ['whack_enabled',     'BOOLEAN DEFAULT true'],
    ['whack_hour',        'INT DEFAULT 21'],
    ['whack_minute',      'INT DEFAULT 0'],
    ['whack_duration',    'INT DEFAULT 30'],
    ['whack_reward',      'INT DEFAULT 1'],
    ['whack_ms_lo',       'INT DEFAULT 350'],
    ['whack_ms_hi',       'INT DEFAULT 700'],
    ['whack_min_apples',  'INT DEFAULT 4'],
    ['whack_max_apples',  'INT DEFAULT 7'],
  ];
  for (const [col, def] of cols) {
    await pool.query(
      `ALTER TABLE room_settings ADD COLUMN IF NOT EXISTS ${col} ${def}`
    );
  }
  // 複用 gold_game_logs，game_type=3 代表打地鼠遊戲
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function getSettings() {
  const res = await pool.query(
    `SELECT
       COALESCE(whack_enabled,    true) AS whack_enabled,
       COALESCE(whack_hour,       21)   AS whack_hour,
       COALESCE(whack_minute,     0)    AS whack_minute,
       COALESCE(whack_duration,   30)   AS whack_duration,
       COALESCE(whack_reward,     1)    AS whack_reward,
       COALESCE(whack_ms_lo,      350)  AS whack_ms_lo,
       COALESCE(whack_ms_hi,      700)  AS whack_ms_hi,
       COALESCE(whack_min_apples, 4)    AS whack_min_apples,
       COALESCE(whack_max_apples, 7)    AS whack_max_apples
     FROM room_settings WHERE room = $1`,
    [ROOM]
  );
  return res.rows[0] || {
    whack_enabled: true, whack_hour: 21, whack_minute: 0,
    whack_duration: 30, whack_reward: 1,
    whack_ms_lo: 350, whack_ms_hi: 700,
    whack_min_apples: 4, whack_max_apples: 7,
  };
}

// ─── Award helpers ────────────────────────────────────────────────────────────
async function awardGold(username, amount) {
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
       VALUES ($1, 'system_game3', $2, $3, 'gold_apples', $4, NOW())`,
      [ROOM, username, userId, amount]
    );

    // 同步更新記憶體
    if (rooms[ROOM]) {
      const u = rooms[ROOM].find(u => u.name === username);
      if (u) u.gold_apples = (u.gold_apples || 0) + amount;
    }
    return true;
  } catch (err) {
    console.error('[WhackGame] awardGold error:', err);
    return false;
  }
}

// ─── Schedule helpers ─────────────────────────────────────────────────────────
function getNextTWTime(hour, minute) {
  const now   = Date.now();
  const twNow = new Date(now + TW_OFFSET_MS);
  const twYear  = twNow.getUTCFullYear();
  const twMonth = twNow.getUTCMonth();
  const twDay   = twNow.getUTCDate();
  const todayUTC = Date.UTC(twYear, twMonth, twDay, hour - 8, minute, 0, 0);
  return todayUTC > now + 10000 ? todayUTC : todayUTC + 24 * 60 * 60 * 1000;
}

export function scheduleWhackGame(io) {
  clearTimeout(scheduleTimer);
  clearTimeout(warnTimer);

  getSettings().then(s => {
    if (!s.whack_enabled) {
      console.log('[WhackGame] 已停用，不排程');
      return;
    }

    const targetUTC = getNextTWTime(s.whack_hour, s.whack_minute);
    const delay     = targetUTC - Date.now();
    const twStr     = new Date(targetUTC).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    console.log(`[WhackGame] 下次開始: ${twStr}（${Math.round(delay / 60000)} 分後）`);

    if (delay > 30000) {
      warnTimer = setTimeout(() => {
        io.to(ROOM).emit('systemMessage', '⏰ 打金蘋果遊戲（打地鼠）將在 30 秒後開始！準備好了嗎？');
      }, delay - 30000);
    }

    scheduleTimer = setTimeout(() => startWhackGame(io), delay);
  }).catch(err => console.error('[WhackGame] 排程失敗:', err));
}

// ─── Start game ───────────────────────────────────────────────────────────────
export async function startWhackGame(io) {
  if (whackState?.active) {
    console.log('[WhackGame] 遊戲已在進行中，略過');
    return;
  }

  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    console.error('[WhackGame] 讀取設定失敗:', err);
    return;
  }

  let logId = null;
  try {
    const logRes = await pool.query(
      `INSERT INTO gold_game_logs (room, game_type) VALUES ($1, 3) RETURNING id`,
      [ROOM]
    );
    logId = logRes.rows[0].id;
  } catch (err) {
    console.error('[WhackGame] log insert error:', err);
  }

  const {
    whack_duration:   duration,
    whack_reward:     reward,
    whack_ms_lo:      msLo,
    whack_ms_hi:      msHi,
    whack_min_apples: minApples,
    whack_max_apples: maxApples,
  } = settings;

  whackState = {
    active:      true,
    scores:      {},   // username → hit count
    lastHitTime: {},   // username → timestamp（節流）
    reward,
    duration,
    logId,
    timer: null,
  };

  io.to(ROOM).emit('whackGameStart', {
    duration,
    reward,
    msLo,
    msHi,
    minApples,
    maxApples,
  });
  io.to(ROOM).emit('systemMessage',
    `🔨 打金蘋果遊戲開始！用力打從洞裡跑出來的金蘋果！共 ${duration} 秒，每打一顆得 ${reward} 個🍎！`
  );

  whackState.timer = setTimeout(() => endWhackGame(io), duration * 1000);

  // 排程明天
  scheduleWhackGame(io);
}

// ─── End game ─────────────────────────────────────────────────────────────────
async function endWhackGame(io) {
  if (!whackState?.active) return;

  const { scores, reward, logId } = whackState;
  if (whackState.timer) clearTimeout(whackState.timer);
  whackState = null;

  io.to(ROOM).emit('whackGameEnd', { scores });

  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    io.to(ROOM).emit('systemMessage', '🔨 打金蘋果遊戲結束！沒有人打到金蘋果…');
  } else {
    const top3   = entries.slice(0, 3).map(([name, n]) => `${name} ${n}顆`).join('、');
    const others = entries.length > 3 ? `等 ${entries.length} 人` : '';
    io.to(ROOM).emit('systemMessage',
      `🏆 打金蘋果結束！${top3}${others ? ' ' + others : ''} 獲得金蘋果！`
    );
  }

  // 批次發放金蘋果（非同步，不阻塞廣播）
  Promise.all(
    entries.map(([username, count]) => awardGold(username, count * reward))
  ).then(() => {
    io.to(ROOM).emit('updateUsers', rooms[ROOM]);
  }).catch(err => console.error('[WhackGame] 批次發放失敗:', err));

  // 更新 log
  if (logId) {
    pool.query(
      `UPDATE gold_game_logs SET ended_at = NOW(), result = $1 WHERE id = $2`,
      [JSON.stringify({ scores }), logId]
    ).catch(err => console.error('[WhackGame] log update error:', err));
  }

  console.log('[WhackGame] 遊戲結束', entries.map(([n, c]) => `${n}:${c}`).join(', '));
}

// ─── Handle hit ───────────────────────────────────────────────────────────────
function handleCatchWhackApple(socket, { token } = {}) {
  const state = whackState;
  if (!state?.active) return;

  const userData = ioTokens.get(token);
  if (!userData) return;
  const username = userData.username;

  // 節流：同一玩家 300ms 內只算一次
  const now  = Date.now();
  const last = state.lastHitTime[username] || 0;
  if (now - last < THROTTLE_MS) return;
  state.lastHitTime[username] = now;

  state.scores[username] = (state.scores[username] || 0) + 1;
}

// ─── Socket registration ──────────────────────────────────────────────────────
export function whackGameSocket(io, socket) {
  socket.on('catchWhackApple', data => {
    try {
      handleCatchWhackApple(socket, data || {});
    } catch (err) {
      console.error('[WhackGame] handleCatch error:', err);
    }
  });
}

// ─── Public: 重新排程（設定變更後呼叫） ──────────────────────────────────────
export function rescheduleWhackGame() {
  if (!_io) return;
  scheduleWhackGame(_io);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
export async function initWhackGameScheduler(io) {
  try {
    _io = io;
    await ensureSchema();
    scheduleWhackGame(io);
    console.log('[WhackGame] 初始化完成');
  } catch (err) {
    console.error('[WhackGame] 初始化失敗:', err);
  }
}
