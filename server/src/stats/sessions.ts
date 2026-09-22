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
 * from its first event to its last, less the stretches nobody was reading
 * (`active_ms`, see ACTIVE_STEP_CAP_MS); distance is the sum of FORWARD
 * movement in pct, so re-reading a page counts as time spent and not as
 * ground covered. A small step BACK is counted on its own account, as a
 * re-read (`rereads`, `reread_pct`, see REREAD_MAX_PCT): the thread slipped
 * and the reader went back for it. Timestamps are the event's corrected,
 * server-clamped time - the one the pipeline judged it by - never the raw
 * client clock.
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

/**
 * The most one step between two events can count as reading.
 *
 * An ebook records a checkpoint when the position moves - a page turned, a
 * scroll settled - and nothing while the same page stays on screen. So the
 * time between two checkpoints is time on one page, and a page cannot hold
 * a reader for ever: five minutes covers a slow reader on a dense spread,
 * and a device left open on a page and picked up again within the session
 * gap counts five minutes rather than nine. Audio checkpoints arrive every
 * fifteen seconds while the narration plays and stop when it pauses, so a
 * step longer than a heartbeat and a bit is a pause, and a pause is not
 * listening. What a sitting keeps in `active_ms` is the sum of its steps,
 * each capped this way.
 */
export const ACTIVE_STEP_CAP_MS: Record<SessionMedium, number> = {
  ebook: 5 * 60_000,
  audio: 20_000,
};

/** How much of one step between two events was reading. */
function counted(medium: SessionMedium, stepMs: number): number {
  return Math.max(0, Math.min(stepMs, ACTIVE_STEP_CAP_MS[medium]));
}

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
  /** Null on a sitting from before active time was kept: wall-clock stands for it. */
  active_ms: number | null;
  /** Steps back of a page or two, and the ground they went back over. */
  rereads: number;
  reread_pct: number;
}

const COLS =
  'id, started_at, ended_at, pct_start, pct_end, pct_advanced, events, active_ms, rereads, reread_pct';
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
 * The most of a book a step back may cover and still be a re-read.
 *
 * A re-read is going back a little, for the thread: the eye reached the
 * bottom of a page and the sense had not come with it, so back a page it
 * went. Further back than that is navigation - a chapter picked from the
 * contents, a bookmark, a reset to the start - and navigation says nothing
 * about how the reading went. The fold only has `pct`, so "a page or two"
 * is expressed as a share of the book: for an ebook, PLAUSIBLE_STEP_FLOOR's
 * own measure of a page, two percent - a page of the shortest book, a few
 * pages of a novel, and in either case far short of a chapter. For audio the
 * skip-back button is fifteen seconds and people tap it a few times in a
 * row; three minutes covers that, and one and a half percent is three
 * minutes of a three-hour audiobook. Of a ten-hour one it is nine minutes,
 * wide for a skip-back, still well inside any chapter.
 */
export const REREAD_MAX_PCT: Record<SessionMedium, number> = {
  ebook: PLAUSIBLE_STEP_FLOOR,
  audio: 0.015,
};
/**
 * A step back smaller than this is jitter, not a re-read: a scroll settling
 * a few lines up, a re-layout after a font change, a heartbeat reporting the
 * paragraph the page begins with. A twentieth of a percent of the book is a
 * few lines of a novel and a couple of seconds of narration.
 */
export const REREAD_JITTER_PCT = 0.0005;

/**
 * The distance a step back covers when it is a re-read, else zero: a step
 * back by more than jitter and no further than a page or two, in the
 * measure of its medium.
 */
const reread = (medium: SessionMedium, from: number, to: number): number => {
  const back = from - to;
  return back > REREAD_JITTER_PCT && back <= REREAD_MAX_PCT[medium] ? back : 0;
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
       (user_id, book_id, medium, device_id, started_at, ended_at, pct_start, pct_end, pct_advanced,
        events, active_ms, rereads, reread_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 0, 0)`,
  );
  // `active_ms + ?` leaves a null null: a sitting from before active time was
  // kept goes on being measured by the clock, never by half a rule. The
  // re-read counters have no such past - a sitting from before they were
  // kept holds zeros, and a step back into it counts from there.
  const extend = db.prepare(
    `UPDATE reading_sessions SET ended_at = ?, pct_end = ?, pct_advanced = pct_advanced + ?,
       events = events + 1, active_ms = active_ms + ?,
       rereads = rereads + ?, reread_pct = reread_pct + ? WHERE id = ?`,
  );
  const extendBack = db.prepare(
    `UPDATE reading_sessions SET started_at = ?, pct_start = ?, pct_advanced = pct_advanced + ?,
       events = events + 1, active_ms = active_ms + ?,
       rereads = rereads + ?, reread_pct = reread_pct + ? WHERE id = ?`,
  );
  const touch = db.prepare('UPDATE reading_sessions SET events = events + 1 WHERE id = ?');
  const merge = db.prepare(
    `UPDATE reading_sessions SET ended_at = ?, pct_end = ?, pct_advanced = ?, events = ?, active_ms = ?,
       rereads = ?, reread_pct = ? WHERE id = ?`,
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
        const toPrev = at - Date.parse(prev.ended_at);
        const toNext = Date.parse(next.started_at) - at;
        // The bridging event makes two steps, one to each half, and either
        // may be a step back; both halves bring their own counts.
        const backIn = reread(medium, prev.pct_end, pct);
        const backOut = reread(medium, pct, next.pct_start);
        merge.run(
          next.ended_at,
          next.pct_end,
          prev.pct_advanced +
            forward(prev.pct_end, pct, toPrev) +
            forward(pct, next.pct_start, toNext) +
            next.pct_advanced,
          prev.events + next.events + 1,
          prev.active_ms === null || next.active_ms === null
            ? null
            : prev.active_ms + counted(medium, toPrev) + counted(medium, toNext) + next.active_ms,
          prev.rereads + (backIn > 0 ? 1 : 0) + (backOut > 0 ? 1 : 0) + next.rereads,
          prev.reread_pct + backIn + backOut + next.reread_pct,
          prev.id,
        );
        remove.run(next.id);
        return 'merged';
      }
      if (prev && joinsPrev) {
        const step = at - Date.parse(prev.ended_at);
        const back = reread(medium, prev.pct_end, pct);
        extend.run(
          atIso,
          pct,
          forward(prev.pct_end, pct, step),
          counted(medium, step),
          back > 0 ? 1 : 0,
          back,
          prev.id,
        );
        return 'extended';
      }
      if (next && joinsNext) {
        // Older than the sitting it belongs to - an offline queue replaying
        // behind the position that ended it - so the sitting began earlier.
        const step = Date.parse(next.started_at) - at;
        const back = reread(medium, pct, next.pct_start);
        extendBack.run(
          atIso,
          pct,
          forward(pct, next.pct_start, step),
          counted(medium, step),
          back > 0 ? 1 : 0,
          back,
          next.id,
        );
        return 'extended-back';
      }
      insert.run(userId, bookId, medium, deviceId, atIso, atIso, pct, pct);
      return 'new';
    },
  };
}
