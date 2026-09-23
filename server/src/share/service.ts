import fs from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { type FastifyRequest } from 'fastify';
import {
  SHARE_TOKEN_RE,
  makeInviteCode,
  type JoinRequestDto,
  type JoinStatusResponse,
  type SharedBook,
} from '@readport/shared';
import { type DB, nowIso } from '../db/index.js';
import { type EnvConfig } from '../config.js';
import { resolveSettings } from '../domain/settings.js';
import { newId } from '../util/ids.js';

/**
 * Share links and join requests - the rows behind `/s/<token>`.
 *
 * A share is one person handing one book to someone; the token is the whole
 * secret. Revoking keeps the row with `revoked_at` set, so a dead token
 * stays dead rather than becoming free for a new share to be minted under.
 */

/** 24 random bytes as base64url: 32 URL-safe characters, 192 bits. */
export function newShareToken(): string {
  return randomBytes(24).toString('base64url');
}

export interface ActiveShare {
  token: string;
  bookId: string;
  title: string;
  author: string | null;
  kind: 'ebook' | 'audio';
  coverPath: string | null;
  createdBy: string;
  /** What the sharer is called - their display name, else their username. */
  sharerName: string;
}

interface ShareJoinRow {
  token: string;
  book_id: string;
  created_by: string;
  title: string;
  author: string | null;
  kind: string;
  cover_path: string | null;
  scan_state: string;
  display_name: string | null;
  username: string;
  status: string;
}

const SHARE_SELECT = `
  SELECT s.token, s.book_id, s.created_by, b.title, b.author, b.kind, b.cover_path, b.scan_state,
         u.display_name, u.username, u.status
    FROM book_shares s
    JOIN books b ON b.id = s.book_id
    JOIN users u ON u.id = s.created_by
   WHERE s.token = ? AND s.revoked_at IS NULL AND b.hidden_at IS NULL`;

/**
 * The share a token stands for, or null: unknown, revoked, a book that has
 * since left the library, a book an admin has hidden (whoever is asking - a
 * link is opened by people who are not signed in at all), or a sharer whose
 * account has been disabled - a disabled account should not keep a door
 * open. A hidden book's links come back to life if it is shown again.
 */
export function activeShare(db: DB, token: string): ActiveShare | null {
  if (!SHARE_TOKEN_RE.test(token)) return null;
  const row = db.prepare(SHARE_SELECT).get(token) as ShareJoinRow | undefined;
  if (!row || row.status !== 'active' || row.scan_state === 'missing') return null;
  return {
    token: row.token,
    bookId: row.book_id,
    title: row.title,
    author: row.author,
    kind: row.kind === 'audio' ? 'audio' : 'ebook',
    coverPath: row.cover_path,
    createdBy: row.created_by,
    sharerName: row.display_name ?? row.username,
  };
}

/** The book as the public teaser describes it. */
export function sharedBookOf(share: ActiveShare): SharedBook {
  return {
    id: share.bookId,
    title: share.title,
    author: share.author,
    kind: share.kind,
    hasCover: Boolean(share.coverPath) && fs.existsSync(String(share.coverPath)),
  };
}

/** The caller's live share for this book, or null: a look, not a mint. */
export function existingShare(db: DB, bookId: string, userId: string): string | null {
  const row = db
    .prepare(
      `SELECT token FROM book_shares WHERE book_id = ? AND created_by = ? AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(bookId, userId) as { token: string } | undefined;
  return row?.token ?? null;
}

/** The caller's live share for this book, minting one when there is none. */
export function getOrCreateShare(db: DB, bookId: string, userId: string): string {
  const existing = db
    .prepare(
      `SELECT token FROM book_shares WHERE book_id = ? AND created_by = ? AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(bookId, userId) as { token: string } | undefined;
  if (existing) return existing.token;
  const token = newShareToken();
  db.prepare(
    'INSERT INTO book_shares (token, book_id, created_by, created_at) VALUES (?, ?, ?, ?)',
  ).run(token, bookId, userId, nowIso());
  return token;
}

/** Revoke: the creator's own share, or any share for an admin. */
export function revokeShare(db: DB, token: string, by: { id: string; role: string }): boolean {
  if (!SHARE_TOKEN_RE.test(token)) return false;
  const res =
    by.role === 'admin'
      ? db
          .prepare('UPDATE book_shares SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL')
          .run(nowIso(), token)
      : db
          .prepare(
            `UPDATE book_shares SET revoked_at = ?
              WHERE token = ? AND created_by = ? AND revoked_at IS NULL`,
          )
          .run(nowIso(), token, by.id);
  return Number(res.changes) > 0;
}

export function countShareOpen(db: DB, token: string): void {
  db.prepare('UPDATE book_shares SET opens = opens + 1 WHERE token = ?').run(token);
}

/**
 * Where this server is reached from outside: the configured public address,
 * else the origin this very request arrived on. The fallback is right for a
 * library nobody reaches from outside - exactly the case where nobody has
 * set `publicUrl`.
 */
export function publicBase(db: DB, config: EnvConfig, req: FastifyRequest): string {
  const configured = resolveSettings(db, config).values.publicUrl.replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.host}`;
}

/* ------------------------------------------------------------ join requests */

interface JoinRequestRow {
  id: string;
  email: string;
  name: string | null;
  message: string | null;
  share_token: string | null;
  status: 'pending' | 'approved' | 'declined';
  invite_id: string | null;
  created_at: string;
  decided_at: string | null;
}

/** How long a decided request stays on the admin's list. */
const DECIDED_KEEP_DAYS = 30;

/**
 * Leave a request. One open request per address, however many links it
 * arrives through: the partial unique index on (email) WHERE pending makes
 * a second ask while the first waits a no-op, and the answer is the same
 * `pending` either way - the person asking already knows their own address.
 */
export function createJoinRequest(
  db: DB,
  input: { email: string; name?: string; message?: string; shareToken: string },
): { status: 'pending' | 'approved'; created: boolean } {
  const latest = latestJoinRequest(db, input.email, input.shareToken);
  if (latest?.status === 'pending') return { status: 'pending', created: false };
  // Approved and the invitation still open: nothing to ask for again.
  if (latest?.status === 'approved' && openInvite(db, latest.invite_id)) {
    return { status: 'approved', created: false };
  }
  try {
    db.prepare(
      `INSERT INTO join_requests (id, email, name, message, share_token, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      newId('jr'),
      input.email,
      input.name ?? null,
      input.message ?? null,
      input.shareToken,
      nowIso(),
    );
  } catch (err) {
    // The same address asked through another link a moment ago.
    if (String((err as Error).message).includes('UNIQUE')) {
      return { status: 'pending', created: false };
    }
    throw err;
  }
  return { status: 'pending', created: true };
}

