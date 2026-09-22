import { type DB } from '../db/index.js';
import { prepareSessionFolder } from './sessions.js';

/**
 * Derive `reading_sessions` from the progress history the diary does not
 * cover yet.
 *
 * Sessions are folded at ingest from the day the table exists; what a person
 * read before that is only in progress_events - explicit events for ever,
 * heartbeats for the last thirty days (compactProgressHistory) - and without
 * this the stats page of an existing library would begin on upgrade day.
 * This walks that history, per (person, book, device, medium) and in time
 * order, through the very fold the ingest hook uses, so a derived session
 * and a live one are the same shape by construction.
 *
 * Per key, only events newer than the key's newest sitting are folded. On
 * a first start that is everything; on every later start it is nothing,
 * since the hook folded each event as it arrived; and after a migration
 * that cleared the recent sittings to re-derive them under a new rule, it
 * is exactly those. Keys never overlap in time with one another, so one
 * person's other book, or the same book on a laptop, cannot hide a sitting.
 * Bounded: one key's rows at a time, read through a cursor rather than
 * loaded whole; one transaction, so a start that dies half way changes
 * nothing and the next start simply does it again.
 */
export function backfillReadingSessions(db: DB, log: { info: (msg: string) => void }): number {
  // Only people who still exist: progress_events has no foreign key on
  // user_id, so a deleted account can leave rows behind, and a session for
  // them would trip the one reading_sessions does have.
  const keys = db
    .prepare(
      `SELECT DISTINCT e.user_id AS user, e.book_id AS book, e.device_id AS device, e.medium
         FROM progress_events e JOIN users u ON u.id = e.user_id WHERE e.applied = 1
        ORDER BY e.user_id, e.book_id, e.device_id, e.medium`,
    )
    .all() as { user: string; book: string; device: string; medium: string }[];
  if (keys.length === 0) return 0;
  const newest = db.prepare(
    `SELECT MAX(ended_at) AS t FROM reading_sessions
      WHERE user_id = ? AND book_id = ? AND device_id = ? AND medium = ?`,
  );
  // effective_at is the corrected, clamped time the pipeline judged an event
  // by - the clock the ingest hook folds on. Rows older than that column
  // fall back to the raw client time, which is all they ever had.
  const events = db.prepare(
    `SELECT book_id, device_id, medium, locator_json, COALESCE(effective_at, occurred_at) AS at
       FROM progress_events
      WHERE user_id = ? AND book_id = ? AND device_id = ? AND medium = ? AND applied = 1
        AND COALESCE(effective_at, occurred_at) > ?
      ORDER BY COALESCE(effective_at, occurred_at), id`,
  );
  const folder = prepareSessionFolder(db);
  const before = count(db);
  let folded = 0;
  const people = new Set<string>();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const key of keys) {
      if (key.medium !== 'ebook' && key.medium !== 'audio') continue;
      const since =
        (newest.get(key.user, key.book, key.device, key.medium) as { t: string | null }).t ?? '';
      for (const raw of events.iterate(key.user, key.book, key.device, key.medium, since)) {
        const row = raw as unknown as EventRow;
        const at = Date.parse(String(row.at));
        const pct = pctOf(row.locator_json);
        if (!Number.isFinite(at) || pct === null) continue;
        folder.fold(
          key.user,
          row.book_id,
          key.medium,
          row.device_id,
          new Date(at).toISOString(),
          pct,
        );
        folded += 1;
        people.add(key.user);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const derived = count(db) - before;
  if (folded > 0) {
    log.info(
      `Derived ${derived} reading sessions from ${folded} progress events of ${people.size} ` +
        (people.size === 1 ? 'person' : 'people'),
    );
  }
  return derived;
}

function count(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM reading_sessions').get() as { c: number }).c;
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
