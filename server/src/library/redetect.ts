import { normaliseLanguage } from '@readport/shared';
import { type AppContext, activeDerivedDir } from '../context.js';
import { type DB } from '../db/index.js';
import { detectLanguageFromWindows } from '../alignment/detect-language.js';
import { enqueueJob, jobProgress, type JobRow, type LeaseGuard } from '../jobs/queue.js';
import { recomputeBookAndPartners } from './language.js';
import { proseWindows } from './prose.js';

/**
 * Re-reading the prose of books that were indexed before the detector was
 * what it is now.
 *
 * Which detector read a book is recorded beside its other derived facts,
 * as `langRev` in `meta_json`. Bumping `LANGUAGE_DETECTOR_REV` makes every
 * ebook indexed under an older one stale; the backfill job then reads them
 * a batch at a time, in the light lane behind every scan and index that is
 * waiting, and re-enqueues itself until none are left. It is asked for at
 * startup and costs a lookup when there is nothing to do, so a settled
 * library pays nothing for it after the first pass.
 *
 * Nothing here re-extracts a book. The chapter text is already on disk in
 * the derived directory, and reading twelve windows of it is milliseconds.
 */

/** Bump when the detector's answers should replace the ones already stored. */
export const LANGUAGE_DETECTOR_REV = 2;
export const LANGUAGE_BACKFILL_JOB = 'language-backfill';
/** Books re-read per job run: a bound on how long the light lane is held. */
export const BACKFILL_BATCH = 100;

/** Stamp a book's derived facts with the detector that last read it. */
export function withDetectorRev(meta: Record<string, unknown>): Record<string, unknown> {
  return { ...meta, langRev: LANGUAGE_DETECTOR_REV };
}

/** The ebooks the current detector has not read, oldest ids first. */
const STALE_WHERE = `b.kind = 'ebook' AND b.scan_state = 'ready'
  AND (CASE WHEN json_valid(b.meta_json) THEN COALESCE(json_extract(b.meta_json, '$.langRev'), 0) ELSE 0 END) < ?`;

export function countStaleBooks(db: DB): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM books b WHERE ${STALE_WHERE}`)
    .get(LANGUAGE_DETECTOR_REV) as { n: number };
  return Number(row.n);
}

/**
 * Queue one run of the backfill unless one is already queued or running.
 * Returns the job id, or null when nothing was queued.
 */
export function requestLanguageBackfill(db: DB): string | null {
  const pending = db
    .prepare(`SELECT 1 FROM jobs WHERE type = ? AND state IN ('queued','running') LIMIT 1`)
    .get(LANGUAGE_BACKFILL_JOB);
  if (pending) return null;
  return enqueueJob(
    db,
    LANGUAGE_BACKFILL_JOB,
    {},
    { dedupeKey: LANGUAGE_BACKFILL_JOB, priority: -2 },
  );
}

/**
 * Read one book's prose again and store what it says. A book with nothing
 * readable on disk keeps whatever the last detector said and is still
 * stamped, so it is not retried at every start; the next real index reads
 * it afresh.
 */
export function redetectBook(ctx: AppContext, bookId: string): { read: boolean; changed: boolean } {
  const { db } = ctx;
  const before = db
    .prepare(
      'SELECT language, language_source, language_detected, meta_json FROM books WHERE id = ?',
    )
    .get(bookId) as
    | {
        language: string | null;
        language_source: string | null;
        language_detected: string | null;
        meta_json: string | null;
      }
    | undefined;
  if (!before) return { read: false, changed: false };
  const windows = proseWindows(activeDerivedDir(ctx, bookId));
  const guess = windows.length > 0 ? detectLanguageFromWindows(windows) : null;
  const detected =
    windows.length === 0
      ? before.language_detected
      : guess
        ? normaliseLanguage(guess.language)
        : null;
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(before.meta_json || '{}') as Record<string, unknown>;
  } catch {
    meta = {};
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE books SET language_detected = ?, meta_json = ? WHERE id = ?').run(
      detected,
      JSON.stringify(withDetectorRev(meta)),
      bookId,
    );
    recomputeBookAndPartners(db, bookId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const after = db
    .prepare('SELECT language, language_source FROM books WHERE id = ?')
    .get(bookId) as { language: string | null; language_source: string | null };
  return {
    read: windows.length > 0,
    changed: after.language !== before.language || after.language_source !== before.language_source,
  };
}

/** One run of the backfill: a batch of stale books, then the next run if any remain. */
export async function runLanguageBackfill(
  ctx: AppContext,
  job: JobRow,
  guard: LeaseGuard,
): Promise<void> {
  const { db } = ctx;
  const books = db
    .prepare(`SELECT b.id FROM books b WHERE ${STALE_WHERE} ORDER BY b.id LIMIT ?`)
    .all(LANGUAGE_DETECTOR_REV, BACKFILL_BATCH) as { id: string }[];
  if (books.length === 0) {
    jobProgress(db, job.id, job.lease_token, 1, 'Every book has been read');
    return;
  }
  let read = 0;
  let changed = 0;
  for (const [i, book] of books.entries()) {
    guard.assertHeld();
    const outcome = redetectBook(ctx, book.id);
    if (outcome.read) read++;
    if (outcome.changed) changed++;
    if (i % 10 === 9 || i === books.length - 1) {
      // A count, not a title: the job list is everybody's, and the book
      // being read may be one an admin has hidden from them.
      jobProgress(
        db,
        job.id,
        job.lease_token,
        (i + 1) / books.length,
        `Reading ${i + 1} of ${books.length}`,
      );
    }
    // One book at a time; yield so worker heartbeats stay live.
    await new Promise((r) => setImmediate(r));
  }
  const left = countStaleBooks(db);
  const summary = `Language backfill: read ${read} of ${books.length} books, ${changed} changed language${left > 0 ? `, ${left} to go` : ''}`;
  ctx.log.info(summary);
  jobProgress(db, job.id, job.lease_token, 1, summary);
  if (left > 0) {
    guard.assertHeld();
    enqueueJob(
      db,
      LANGUAGE_BACKFILL_JOB,
      {},
      {
        dedupeKey: `${LANGUAGE_BACKFILL_JOB}:after-${job.id}`,
        priority: -2,
      },
    );
  }
}
