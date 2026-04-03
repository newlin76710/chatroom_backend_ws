// surpriseGold.js — 每日金蘋果驚喜排程
import { pool } from "./db.js";
import { songState } from "./socketHandlers.js";
import { rooms } from "./chat.js";

const ROOM = process.env.ROOMNAME || 'windsong';
const TW_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8

// 取得台灣今日的 YYYY-MM-DD 字串
function twDateStr(date = new Date()) {
  return new Date(date.getTime() + TW_OFFSET_MS).toISOString().slice(0, 10);
}

// 建立台灣時間當天指定 hour/minute 的 Date（UTC）
function twTime(date, hour, minute = 0) {
  const d = new Date(date.getTime() + TW_OFFSET_MS); // 轉成台灣日期
  d.setUTCHours(hour - 8, minute, 0, 0);              // 再轉回 UTC 儲存
  return d;
}

// ─── 確保 schema ────────────────────────────────────────────────────────────
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS surprise_gold_logs (
      id           SERIAL PRIMARY KEY,
      room         VARCHAR NOT NULL,
      scheduled_time TIMESTAMPTZ NOT NULL,
      winner       VARCHAR,
      amount       INT NOT NULL DEFAULT 0,
      triggered_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE room_settings ADD COLUMN IF NOT EXISTS surprise_reward INT DEFAULT 10
  `);
}

// ─── 觸發驚喜 ───────────────────────────────────────────────────────────────
async function triggerSurprise(io, logId) {
  try {
    const state = songState[ROOM];
    const singer = state?.currentSinger || null;

    // 取得設定金蘋果數量
    const settingsRes = await pool.query(
      `SELECT surprise_reward FROM room_settings WHERE room = $1`,
      [ROOM]
    );
    const amount = settingsRes.rows[0]?.surprise_reward ?? 10;

    if (singer) {
      const userRes = await pool.query(
        `SELECT u.id FROM users u
         JOIN user_room_stats urs ON u.id = urs.user_id
         WHERE u.username = $1 AND urs.room = $2`,
        [singer, ROOM]
      );

      if (userRes.rows.length) {
        const userId = userRes.rows[0].id;

        await pool.query(
          `UPDATE user_room_stats SET gold_apples = gold_apples + $1
           WHERE user_id = $2 AND room = $3`,
          [amount, userId, ROOM]
        );

        await pool.query(
          `INSERT INTO gift_logs (room, sender, receiver, receiver_id, item_type, amount, created_at)
           VALUES ($1, 'system_surprise', $2, $3, 'gold_apples', $4, NOW())`,
          [ROOM, singer, userId, amount]
        );

        // 更新記憶體
        if (rooms[ROOM]) {
          const ru = rooms[ROOM].find(u => u.name === singer);
          if (ru) ru.gold_apples = (ru.gold_apples || 0) + amount;
        }

        io.to(ROOM).emit("updateUsers", rooms[ROOM]);
      }
    }

    // 更新 log
    await pool.query(
      `UPDATE surprise_gold_logs
       SET winner = $1, amount = $2, triggered_at = NOW()
       WHERE id = $3`,
      [singer, singer ? amount : 0, logId]
    );

    // 廣播驚喜事件
    io.to(ROOM).emit("goldenAppleSurprise", {
      winner: singer,
      amount: singer ? amount : 0,
      triggeredAt: new Date().toISOString(),
    });

    console.log(`[Surprise] 驚喜觸發！得獎者: ${singer || '無'}, 金蘋果: ${singer ? amount : 0}`);

    // 台灣時間隔天 00:01 再排下一次
    const tomorrowTW = new Date(Date.now() + TW_OFFSET_MS);
    tomorrowTW.setUTCDate(tomorrowTW.getUTCDate() + 1);
    tomorrowTW.setUTCHours(0, 1, 0, 0); // 台灣 00:01 = UTC 16:01 前天
    const tomorrowUTC = new Date(tomorrowTW.getTime() - TW_OFFSET_MS);
    const delay = tomorrowUTC.getTime() - Date.now();
    setTimeout(() => scheduleDay(io, tomorrowUTC), delay);

  } catch (err) {
    console.error('[Surprise] 觸發失敗:', err);
  }
}

// ─── 排程指定日的驚喜 ────────────────────────────────────────────────────────
async function scheduleDay(io, dayDate) {
  try {
    const dateStr = twDateStr(dayDate); // 台灣日期字串

    // 先查今天（台灣時間）是否已有紀錄
    const existing = await pool.query(
      `SELECT id, scheduled_time, triggered_at FROM surprise_gold_logs
       WHERE room = $1
         AND DATE(scheduled_time AT TIME ZONE 'Asia/Taipei') = $2::date
       ORDER BY id DESC LIMIT 1`,
      [ROOM, dateStr]
    );

    if (existing.rows.length > 0) {
      const rec = existing.rows[0];
      if (rec.triggered_at) {
        console.log(`[Surprise] ${dateStr}（台灣）已觸發，略過`);
        return;
      }
      const t = new Date(rec.scheduled_time);
      const delay = t.getTime() - Date.now();
      if (delay > 0) {
        console.log(`[Surprise] 恢復排程 ${t.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
        setTimeout(() => triggerSurprise(io, rec.id), delay);
      } else {
        // 時間已過（伺服器重啟）：立即觸發
        await triggerSurprise(io, rec.id);
      }
      return;
    }

    // 無紀錄，隨機一個台灣時間 08:00–23:00
    const from = twTime(dayDate, 8);
    const to   = twTime(dayDate, 23);

    const minMs = Math.max(Date.now() + 60 * 1000, from.getTime());
    if (minMs >= to.getTime()) {
      console.log(`[Surprise] ${dateStr}（台灣）可用時間不足，略過`);
      return;
    }

    const randomTime = new Date(minMs + Math.random() * (to.getTime() - minMs));
    const res = await pool.query(
      `INSERT INTO surprise_gold_logs (room, scheduled_time) VALUES ($1, $2) RETURNING id`,
      [ROOM, randomTime]
    );

    const delay = randomTime.getTime() - Date.now();
    const twStr = randomTime.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    console.log(`[Surprise] ${dateStr}（台灣）驚喜排程: ${twStr}（${Math.round(delay / 60000)} 分鐘後）`);
    setTimeout(() => triggerSurprise(io, res.rows[0].id), delay);

  } catch (err) {
    console.error('[Surprise] scheduleDay 失敗:', err);
  }
}

// ─── 對外入口 ────────────────────────────────────────────────────────────────
export async function initSurpriseScheduler(io) {
  try {
    await ensureSchema();
    await scheduleDay(io, new Date());
    console.log('[Surprise] 初始化完成');
  } catch (err) {
    console.error('[Surprise] 初始化失敗:', err);
  }
}
