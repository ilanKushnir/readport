import { createHash, randomBytes } from 'node:crypto';
import { type DB } from '../db/index.js';
import { newId } from '../util/ids.js';
import { createApiKey } from './apikeys.js';

/**
 * One-time connect codes: how an agent gets its key without the key ever
 * passing through a chat.
 *
 * Pasting an API key into a message to an agent puts a working credential in
 * the chat's history, its notifications and whatever else reads it. The
 * message carries a code instead. The agent trades it, once, over HTTPS, for
 * a key minted for it there and then, and keeps that key in its own secret
 * store. A code seen later in a chat log is spent.
 *
 * - A code lives CONNECT_TTL_MS, and only its hash is kept, like a key's.
 * - The first redemption mints a key. The same code keeps working for
 *   CONNECT_RETRY_GRACE_MS after that, so an agent that crashed before
 *   storing its key can simply try again; every retry revokes the key the
 *   previous attempt minted, so only the last key handed out works.
 * - Redeeming needs no session and no key: the code is the credential. It is
 *   128 random bits, and attempts are metered by address.
 */

export const CONNECT_TTL_MS = 24 * 60 * 60 * 1000;
export const CONNECT_RETRY_GRACE_MS = 10 * 60 * 1000;
/** Codes a person may have waiting at once. */
export const CONNECT_PENDING_LIMIT = 5;
export const CODE_RE = /^rpc_[0-9a-f]{32}$/;

export interface ConnectCodeRow {
  id: string;
  user_id: string;
  name: string;
  code_hash: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  cancelled_at: string | null;
  api_key_id: string | null;
}

export type ConnectStatus = 'pending' | 'connected' | 'expired' | 'cancelled';

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

export function connectStatus(row: ConnectCodeRow, now: string): ConnectStatus {
  if (row.cancelled_at) return 'cancelled';
  if (row.redeemed_at) return 'connected';
  return Date.parse(row.expires_at) <= Date.parse(now) ? 'expired' : 'pending';
}

/** Codes still waiting to be redeemed. */
export function pendingCodes(db: DB, userId: string, now: string): ConnectCodeRow[] {
  return db
    .prepare(
      `SELECT * FROM agent_connect_codes
       WHERE user_id = ? AND redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .all(userId, now) as unknown as ConnectCodeRow[];
}

export function issueConnectCode(
  db: DB,
  opts: { userId: string; name: string; now: string },
): { id: string; code: string; expiresAt: string } {
  const id = newId('agc');
  const code = `rpc_${randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(Date.parse(opts.now) + CONNECT_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO agent_connect_codes (id, user_id, name, code_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.userId, opts.name, hashCode(code), opts.now, expiresAt);
  return { id, code, expiresAt };
}

export type RedeemResult =
  | { ok: true; key: string; apiKeyId: string; userId: string; name: string }
  | { ok: false; error: 'invalid-code' | 'code-expired' };

/**
 * Trade a code for a fresh key. One transaction, so two agents racing on the
 * same code cannot both walk away with a working key.
 */
export function redeemConnectCode(db: DB, presented: string, now: string): RedeemResult {
  const code = presented.trim();
  if (!CODE_RE.test(code)) return { ok: false, error: 'invalid-code' };
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare('SELECT * FROM agent_connect_codes WHERE code_hash = ?')
      .get(hashCode(code)) as ConnectCodeRow | undefined;
    const user = row
      ? (db.prepare('SELECT status FROM users WHERE id = ?').get(row.user_id) as
          { status: string } | undefined)
      : undefined;
    if (!row || row.cancelled_at || user?.status !== 'active') {
      db.exec('ROLLBACK');
      return { ok: false, error: 'invalid-code' };
    }
    const t = Date.parse(now);
    const spent =
      row.redeemed_at !== null && t - Date.parse(row.redeemed_at) > CONNECT_RETRY_GRACE_MS;
    if (spent || Date.parse(row.expires_at) <= t) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'code-expired' };
    }
    // A retry: the key the earlier attempt minted never reached a working
    // agent, or if it did, this one replaces it. Either way it goes.
    if (row.api_key_id) {
      db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
        now,
        row.api_key_id,
      );
    }
    const apiKeyId = newId('key');
    const { key } = createApiKey(db, { id: apiKeyId, userId: row.user_id, name: row.name, now });
    db.prepare(
      'UPDATE agent_connect_codes SET redeemed_at = COALESCE(redeemed_at, ?), api_key_id = ? WHERE id = ?',
    ).run(now, apiKeyId, row.id);
    db.exec('COMMIT');
    return { ok: true, key, apiKeyId, userId: row.user_id, name: row.name };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
