# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start server (production)
npm start

# Start with auto-reload (development)
npm run dev
```

No linting or test scripts are configured.

## Architecture

This is a real-time karaoke chatroom platform built with Node.js + Express + Socket.IO, backed by PostgreSQL. It is deployed on Render and targets a Taiwan-based audience (Traditional Chinese throughout).

### Entry Point

`server.js` is the sole entry point. It:
- Creates an Express + Socket.IO server
- Registers all HTTP routers
- Sets up Socket.IO connection and delegates to handlers in `chat.js` and `socketHandlers.js`
- Runs two interval jobs every 60s: ghost-user cleanup and a self-ping heartbeat to prevent Render from sleeping

### Module Structure

| File | Responsibility |
|---|---|
| `db.js` | PostgreSQL connection pool (pg) |
| `auth.js` | Registration, login, token management, `authMiddleware` |
| `chat.js` | Socket.IO message handling, room management, EXP/leveling |
| `socketHandlers.js` | Karaoke singing queue, LiveKit token generation, song scoring |
| `transferGold.js` | Gold apple gifting with DB transactions |
| `ai.js` | AI character profiles and Ollama API calls for chat/song comments |
| `admin.js` | Admin-only routes (login logs, user management) |
| `announcementRouter.js` | System-wide announcements |
| `messageBoardRouter.js` | Persistent message board |
| `quickPhrase.js` | Saved message templates per user |
| `blockIP.js` / `blockNickname.js` | Admin-controlled blocklists |
| `loginLogger.js` | Audit logging for all login attempts |
| `ip.js` | In-memory IP-to-username mapping |

### State Management

**In-memory** (not persisted across restarts):
- `rooms` Map — room name → Set of user objects currently in room
- `onlineUsers` Map — username → last heartbeat timestamp
- `ioTokens` Map — token → `{ username, socketId, ip }`
- `pendingReconnect` Map — 10-second grace window on disconnect
- `songState` per room — singer queue, current singer, start time, score

**Database** (PostgreSQL):
- `users` — credentials, avatar, account_type
- `user_room_stats` — level, EXP, gold_apples per room
- `message_logs` — full chat audit trail with IP
- `login_logs` — login attempt history
- `room_settings` — configurable rewards per room
- `blocked_ips` / `blocked_nicknames` — per-room blocklists

### Key Patterns

**Authentication flow**: Login → bcryptjs verify → generate token → store in `ioTokens` → client sends token with every Socket.IO event → `authMiddleware` (HTTP) or inline token lookup (Socket.IO) validates and populates user context.

**Leveling formula**: `expForNextLevel(level) = 120 * level² + 200`, capped at level 90 (ANL-1). Each chat message grants +5 EXP.

**Admin tiers**: Level ≥ 91 can kick/mute; level 99 (`ADMIN_MAX_LEVEL`) can see all private messages and access admin routes.

**Karaoke flow**: User joins singer queue → `socketHandlers.js` issues a LiveKit token (10 min TTL) → only the current singer can publish audio → on finish, AI scores via Ollama and awards EXP + gold apples → broadcasts AI comment to room.

**AI characters**: 16 personalities defined in `ai.js`, calls local Ollama (llama3) at the IP in `.env`. Enabled when `OPENAI=true` env var is set. Auto-chat fires every 30–45s.

### Environment Variables

Defined in `.env` (not committed). Key variables:
- `DATABASE_URL` — PostgreSQL connection string
- `ALLOWED_ORIGINS` — comma-separated list for CORS
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — LiveKit streaming
- `ROOMNAME` — default room name
- `OPENAI` — `true/false`, enables AI auto-chat
- `OPENGUEST` — `true/false`, enables guest login
- `ADMIN_MAX_LEVEL` / `ADMIN_MIN_LEVEL` — admin permission thresholds (default 99/91)
- `MAX_GOLD_APPLES` — per-transfer limit for gold apples
- `SELF_URL` — used by heartbeat job to ping itself on Render
