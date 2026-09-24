import { createHmac, randomBytes } from 'node:crypto';
import { type DB, nowIso } from '../db/index.js';
import { newId } from '../util/ids.js';

/**
 * Opaque session tokens. The cookie stores the raw token; the database only
 * stores an HMAC of it keyed by the session secret, so a leaked database (or
 * backup) cannot be replayed as live sessions, and rotating the secret
 * invalidates every session.
 */

export interface SessionUser {
  id: string;
  username: string;
  role: string;
  displayName?: string | null;
  /** Set when this request slid the session forward; the caller re-cookies. */
  renewedUntil?: string | null;
}

function hmacToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

/** How stale an account's "last seen" may get before a request writes it again. */
const SEEN_EVERY_MS = 5 * 60_000;

/**
 * Note that someone used ReadPort just now: what People shows as "last
 * seen". Written at most every few minutes, not once per request.
 */
export function markSeen(db: DB, userId: string, now = nowIso()): void {
  db.prepare(
    'UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)',
  ).run(now, userId, new Date(Date.parse(now) - SEEN_EVERY_MS).toISOString());
}

export function createSession(
  db: DB,
  secret: string,
  userId: string,
  days: number,
  userAgent?: string,
): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hmac, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('sess'),
    userId,
    hmacToken(secret, token),
    nowIso(),
    expiresAt,
    nowIso(),
    userAgent ?? null,
  );
  return { token, expiresAt };
}

export function resolveSession(
  db: DB,
  secret: string,
  token: string,
  sessionDays: number,
): SessionUser | null {
  if (!token || token.length > 128) return null;
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, u.id, u.username, u.role, u.display_name, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hmac = ?`,
    )
    .get(hmacToken(secret, token)) as
    | {
        session_id: string;
        expires_at: string;
        id: string;
        username: string;
        role: string;
        display_name: string | null;
        status: string;
      }
    | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now() || row.status !== 'active') {
    // Disabling an account revokes its sessions on next use.
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    return null;
  }
  // Sliding expiry. A fixed thirty days meant a session that was in use every
  // day still died on schedule, and signing back in purges this browser's
  // downloads - so ordinary use cost people every book they had taken offline.
  // Extended only in the last day of its life, so this is one extra write a
  // month rather than one per request.
  const remaining = Date.parse(row.expires_at) - Date.now();
  const full = sessionDays * 86_400_000;
  const renewed = remaining < full - 86_400_000 ? new Date(Date.now() + full).toISOString() : null;
  const now = nowIso();
  db.prepare(
    'UPDATE sessions SET last_seen_at = ?, expires_at = COALESCE(?, expires_at) WHERE id = ?',
  ).run(now, renewed, row.session_id);
  markSeen(db, row.id, now);
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    displayName: row.display_name,
    renewedUntil: renewed,
  };
}

export function destroySession(db: DB, secret: string, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hmac = ?').run(hmacToken(secret, token));
}

/** Sign a user out everywhere, optionally keeping one session (the caller's). */
export function destroyUserSessions(
  db: DB,
  userId: string,
  keepToken?: { secret: string; token: string },
): number {
  const res = keepToken
    ? db
        .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hmac <> ?')
        .run(userId, hmacToken(keepToken.secret, keepToken.token))
    : db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return Number(res.changes);
}

/**
 * Fixed-window attempt throttle persisted in SQLite, so counters survive a
 * process restart and are shared between web and worker processes. Keys are
 * caller-chosen; auth throttles both per-account and per-(trusted) IP.
 */
export class LoginThrottle {
  constructor(
    private db: DB,
    private limit: number,
    private windowMs: number,
  ) {}

  /** Count an attempt against `key`; returns false when over the limit. */
  allow(key: string): boolean {
    const now = Date.now();
    const row = this.db
      .prepare('SELECT count, reset_at FROM login_throttle WHERE key = ?')
      .get(key) as { count: number; reset_at: number } | undefined;
    if (!row || row.reset_at <= now) {
      this.db
        .prepare(
          `INSERT INTO login_throttle (key, count, reset_at) VALUES (?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
        )
        .run(key, now + this.windowMs);
      return true;
    }
    this.db.prepare('UPDATE login_throttle SET count = count + 1 WHERE key = ?').run(key);
    return row.count + 1 <= this.limit;
  }

  /** Clear a key (e.g. after a successful login for that account). */
  reset(key: string): void {
    this.db.prepare('DELETE FROM login_throttle WHERE key = ?').run(key);
  }
}

/** Drop expired throttle windows so attacker-chosen keys cannot pile up. */
export function pruneLoginThrottle(db: DB): number {
  const res = db.prepare('DELETE FROM login_throttle WHERE reset_at < ?').run(Date.now());
  return Number(res.changes);
}
