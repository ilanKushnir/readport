import { type DB } from '../db/index.js';

/**
 * Folding applied progress events into `reading_sessions`, the durable
 * record behind the stats page. Migration 17 says why progress_events cannot
 * be that record: applied heartbeats are compacted away after thirty days.
 *
 * A session is one sitting with one book on one device, in one medium.
 * Every event the progress pipeline ACCEPTS is folded here, inside the same
 * transaction that moved the position, so the diary can never disagree with
 * the position it was written from. Time inside a session is wall-clock,
 * from its first event to its last; distance is the sum of FORWARD movement
 * in pct, so re-reading a page counts as time spent and not as ground
 * covered. Timestamps are the event's corrected, server-clamped time - the
 * one the pipeline judged it by - never the raw client clock.
 */

/**
 * How long a reader may be silent before the next event is a new sitting.
 *
 * Ten minutes. A page turn or a fifteen-second heartbeat arrives far inside
 * that while a book is actually open, so a slow chapter does not split a
 * sitting; and a reader who puts the book down for lunch has ended one, ten
 * minutes being about the shortest lunch there is.
 */
export const SESSION_GAP_MS = 10 * 60_000;

export type SessionMedium = 'ebook' | 'audio';

/** What folding an event did, for callers that count or test. */
export type SessionFoldOutcome = 'new' | 'extended' | 'extended-back' | 'inside' | 'merged';

export interface SessionFolder {
  /**
   * Fold one applied event into the sessions of its (user, book, medium,
   * device) key. `atIso` is the event's corrected, clamped time as an ISO
   * string and `pct` its position. Runs inside the caller's transaction and
   * opens none of its own.
   */
  fold(
    userId: string,
    bookId: string,
    medium: SessionMedium,
    deviceId: string,
    atIso: string,
    pct: number,
  ): SessionFoldOutcome;
}

interface Neighbour {
  side: 'prev' | 'next';
  id: number;
  started_at: string;
  ended_at: string;
  pct_start: number;
  pct_end: number;
  pct_advanced: number;
  events: number;
}

const COLS = 'id, started_at, ended_at, pct_start, pct_end, pct_advanced, events';
const KEY = 'user_id = ? AND book_id = ? AND medium = ? AND device_id = ?';

/**
 * The most of a book a step may cover and still be reading: nine percent a
 * minute is a skim of a short story, and beyond anything a novel allows.
 * Faster than that between two events is a jump - the contents, the slider,
 * a highlight followed - and a jump is navigation, not ground covered.
 */
export const PLAUSIBLE_PCT_PER_SECOND = 0.0015;
/**
 * A page turn moments after the last event covers a page, however little
 * time passed; a whole page of a short book is a couple of percent.
 */
export const PLAUSIBLE_STEP_FLOOR = 0.02;

/**
 * Forward distance only, and only at a pace a person reads at. Going back is
 * time spent and not ground covered; so is skipping ahead - the position
 * moves either way, the distance only when the step could have been read.
 */
const forward = (from: number, to: number, elapsedMs: number): number => {
  const step = to - from;
  if (step <= 0) return 0;
  const plausible = Math.max(PLAUSIBLE_STEP_FLOOR, (elapsedMs / 1000) * PLAUSIBLE_PCT_PER_SECOND);
  return step <= plausible ? step : 0;
};

/**
 * Prepare the statements once per batch; each event then costs one SELECT
 * and one write (two, in the rare merge). Timestamps are ISO-8601 UTC in one
 * fixed format, so they compare correctly as text in SQL.
 */
export function prepareSessionFolder(db: DB): SessionFolder {
  // The two sessions an event could belong to: the last that began at or
  // before it, and the first that began after it. Events usually arrive in
  // order, so the second is usually nothing and the first is the sitting
  // being extended; an offline queue replaying older events is what the
  // second is for. Sessions of one key never overlap - this is their only
  // writer, and it merges rather than lets them - so nothing else qualifies.
  const neighbours = db.prepare(
    `SELECT 'prev' AS side, * FROM (
       SELECT ${COLS} FROM reading_sessions WHERE ${KEY} AND started_at <= ?
       ORDER BY started_at DESC LIMIT 1)
     UNION ALL
     SELECT 'next' AS side, * FROM (
       SELECT ${COLS} FROM reading_sessions WHERE ${KEY} AND started_at > ?
       ORDER BY started_at ASC LIMIT 1)`,
  );
  const insert = db.prepare(
    `INSERT INTO reading_sessions
       (user_id, book_id, medium, device_id, started_at, ended_at, pct_start, pct_end, pct_advanced, events)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
  );
  const extend = db.prepare(
    `UPDATE reading_sessions SET ended_at = ?, pct_end = ?, pct_advanced = pct_advanced + ?,
       events = events + 1 WHERE id = ?`,
  );
  const extendBack = db.prepare(
    `UPDATE reading_sessions SET started_at = ?, pct_start = ?, pct_advanced = pct_advanced + ?,
       events = events + 1 WHERE id = ?`,
  );
  const touch = db.prepare('UPDATE reading_sessions SET events = events + 1 WHERE id = ?');
  const merge = db.prepare(
    'UPDATE reading_sessions SET ended_at = ?, pct_end = ?, pct_advanced = ?, events = ? WHERE id = ?',
  );
  const remove = db.prepare('DELETE FROM reading_sessions WHERE id = ?');

  return {
    fold(userId, bookId, medium, deviceId, atIso, pct) {
      const at = Date.parse(atIso);
      const rows = neighbours.all(
        userId,
        bookId,
        medium,
        deviceId,
        atIso,
        userId,
        bookId,
        medium,
        deviceId,
        atIso,
      ) as unknown as Neighbour[];
      const prev = rows.find((r) => r.side === 'prev');
      const next = rows.find((r) => r.side === 'next');
      // Inside a sitting's span already: a replayed event whose time the
      // session covers. One more event of that sitting; with no neighbours
      // to measure against, its position adds nothing to the distance.
      if (prev && atIso < prev.ended_at) {
        touch.run(prev.id);
        return 'inside';
      }
      const joinsPrev = prev !== undefined && at - Date.parse(prev.ended_at) <= SESSION_GAP_MS;
      const joinsNext = next !== undefined && Date.parse(next.started_at) - at <= SESSION_GAP_MS;
      if (prev && next && joinsPrev && joinsNext) {
        // The event bridges two sessions. That is a backlog replaying: the
        // unload beacon delivered the sitting's last position first, the
        // earlier events are now arriving in order, and this one has reached
        // the gap. Without a merge the sitting would stay split in two at
        // the very moment the reader stopped.
        merge.run(
          next.ended_at,
          next.pct_end,
          prev.pct_advanced +
            forward(prev.pct_end, pct, at - Date.parse(prev.ended_at)) +
            forward(pct, next.pct_start, Date.parse(next.started_at) - at) +
            next.pct_advanced,
          prev.events + next.events + 1,
          prev.id,
        );
        remove.run(next.id);
        return 'merged';
      }
      if (prev && joinsPrev) {
        extend.run(atIso, pct, forward(prev.pct_end, pct, at - Date.parse(prev.ended_at)), prev.id);
        return 'extended';
      }
      if (next && joinsNext) {
        // Older than the sitting it belongs to - an offline queue replaying
        // behind the position that ended it - so the sitting began earlier.
        extendBack.run(
          atIso,
          pct,
          forward(pct, next.pct_start, Date.parse(next.started_at) - at),
          next.id,
        );
        return 'extended-back';
      }
      insert.run(userId, bookId, medium, deviceId, atIso, atIso, pct, pct);
      return 'new';
    },
  };
}
