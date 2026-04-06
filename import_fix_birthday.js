/**
 * import_fix_birthday.js
 *
 * 從 import_skipped.log 撈出「date/time field value out of range」的行號，
 * 重新從 CSV 讀取該行並以 birthday = null 寫入資料庫。
 *
 * 執行方式：
 *   node import_fix_birthday.js
 */

import fs from 'fs';
import iconv from 'iconv-lite';
import { pool } from './db.js';
import dotenv from 'dotenv';
dotenv.config();

const ROOM = process.env.ROOMNAME || 'windsong';
const DEFAULT_LEVEL = 2;

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current); current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

async function main() {
  // ── 1. 從 log 取出需要補寫的行號 ──
  const logContent = fs.readFileSync('./import_skipped.log', 'utf8');
  const targetLines = new Set();
  for (const line of logContent.split('\n')) {
    if (!line.includes('date/time field value out of range')) continue;
    const m = line.match(/^\[行 (\d+)\]/);
    if (m) targetLines.add(parseInt(m[1], 10));
  }

  if (targetLines.size === 0) {
    console.log('沒有需要補寫的生日錯誤資料');
    await pool.end();
    return;
  }

  console.log(`找到 ${targetLines.size} 筆需補寫：`, [...targetLines]);

  // ── 2. 讀取 CSV（CP950） ──
  const rawBuffer = fs.readFileSync('./member_2026.csv');
  const csvLines = iconv.decode(rawBuffer, 'cp950').split(/\r?\n/);

  let inserted = 0;
  const skipped = [];

  for (const lineNum of targetLines) {
    const raw = csvLines[lineNum - 1]?.trim();
    if (!raw) {
      skipped.push({ lineNum, reason: 'CSV 行不存在' });
      continue;
    }

    const fields = parseCSVLine(raw);
    if (fields.length < 9) {
      skipped.push({ lineNum, reason: '欄位不足' });
      continue;
    }

    const username     = fields[2]?.trim();
    const md5hash      = fields[3]?.trim().toLowerCase();
    const createdAt    = fields[4]?.trim() || null;
    const email        = fields[7]?.trim() || null;
    const emailConfirm = fields[8]?.trim().toUpperCase() === 'Y';
    const gender       = fields[1]?.trim().toLowerCase() === 'girl' ? '女' : '男';

    if (!username || !md5hash) {
      skipped.push({ lineNum, username: username || '?', reason: '帳號或密碼空白' });
      continue;
    }

    // 重複檢查
    const dupRes = await pool.query(
      `SELECT id FROM users WHERE LOWER(username) = LOWER($1)`,
      [username]
    );
    if (dupRes.rowCount > 0) {
      skipped.push({ lineNum, username, reason: '暱稱重複（已存在）' });
      continue;
    }

    try {
      const insertRes = await pool.query(
        `INSERT INTO users
           (username, password, password_type, gender, email, email_confirm,
            birthday, account_type, created_at)
         VALUES ($1, $2, 'md5', $3, $4, $5, NULL, 'account', $6)
         RETURNING id`,
        [username, md5hash, gender, email || null, emailConfirm, createdAt || new Date()]
      );

      const newUserId = insertRes.rows[0].id;
      await pool.query(
        `INSERT INTO user_room_stats
           (user_id, username, room, level, exp, gold_apples)
         VALUES ($1, $2, $3, $4, 0, 0)
         ON CONFLICT (user_id, room) DO NOTHING`,
        [newUserId, username, ROOM, DEFAULT_LEVEL]
      );

      console.log(`[OK] 行 ${lineNum} ${username} 寫入成功（birthday = null）`);
      inserted++;
    } catch (e) {
      console.error(`[錯誤] 行 ${lineNum} ${username}：`, e.message);
      skipped.push({ lineNum, username, reason: e.message });
    }
  }

  console.log(`\n✅ 成功：${inserted} 筆　❌ 失敗：${skipped.length} 筆`);
  if (skipped.length > 0) {
    skipped.forEach(s => console.log(`  [行 ${s.lineNum}] ${s.username ?? ''} → ${s.reason}`));
  }

  await pool.end();
}

main().catch(err => {
  console.error('執行失敗：', err);
  process.exit(1);
});
