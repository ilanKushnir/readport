import { type Locator, liveNow } from '@readport/shared';
import { type AppContext } from '../context.js';
import { type DB } from '../db/index.js';
import { getProgressState, READING_NOW_WHERE } from '../progress/service.js';
import { readPref } from '../api/routes/prefs.js';
import { defaultFriendColour, type FriendColourId } from './prefs.js';

/**
 * Friendships and what they let two people see of each other.
 *
 * A friendship is one row, asked for by one side and answered by the other
 * (migration 18). Everything here is asked from ONE person's point of view -
 * "my friends", "who may see me" - and the two guards that matter are in
 * `friendProgress`: another person's position is returned only across an
 * ACCEPTED row, and only while that person's own `shareProgress` is on.
 */

/** A person as the friends surface names them: the display name, or the username when there is none. */
export interface Person {
  userId: string;
  username: string;
  displayName: string;
}

export interface FriendshipRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted';
  created_at: string;
  responded_at: string | null;
  /** The OTHER person on the row. */
  user_id: string;
  username: string;
  display_name: string | null;
}

/**
 * Every row this person is on, with the other person joined in - and only
 * while that other person's account is active. A disabled account cannot
 * read alongside anyone; its friendships come back if it is re-enabled.
 *
 * Ordered by when the friendship was MADE (the acceptance, or the request
 * while it is still pending), because that order is what deals the default
 * colours, and it must not change between two requests.
 */
export function friendshipRows(db: DB, userId: string): FriendshipRow[] {
  return db
    .prepare(
      `SELECT f.id, f.requester_id, f.addressee_id, f.status, f.created_at, f.responded_at,
              u.id AS user_id, u.username, u.display_name
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
        WHERE (f.requester_id = ? OR f.addressee_id = ?) AND u.status = 'active'
        ORDER BY COALESCE(f.responded_at, f.created_at), f.created_at, f.id`,
    )
    .all(userId, userId, userId) as unknown as FriendshipRow[];
}

export function personOf(row: {
  user_id: string;
  username: string;
  display_name: string | null;
}): Person {
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name ?? row.username,
  };
}

/** Accepted friends, oldest friendship first. */
export function acceptedFriends(db: DB, userId: string): FriendshipRow[] {
  return friendshipRows(db, userId).filter((r) => r.status === 'accepted');
}

