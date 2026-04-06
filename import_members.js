/**
 * import_members.js
 *
 * 執行前請確認：
 *   1. .env 已設定好 DATABASE_URL
 *   2. member_2026.csv 與此檔案在同一目錄（編碼：CP950 / Big5）
 *
 * 執行方式：
 *   node import_members.js
 *
 * CSV 欄位順序（無標頭列）：
 *   [0] 舊系統 id  [1] gender(girl/boy)  [2] username
 *   [3] md5 hash   [4] created_at        [5] last_login
 *   [6] birthday   [7] email             [8] email_confirm(Y/N)
 */

import fs from 'fs';
import iconv from 'iconv-lite';
import { pool } from './db.js';
import dotenv from 'dotenv';
dotenv.config();

const ROOM = process.env.ROOMNAME || 'windsong';
const DEFAULT_LEVEL = 2;

/* ─── CSV 解析（支援帶引號的欄位） ─── */
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/* ─── 主程式 ─── */
async function main() {
  // ── Step 1：新增 password_type 欄位（若不存在） ──
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_type VARCHAR(10) NOT NULL DEFAULT 'bcrypt'
  `);
  console.log('[OK] password_type 欄位確認完成');

  // ── Step 2：讀取 CP950 檔案並解碼為 UTF-8 字串 ──
  const rawBuffer = fs.readFileSync('./member_2026.csv');
  const content = iconv.decode(rawBuffer, 'cp950');
  const lines = content.split(/\r?\n/);
  console.log(`[OK] CSV 讀取完成，共 ${lines.length} 行`);

  // ── Step 3：逐行匯入 ──
  const skipped = [];
  let inserted = 0;
  let errors = 0;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const raw = lines[lineNum].trim();
    if (!raw) continue;

    let fields;
    try {
      fields = parseCSVLine(raw);
    } catch (e) {
      console.error(`[錯誤] 第 ${lineNum + 1} 行解析失敗：`, e.message);
      errors++;
      continue;
    }

    if (fields.length < 9) {
      skipped.push({ lineNum: lineNum + 1, username: fields[2] ?? '?', reason: '欄位不足' });
      continue;
    }

    const username     = fields[2]?.trim();
    const md5hash      = fields[3]?.trim().toLowerCase();
    const createdAt    = fields[4]?.trim() || null;
    const birthday     = fields[6]?.trim() || null;
    const email        = fields[7]?.trim() || null;
    const emailConfirm = fields[8]?.trim().toUpperCase() === 'Y';
    const gender       = fields[1]?.trim().toLowerCase() === 'girl' ? '女' : '男';

    if (!username || !md5hash) {
      skipped.push({ lineNum: lineNum + 1, username: username || '?', reason: '帳號或密碼欄位空白' });
      continue;
    }

    // ── 重複暱稱檢查（大小寫不分） ──
    const dupRes = await pool.query(
      `SELECT id FROM users WHERE LOWER(username) = LOWER($1)`,
      [username]
    );
    if (dupRes.rowCount > 0) {
      skipped.push({ lineNum: lineNum + 1, username, reason: '暱稱重複' });
      continue;
    }

    // ── 匯入 users ──
    try {
      const insertRes = await pool.query(
        `INSERT INTO users
           (username, password, password_type, gender, email, email_confirm,
            birthday, account_type, created_at)
         VALUES ($1, $2, 'md5', $3, $4, $5, $6, 'account', $7)
         RETURNING id`,
        [
          username,
          md5hash,
          gender,
          email || null,
          emailConfirm,
          birthday || null,
          createdAt || new Date(),
        ]
      );

      // ── 建立 user_room_stats（預設等級 2） ──
      const newUserId = insertRes.rows[0].id;
      await pool.query(
        `INSERT INTO user_room_stats
           (user_id, username, room, level, exp, gold_apples)
         VALUES ($1, $2, $3, $4, 0, 0)
         ON CONFLICT (user_id, room) DO NOTHING`,
        [newUserId, username, ROOM, DEFAULT_LEVEL]
      );

      inserted++;
    } catch (e) {
      console.error(`[錯誤] 第 ${lineNum + 1} 行（${username}）寫入失敗：`, e.message);
      skipped.push({ lineNum: lineNum + 1, username, reason: `DB 錯誤：${e.message}` });
      errors++;
    }
  }

  // ── Step 4：輸出結果 ──
  console.log('\n========== 匯入完成 ==========');
  console.log(`✅ 成功匯入：${inserted} 筆`);
  console.log(`⏭  跳過：   ${skipped.length} 筆`);
  console.log(`❌ 錯誤：   ${errors} 筆`);

  if (skipped.length > 0) {
    const logPath = './import_skipped.log';
    const logLines = skipped.map(
      s => `[行 ${s.lineNum}] ${s.username} → ${s.reason}`
    );
    fs.writeFileSync(logPath, logLines.join('\n'), 'utf8');
    console.log(`\n跳過清單已寫入：${logPath}`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('匯入程式執行失敗：', err);
  process.exit(1);
});
