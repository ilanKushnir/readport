import {
  clampEventTime,
  decideApply,
  isExplicit,
  progressStateSchema,
  type ClaimView,
  type ProgressAck,
  type ProgressEvent,
  type ProgressState,
} from '@readport/shared';
import { type DB, nowIso } from '../db/index.js';
import { prepareSessionFolder } from '../stats/sessions.js';

/**
 * Authoritative progress pipeline: append-only event history + reconciled
 * current state with a revision counter. Decision logic lives in
 * @readport/shared (decideApply) so client resume math matches exactly.
 *
 * Client timestamps are diagnostic metadata: the state's claim time is the
 * server-clamped effective time, so a device clock in the future cannot
 * permanently poison reconciliation for other devices.
 */

/**
 * Read the stored row, reporting its existence separately from whether it
 * could be understood. A row that fails to parse still occupies the
 * (user_id, book_id) primary key: treating it as absent would make the next
 * event INSERT on top of it, and the collision would fail the whole batch -
 * every book behind it in the client's queue with it. Unreadable is therefore
 * "present but carries nothing forward", and the next event heals it.
 */
function readProgressRow(
  db: DB,
  userId: string,
  bookId: string,
): { exists: boolean; state: ProgressState | null } {
  const row = db
    .prepare('SELECT * FROM progress_state WHERE user_id = ? AND book_id = ?')
    .get(userId, bookId) as Record<string, unknown> | undefined;
  if (!row) return { exists: false, state: null };
  try {
    const parsed = progressStateSchema.safeParse({
      bookId,
      generation: getProgressGeneration(db, userId, bookId),
      revision: Number(row.revision),
      locator: JSON.parse(String(row.locator_json)),
      intent: String(row.intent),
      occurredAt: String(row.occurred_at),
      sessionId: String(row.session_uuid),
      deviceId: String(row.device_id),
      seq: Number(row.seq),
      updatedAt: String(row.updated_at),
      finished: Number(row.finished) === 1,
    });
    return { exists: true, state: parsed.success ? parsed.data : null };
  } catch {
    return { exists: true, state: null };
  }
}

export function getProgressState(db: DB, userId: string, bookId: string): ProgressState | null {
  return readProgressRow(db, userId, bookId).state;
}

/**
 * The one definition of "reading now", as SQL over `progress_state p` joined
 * to `books b`, with the user id as its single parameter: this person's own
 * progress, not finished, strictly between the start and the end, on a book
 * that is still on disk.
 *
 * The sidebar count, the Reading Now shelf, the legacy `in-progress` filter
 * and the home page's Continue band all read this one fragment. They used to
 * carry four private copies of the same predicate, which agreed only until
 * someone edited one of them.
 *
 * The alias arguments exist for the one query that has to apply the predicate
 * TWICE - once per edition of a pair - to count the rows a collapsed shelf
 * actually shows. Same rule, same place, said about two different tables.
 */
export const readingNowWhere = (p = 'p', b = 'b'): string =>
  `${p}.user_id = ? AND ${p}.finished = 0 AND ${b}.scan_state != 'missing'
  AND json_extract(${p}.locator_json, '$.pct') > 0 AND json_extract(${p}.locator_json, '$.pct') < 1`;
export const READING_NOW_WHERE = readingNowWhere();

/** The Finished shelf's counterpart: read to the end, and still on disk. */
export const finishedWhere = (p = 'p', b = 'b'): string =>
  `${p}.user_id = ? AND ${p}.finished = 1 AND ${b}.scan_state != 'missing'`;
export const FINISHED_WHERE = finishedWhere();

/** Whether a summary's progress meets the Reading Now predicate above. */
export function isReadingNow(progress: { pct: number; finished: boolean } | null): boolean {
  return !!progress && !progress.finished && progress.pct > 0 && progress.pct < 1;
}

/** Selected edition only. A barrier prevents an old offline queue restoring deleted progress. */
export function getProgressGeneration(db: DB, userId: string, bookId: string): number {
  return (
    (
      db
        .prepare('SELECT generation FROM progress_resets WHERE user_id = ? AND book_id = ?')
        .get(userId, bookId) as { generation: number } | undefined
    )?.generation ?? 0
  );
}

