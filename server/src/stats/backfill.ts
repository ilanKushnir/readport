import { type DB } from '../db/index.js';
import { prepareSessionFolder } from './sessions.js';

/**
 * Derive `reading_sessions` from the progress history that predates them.
 *
 * Sessions are folded at ingest from the day the table exists; what a person
 * read before that is only in progress_events - explicit events for ever,
 * heartbeats for the last thirty days (compactProgressHistory) - and without
 * this the stats page of an existing library would begin on upgrade day.
 * This walks that history once, per user in time order, through the very
 * fold the ingest hook uses, so a derived session and a live one are the
 * same shape by construction.
 *
 * Idempotent: it runs only while reading_sessions is empty, and derives in
 * one transaction, so a start that dies half way leaves the table empty and
 * the next start simply does it again. Bounded: one user's rows at a time,
 * read through a cursor rather than loaded whole.
 */
export function backfillReadingSessions(db: DB, log: { info: (msg: string) => void }): number {
  if (db.prepare('SELECT 1 FROM reading_sessions LIMIT 1').get()) return 0;
  // Only people who still exist: progress_events has no foreign key on
  // user_id, so a deleted account can leave rows behind, and a session for
  // them would trip the one reading_sessions does have.
  const users = db
    .prepare(
      `SELECT DISTINCT e.user_id AS id FROM progress_events e
       JOIN users u ON u.id = e.user_id WHERE e.applied = 1 ORDER BY e.user_id`,
    )
    .all() as { id: string }[];
  if (users.length === 0) return 0;
  // effective_at is the corrected, clamped time the pipeline judged an event
  // by - the clock the ingest hook folds on. Rows older than that column
  // fall back to the raw client time, which is all they ever had.
  const events = db.prepare(
    `SELECT book_id, device_id, medium, locator_json, COALESCE(effective_at, occurred_at) AS at
     FROM progress_events WHERE user_id = ? AND applied = 1
     ORDER BY COALESCE(effective_at, occurred_at), id`,
  );
  const folder = prepareSessionFolder(db);
  let folded = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const user of users) {
      for (const raw of events.iterate(user.id)) {
        const row = raw as unknown as EventRow;
        const at = Date.parse(String(row.at));
        const pct = pctOf(row.locator_json);
        const medium = row.medium;
        if (!Number.isFinite(at) || pct === null || (medium !== 'ebook' && medium !== 'audio')) {
          continue;
        }
        folder.fold(user.id, row.book_id, medium, row.device_id, new Date(at).toISOString(), pct);
        folded += 1;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const derived = (db.prepare('SELECT COUNT(*) AS c FROM reading_sessions').get() as { c: number })
    .c;
  log.info(
    `Derived ${derived} reading sessions from ${folded} progress events of ${users.length} ` +
      (users.length === 1 ? 'person' : 'people'),
  );
  return derived;
}

interface EventRow {
  book_id: string;
  device_id: string;
  medium: string;
  locator_json: string;
  at: string;
}

function pctOf(locatorJson: string): number | null {
  try {
    const pct = (JSON.parse(locatorJson) as { pct?: unknown }).pct;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
    return Math.min(1, Math.max(0, pct));
  } catch {
    return null;
  }
}
