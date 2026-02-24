import { pool } from "./db.js";
const ROOM = process.env.ROOMNAME || 'windsong';
export async function logLogin({
  userId = null,
  username,
  loginType,
  ip,
  userAgent,
  success,
  failReason = null,
}) {
  try {
    await pool.query(
      `
      INSERT INTO login_logs
      (user_id, username, login_type, ip_address, user_agent, success, fail_reason, room)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [userId, username, loginType, ip, userAgent, success, failReason, ROOM]
    );
  } catch (err) {
    console.error("❌ login log error:", err.message);
  }
}
