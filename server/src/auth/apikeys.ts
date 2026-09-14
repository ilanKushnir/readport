import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type DB } from '../db/index.js';
import { type SessionUser } from './sessions.js';

/**
 * Read-only API keys, for agents.
 *
 * The case: someone wants their assistant - Claude Code, a home agent,
 * whatever they run - to see what they are reading, what is on their lists
 * and how far through they are. Handing an agent the account password gives
 * it the power to change all of that; an API key that can only ever perform a
 * GET gives it exactly what it needs and nothing else.
 *
 * The request hook grants only the fixed agent:read scope and a closed
 * versioned route catalog. Existing and future legacy GETs are not grants.
 */

/** `rp_<prefix>_<secret>`: the prefix is public, the secret never stored. */
const PREFIX_BYTES = 4; // 8 hex chars
const SECRET_BYTES = 24; // 48 hex chars
export const KEY_RE = /^rp_([0-9a-f]{8})_([0-9a-f]{48})$/;

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Mint a key.
 *
 * Returned once, in full, and never recoverable: only its hash is kept, so a
 * copy of the database is not a set of working credentials.
 */
export function createApiKey(
  db: DB,
  opts: { id: string; userId: string; name: string; now: string },
): { key: string; prefix: string } {
  // Retry rather than assume: the prefix is UNIQUE, and a collision at 4
  // bytes is unlikely but not impossible over a server's lifetime.
  for (let attempt = 0; attempt < 5; attempt++) {
    const prefix = randomBytes(PREFIX_BYTES).toString('hex');
    const key = `rp_${prefix}_${randomBytes(SECRET_BYTES).toString('hex')}`;
    const taken = db.prepare('SELECT 1 FROM api_keys WHERE prefix = ?').get(prefix);
    if (taken) continue;
    db.prepare(
      `INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(opts.id, opts.userId, opts.name, prefix, hashKey(key), opts.now);
    return { key, prefix };
  }
  throw new Error('Could not allocate an API key prefix');
}

/**
 * The user a key speaks for, or null.
 *
 * Looked up by the public prefix so this is an index hit, then compared in
 * constant time - a timing signal on a credential comparison is worth
 * avoiding even when the search space makes it academic.
 *
 * A disabled account's keys stop working, like its sessions do.
 */
export function resolveApiKey(
  db: DB,
  presented: string,
  now: string,
): (SessionUser & { apiKeyId: string }) | null {
  const m = KEY_RE.exec(presented.trim());
  if (!m) return null;
  const row = db
    .prepare('SELECT * FROM api_keys WHERE prefix = ? AND revoked_at IS NULL')
    .get(m[1]!) as ApiKeyRow | undefined;
  if (!row) return null;

  const want = Buffer.from(row.key_hash, 'hex');
  const got = Buffer.from(hashKey(presented.trim()), 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;

  const user = db
    .prepare('SELECT id, username, role, display_name, status FROM users WHERE id = ?')
    .get(row.user_id) as
    | { id: string; username: string; role: string; display_name: string | null; status: string }
    | undefined;
  if (!user || user.status !== 'active') return null;

  // "Last used" is what tells someone a key they forgot about is still in
  // play. Written at most once a minute so a chatty agent is not a write
  // amplifier on every request.
  if (!row.last_used_at || Date.parse(now) - Date.parse(row.last_used_at) > 60_000) {
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, row.id);
  }

  return {
    apiKeyId: row.id,
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.display_name,
  };
}

/** The bearer token on a request, if it looks like one of ours. */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (Array.isArray(header)) return null;
  const raw = header;
  if (!raw) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return m ? m[1]! : null;
}