/** The one row between two people, whichever of them asked. */
export function friendshipBetween(
  db: DB,
  a: string,
  b: string,
):
  | { id: string; requester_id: string; addressee_id: string; status: 'pending' | 'accepted' }
  | undefined {
  return db
    .prepare(
      `SELECT id, requester_id, addressee_id, status FROM friendships
        WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
    )
    .get(a, b, b, a) as
    | { id: string; requester_id: string; addressee_id: string; status: 'pending' | 'accepted' }
    | undefined;
}

export function areFriends(db: DB, a: string, b: string): boolean {
  return friendshipBetween(db, a, b)?.status === 'accepted';
}

/** Whether this person lets their friends see where they are. On until they say otherwise. */
export function sharesProgress(ctx: AppContext, userId: string): boolean {
  return readPref(ctx, userId, 'friends')?.shareProgress ?? true;
}

/**
 * The colour `viewerId` sees each of these friends in: the one they chose,
 * or the one dealt by the friend's place in the list.
 */
export function friendColours(
  ctx: AppContext,
  viewerId: string,
  friends: { userId: string }[],
): Map<string, FriendColourId> {
  const chosen = readPref(ctx, viewerId, 'friends')?.colours ?? {};
  return new Map(friends.map((f, i) => [f.userId, chosen[f.userId] ?? defaultFriendColour(i)]));
}

export interface CurrentlyReading {
  bookId: string;
  title: string;
  kind: 'ebook' | 'audio';
  pct: number;
  updatedAt: string;
  /** In it right now: the position moved within the medium's live window. */
  live: boolean;
}

/**
 * The book this person touched most recently and has not finished - the
 * same predicate as their own Reading Now shelf, so a friend's line and the
 * person's own shelf never disagree about what they are in the middle of.
 */
export function currentlyReading(db: DB, userId: string): CurrentlyReading | null {
  const row = db
    .prepare(
      `SELECT b.id, b.title, b.kind, p.locator_json, p.updated_at
         FROM progress_state p JOIN books b ON b.id = p.book_id
        WHERE ${READING_NOW_WHERE} ORDER BY p.updated_at DESC LIMIT 1`,
    )
    .get(userId) as
    | { id: string; title: string; kind: string; locator_json: string; updated_at: string }
    | undefined;
  if (!row) return null;
  let pct = 0;
  let medium: 'ebook' | 'audio' = row.kind === 'audio' ? 'audio' : 'ebook';
  try {
    const locator = JSON.parse(row.locator_json) as { pct?: unknown; medium?: unknown };
    pct = Number(locator.pct) || 0;
    if (locator.medium === 'audio' || locator.medium === 'ebook') medium = locator.medium;
  } catch {
    return null;
  }
  return {
    bookId: row.id,
    title: row.title,
    kind: row.kind === 'audio' ? 'audio' : 'ebook',
    pct,
    updatedAt: row.updated_at,
    live: liveNow(medium, row.updated_at),
  };
}

/**
 * The chapter a locator falls in, by name, or null when the book has no
 * chapter list that can say. Ebook positions resolve through the spine,
 * audio positions through whole-book milliseconds - the same two lookups the
 * reader and the player make for their own "chapter 8".
 */
export function chapterTitleFor(db: DB, bookId: string, locator: Locator): string | null {
  if (locator.medium === 'ebook') {
    const row = db
      .prepare(
        `SELECT title FROM chapters WHERE book_id = ? AND spine_idx IS NOT NULL AND spine_idx <= ?
          ORDER BY spine_idx DESC, idx DESC LIMIT 1`,
      )
      .get(bookId, locator.spineIdx) as { title: string } | undefined;
    return row?.title ?? null;
  }
  let ms = locator.bookMs;
  if (ms === undefined) {
    const track = db
      .prepare('SELECT start_ms_absolute FROM audio_tracks WHERE book_id = ? AND idx = ?')
      .get(bookId, locator.trackIdx) as { start_ms_absolute: number } | undefined;
    ms = Number(track?.start_ms_absolute ?? 0) + locator.positionMs;
  }
  const row = db
    .prepare(
      `SELECT title FROM chapters WHERE book_id = ? AND start_ms IS NOT NULL AND start_ms <= ?
        ORDER BY start_ms DESC, idx DESC LIMIT 1`,
    )
    .get(bookId, ms) as { title: string } | undefined;
  return row?.title ?? null;
}

export interface FriendProgress extends Person {
  colour: FriendColourId;
  locator: Locator;
  pct: number;
  finished: boolean;
  updatedAt: string;
  /** In the book right now, by the medium's live window (see shared liveNow). */
  live: boolean;
  chapterTitle: string | null;
}

/** The other editions this book is linked to: the confirmed or automatic pairs it sits in. */
function linkedEditionsOf(db: DB, bookId: string): string[] {
  const rows = db
    .prepare(
      `SELECT ebook_id, audio_id FROM pairs
        WHERE (ebook_id = ? OR audio_id = ?) AND status IN ('auto', 'confirmed')`,
    )
    .all(bookId, bookId) as { ebook_id: string; audio_id: string }[];
  return rows.map((r) => (r.ebook_id === bookId ? r.audio_id : r.ebook_id));
}

/**
 * Where this person's friends are in one book.
 *
 * The two refusals live here, and nowhere else: someone who is not an
 * accepted friend is simply not in the list, and a friend who has turned
 * sharing off is not in it either. Nothing about either is reported - an
 * absence, not a 403 - because a viewer has no business learning that a
 * particular person has opened a particular book.
 */
export function friendProgress(
  ctx: AppContext,
  viewerId: string,
  bookId: string,
): FriendProgress[] {
  const friends = acceptedFriends(ctx.db, viewerId).map(personOf);
  const colours = friendColours(ctx, viewerId, friends);
  // A linked pair is one work: a friend listening to the audiobook is in
  // the book you are reading, at a comparable fraction of it.
  const editions = [bookId, ...linkedEditionsOf(ctx.db, bookId)];
  const out: FriendProgress[] = [];
  for (const friend of friends) {
    if (!sharesProgress(ctx, friend.userId)) continue;
    let where: { edition: string; state: NonNullable<ReturnType<typeof getProgressState>> } | null =
      null;
    for (const edition of editions) {
      const state = getProgressState(ctx.db, friend.userId, edition);
      if (!state) continue;
      // The edition they touched most recently is where they are.
      if (!where || Date.parse(state.updatedAt) > Date.parse(where.state.updatedAt))
        where = { edition, state };
    }
    if (!where) continue;
    const { edition, state } = where;
    out.push({
      ...friend,
      colour: colours.get(friend.userId)!,
      locator: state.locator,
      pct: state.locator.pct,
      finished: state.finished,
      updatedAt: state.updatedAt,
      live: liveNow(state.locator.medium, state.updatedAt),
      chapterTitle: chapterTitleFor(ctx.db, edition, state.locator),
    });
  }
  // Whoever is in the book right now first; then furthest along; a tie
  // goes to whoever was there most recently.
  return out.sort(
    (a, b) =>
      Number(b.live) - Number(a.live) ||
      Number(b.finished) - Number(a.finished) ||
      b.pct - a.pct ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

/** Requests waiting on this person's answer. */
export function pendingIncomingCount(db: DB, userId: string): number {
  return Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM friendships f JOIN users u ON u.id = f.requester_id
            WHERE f.addressee_id = ? AND f.status = 'pending' AND u.status = 'active'`,
        )
        .get(userId) as { c: number }
    ).c,
  );
}

/**
 * Books put in front of this person that they have neither looked at nor
 * dismissed. Only books still in the library: the inbox skips the others,
 * so counting them would light a dot nothing on the page can put out.
 */
export function unseenRecommendationCount(db: DB, userId: string): number {
  return Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM recommendations r
            WHERE r.to_user_id = ? AND r.seen_at IS NULL AND r.dismissed_at IS NULL
              AND EXISTS (SELECT 1 FROM books b WHERE b.id = r.book_id)`,
        )
        .get(userId) as { c: number }
    ).c,
  );
}