export function resetProgress(db: DB, userId: string, bookId: string): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM progress_events WHERE user_id = ? AND book_id = ?').run(userId, bookId);
    db.prepare('DELETE FROM progress_state WHERE user_id = ? AND book_id = ?').run(userId, bookId);
    db.prepare(
      'INSERT INTO progress_resets (user_id, book_id, generation) VALUES (?, ?, 1) ON CONFLICT(user_id, book_id) DO UPDATE SET generation = generation + 1',
    ).run(userId, bookId);
    const generation = getProgressGeneration(db, userId, bookId);
    db.exec('COMMIT');
    return generation;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * A batch is a queue drain and routinely spans several books (read one,
 * listened to another). Every book it touched comes back, so each one's
 * client-side revision and cached position stay current - a book left with a
 * stale revision sends a stale baseRevision next time, and reconciliation
 * silently degrades from causal ordering to clock comparison.
 */
export interface ProgressBatchAck extends ProgressAck {
  states: ProgressState[];
}

export function applyProgressEvents(
  db: DB,
  userId: string,
  events: ProgressEvent[],
  opts: {
    /**
     * Added to every event's client time before it is judged: the measured
     * difference between this server's clock and the sending device's, so a
     * slow clock does not lose its owner's explicit moves. See
     * `clockCorrectionMs` in the shared package.
     */
    skewMs?: number;
  } = {},
): ProgressBatchAck {
  const results: ProgressAck['results'] = [];
  const books = new Set<string>();
  const skewMs = Number.isFinite(opts.skewMs) ? opts.skewMs! : 0;
  for (const ev of events) books.add(ev.bookId);
  if (events.length === 0) return { results, state: null, states: [] };
  // The stats record. Every event that moves the position is also one more
  // moment of a sitting, and folding it inside the same transaction is what
  // keeps the diary and the position from ever disagreeing (stats/sessions.ts).
  const sessions = prepareSessionFolder(db);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const ev of events) {
      // A checkpoint stamped with somebody else's account never becomes this
      // person's position, whatever session carried it here. Durable verdict:
      // the client drops it rather than retrying.
      if (ev.ownerId !== undefined && ev.ownerId !== userId) {
        results.push({ eventId: ev.eventId, status: 'rejected', reason: 'owner-mismatch' });
        continue;
      }
      const dup = db
        .prepare('SELECT id FROM progress_events WHERE user_id = ? AND event_id = ?')
        .get(userId, ev.eventId);
      if (dup) {
        results.push({ eventId: ev.eventId, status: 'duplicate' });
        continue;
      }
      const nowMs = Date.now();
      // Server-observed ordering: correct the client clock by the skew the
      // batch measured, then clamp so it can never lead server time by more
      // than the skew window. The decision below judges the corrected time;
      // the raw client occurredAt is preserved in the event log as
      // diagnostics only.
      const judged =
        skewMs === 0
          ? ev
          : { ...ev, occurredAt: new Date(Date.parse(ev.occurredAt) + skewMs).toISOString() };
      const effectiveAt = new Date(
        clampEventTime(Date.parse(judged.occurredAt), nowMs),
      ).toISOString();
      const { exists, state } = readProgressRow(db, userId, ev.bookId);
      const generation = getProgressGeneration(db, userId, ev.bookId);
      if (
        (ev.generation ?? 0) !== generation ||
        (generation > 0 && !state && !isExplicit(ev.intent))
      ) {
        // Do not rebuild history that the reader explicitly erased.
        results.push({ eventId: ev.eventId, status: 'recorded', reason: 'progress-reset' });
        continue;
      }
      const claim: ClaimView | null = state
        ? {
            sessionId: state.sessionId,
            deviceId: state.deviceId,
            explicitAt: state.occurredAt,
            seq: state.seq,
            intent: state.intent,
            revision: state.revision,
          }
        : null;
      const decision = decideApply(judged, claim, nowMs);
      db.prepare(
        `INSERT INTO progress_events
           (user_id, book_id, event_id, device_id, session_uuid, seq, intent, medium, locator_json, occurred_at, effective_at, base_revision, received_at, applied, reject_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        userId,
        ev.bookId,
        ev.eventId,
        ev.deviceId,
        ev.sessionId,
        ev.seq,
        ev.intent,
        ev.locator.medium,
        JSON.stringify(ev.locator),
        ev.occurredAt,
        effectiveAt,
        ev.baseRevision ?? null,
        nowIso(),
        decision.apply ? 1 : 0,
        decision.apply ? null : decision.reason,
      );
      if (!decision.apply) {
        results.push({ eventId: ev.eventId, status: 'recorded', reason: decision.reason });
        continue;
      }
      // The stored claim time is the server-clamped effective time. A
      // heartbeat keeps the standing explicit claim (state freshness tracks
      // updated_at); everything else, including a heartbeat with no claim to
      // inherit, states its own.
      const inherits = !isExplicit(ev.intent) && state !== null;
      // Finishing is a claim about the book, not about this event. Any
      // explicit intent used to clear it, so simply reopening a finished book
      // - or jumping to a bookmark in it - silently un-finished it, and
      // nothing in the app can set the flag again except reading to the end a
      // second time. It survives unless the reader has actually gone back
      // into the book.
      const stillAtEnd = ev.locator.pct >= 0.95;
      const finished =
        ev.intent === 'finish' ? 1 : state?.finished && (inherits || stillAtEnd) ? 1 : 0;
      if (exists) {
        db.prepare(
          `UPDATE progress_state SET revision = revision + 1, locator_json = ?, intent = ?,
             occurred_at = ?, session_uuid = ?, device_id = ?, seq = ?, finished = ?, updated_at = ?
           WHERE user_id = ? AND book_id = ?`,
        ).run(
          JSON.stringify(ev.locator),
          ev.intent,
          inherits ? state!.occurredAt : effectiveAt,
          inherits ? state!.sessionId : ev.sessionId,
          ev.deviceId,
          ev.seq,
          finished,
          nowIso(),
          userId,
          ev.bookId,
        );
      } else {
        db.prepare(
          `INSERT INTO progress_state
             (user_id, book_id, revision, locator_json, intent, occurred_at, session_uuid, device_id, seq, finished, updated_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          userId,
          ev.bookId,
          JSON.stringify(ev.locator),
          ev.intent,
          effectiveAt,
          ev.sessionId,
          ev.deviceId,
          ev.seq,
          finished,
          nowIso(),
        );
      }
      sessions.fold(userId, ev.bookId, ev.locator.medium, ev.deviceId, effectiveAt, ev.locator.pct);
      results.push({ eventId: ev.eventId, status: 'applied' });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const states: ProgressState[] = [];
  for (const bookId of books) {
    const state = getProgressState(db, userId, bookId);
    if (state) states.push(state);
  }
  const lastBook = events[events.length - 1]?.bookId;
  return {
    results,
    state: states.find((s) => s.bookId === lastBook) ?? null,
    states,
    generations: [...books].map((bookId) => ({
      bookId,
      generation: getProgressGeneration(db, userId, bookId),
    })),
  };
}

/**
 * Compact old heartbeat history (keep explicit events + recent heartbeats).
 *
 * Applied heartbeats are pruned too: the current position lives in
 * progress_state, and history is diagnostic only (capped at 100 rows when
 * read). Keeping them meant a heavy listener's row count grew forever.
 */
export function compactProgressHistory(db: DB, keepDays = 30): number {
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();
  const batch = 5000;
  // Bounded batches, each its own transaction: the first run on a server that
  // has been keeping every applied heartbeat faces years of backlog, and one
  // DELETE that large would hold the write lock past the busy timeout of a
  // checkpoint arriving at the same moment.
  const stmt = db.prepare(
    `DELETE FROM progress_events WHERE id IN (
       SELECT id FROM progress_events WHERE intent = 'heartbeat' AND received_at < ? LIMIT ${batch})`,
  );
  let total = 0;
  for (;;) {
    const n = Number(stmt.run(cutoff).changes);
    total += n;
    if (n < batch) return total;
  }
}