/**
 * The newest request this address made THROUGH THIS LINK. Keyed on both,
 * so a share link only ever speaks for requests that came in through it:
 * knowing someone's address and a different link tells you nothing.
 */
function latestJoinRequest(db: DB, email: string, shareToken: string): JoinRequestRow | undefined {
  return db
    .prepare(
      `SELECT * FROM join_requests WHERE email = ? AND share_token = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(email, shareToken) as JoinRequestRow | undefined;
}

function openInvite(db: DB, inviteId: string | null): boolean {
  if (!inviteId) return false;
  return (
    db
      .prepare('SELECT 1 FROM invites WHERE id = ? AND used_at IS NULL AND expires_at > ?')
      .get(inviteId, nowIso()) !== undefined
  );
}

/**
 * The invitation code an approval mints is not stored anywhere in the clear
 * - the invites table keeps a hash, like every other invitation - but the
 * person it is for has to be handed it later, when they come back to the
 * link. So it is DERIVED: an HMAC of the request id under the session
 * secret, fed to the same code generator every invitation uses. Anyone
 * holding the database sees a hash; only the server can say the code, and
 * it says it only to an approved request's own address on its own link.
 */
export function deriveInviteToken(secret: string, requestId: string): string {
  let counter = 0;
  return makeInviteCode((n) => {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const block = createHmac('sha256', secret)
        .update(`join-invite:${requestId}:${counter++}`)
        .digest();
      const take = Math.min(block.length, n - filled);
      out.set(block.subarray(0, take), filled);
      filled += take;
    }
    return out;
  });
}

/** What the share page learns by the address it remembers. */
export function joinStatus(
  db: DB,
  secret: string,
  email: string,
  shareToken: string,
): JoinStatusResponse {
  const row = latestJoinRequest(db, email, shareToken);
  if (!row) return { status: 'none' };
  if (row.status !== 'approved') return { status: row.status };
  // Approved, but the invitation has been used or has lapsed: the status
  // still says so, and the page offers sign-in rather than a form that
  // would fail. Asking again is allowed - a lapsed approval is not a no.
  if (!openInvite(db, row.invite_id)) return { status: 'approved' };
  return { status: 'approved', inviteToken: deriveInviteToken(secret, row.id) };
}

export function pendingJoinRequestCount(db: DB): number {
  return Number(
    (
      db.prepare("SELECT COUNT(*) AS c FROM join_requests WHERE status = 'pending'").get() as {
        c: number;
      }
    ).c,
  );
}

export function getJoinRequest(db: DB, id: string): JoinRequestRow | undefined {
  return db.prepare('SELECT * FROM join_requests WHERE id = ?').get(id) as
    JoinRequestRow | undefined;
}

/** Pending requests, oldest first, then what was decided recently. */
export function listJoinRequests(db: DB): JoinRequestDto[] {
  const since = new Date(Date.now() - DECIDED_KEEP_DAYS * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT r.*, b.id AS book_id, b.title, b.author, b.kind, b.cover_path,
              u.display_name, u.username
         FROM join_requests r
         LEFT JOIN book_shares s ON s.token = r.share_token
         LEFT JOIN books b ON b.id = s.book_id
         LEFT JOIN users u ON u.id = s.created_by
        WHERE r.status = 'pending' OR r.decided_at >= ?
        ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,
                 CASE r.status WHEN 'pending' THEN r.created_at ELSE '' END ASC,
                 r.decided_at DESC
        LIMIT 200`,
    )
    .all(since) as unknown as (JoinRequestRow & {
    book_id: string | null;
    title: string | null;
    author: string | null;
    kind: string | null;
    cover_path: string | null;
    display_name: string | null;
    username: string | null;
  })[];
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    message: r.message,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    book:
      r.book_id && r.title
        ? {
            id: r.book_id,
            title: r.title,
            author: r.author,
            kind: r.kind === 'audio' ? 'audio' : 'ebook',
            hasCover: Boolean(r.cover_path) && fs.existsSync(String(r.cover_path)),
          }
        : null,
    sharedBy: r.username ? { displayName: r.display_name ?? r.username } : null,
  }));
}

/** Record a decision on a request that is still pending. */
export function decideJoinRequest(
  db: DB,
  id: string,
  decision: { status: 'approved' | 'declined'; by: string; inviteId?: string },
): boolean {
  const res = db
    .prepare(
      `UPDATE join_requests SET status = ?, invite_id = ?, decided_at = ?, decided_by = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(decision.status, decision.inviteId ?? null, nowIso(), decision.by, id);
  return Number(res.changes) > 0;
}
