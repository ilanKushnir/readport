import { type TranslationMatch } from '@readport/shared';
import { type AppContext, activeDerivedDir } from '../context.js';
import { type DB, nowIso } from '../db/index.js';
import { loadChapterText, loadManifest, type BookManifest } from '../epub/extract.js';
import { enqueueJob, jobProgress, type JobRow, type LeaseGuard } from '../jobs/queue.js';
import { alignParagraphs, paragraphsOf, stepsToSpans, type Paragraph } from './align.js';
import { groupOf, groupTitles, ordered } from './groups.js';

/**
 * The paragraph matches between two ebooks of one work, worked out in the
 * background and kept (migration 24's translation_alignments).
 *
 * A match is only as good as the two texts it was made from, so each row
 * carries the derived revision of both books; a book indexed again leaves
 * its old matches stale, and they are worked out again rather than used.
 */

export const TRANSLATION_ALIGN_JOB = 'translation-align';

interface BookRev {
  id: string;
  kind: string;
  scan_state: string;
  derived_rev: string | null;
}

function bookRev(db: DB, id: string): BookRev | undefined {
  return db.prepare('SELECT id, kind, scan_state, derived_rev FROM books WHERE id = ?').get(id) as
    BookRev | undefined;
}

/** Ready to be matched: an ebook whose text has been extracted. */
function matchable(b: BookRev | undefined): b is BookRev {
  return !!b && b.kind === 'ebook' && b.scan_state === 'ready';
}

export interface StoredMatch {
  /** The book the spans' first pair of numbers belongs to. */
  a: string;
  b: string;
  match: 'close' | 'rough';
  /** [aStart, aEnd, bStart, bEnd] per step, in whole-book character offsets. */
  spans: number[];
}

/** Parsed rows, kept: a friend's marker is placed through them every minute a book is open. */
const cache = new Map<string, StoredMatch>();
const CACHE_SIZE = 24;

/** The current match between two ebooks, when there is one worked out from their current texts. */
export function storedMatch(db: DB, x: string, y: string): StoredMatch | null {
  const [a, b] = ordered(x, y);
  const row = db
    .prepare(
      `SELECT t.match, t.beads_json, t.rev_a, t.rev_b, ba.derived_rev AS cur_a, bb.derived_rev AS cur_b
         FROM translation_alignments t
         JOIN books ba ON ba.id = t.book_a
         JOIN books bb ON bb.id = t.book_b
        WHERE t.book_a = ? AND t.book_b = ?`,
    )
    .get(a, b) as
    | {
        match: 'close' | 'rough';
        beads_json: string;
        rev_a: string | null;
        rev_b: string | null;
        cur_a: string | null;
        cur_b: string | null;
      }
    | undefined;
  if (!row || row.rev_a !== row.cur_a || row.rev_b !== row.cur_b) return null;
  const key = `${a}|${b}|${row.rev_a}|${row.rev_b}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let spans: number[];
  try {
    spans = JSON.parse(row.beads_json) as number[];
  } catch {
    return null;
  }
  const parsed: StoredMatch = { a, b, match: row.match, spans };
  cache.set(key, parsed);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return parsed;
}

/** A book's paragraphs and manifest, read from its extracted text. */
export function bookText(
  ctx: AppContext,
  bookId: string,
): { manifest: BookManifest; paragraphs: Paragraph[] } | null {
  const dir = activeDerivedDir(ctx, bookId);
  const manifest = loadManifest(dir);
  if (!manifest) return null;
  const paragraphs = paragraphsOf(manifest.chapters, (idx) => loadChapterText(dir, idx));
  return { manifest, paragraphs };
}

/**
 * Work out and keep the match between two ebooks. Returns what was stored,
 * or null when either has no text to match.
 */
export async function matchEditions(
  ctx: AppContext,
  x: string,
  y: string,
  pause?: () => Promise<void>,
  beforeWrite: () => void = () => {},
): Promise<StoredMatch | null> {
  const { db } = ctx;
  const [a, b] = ordered(x, y);
  const ra = bookRev(db, a);
  const rb = bookRev(db, b);
  if (!matchable(ra) || !matchable(rb)) return null;
  const ta = bookText(ctx, a);
  const tb = bookText(ctx, b);
  if (!ta || !tb) return null;
  const result = await alignParagraphs(ta.paragraphs, tb.paragraphs, { pause });
  if (!result) return null;
  const spans = stepsToSpans(result.steps, ta.paragraphs, tb.paragraphs);
  beforeWrite();
  db.prepare(
    `INSERT INTO translation_alignments (book_a, book_b, rev_a, rev_b, match, beads_json, stats_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (book_a, book_b) DO UPDATE SET rev_a = excluded.rev_a, rev_b = excluded.rev_b,
       match = excluded.match, beads_json = excluded.beads_json, stats_json = excluded.stats_json,
       created_at = excluded.created_at`,
  ).run(
    a,
    b,
    ra.derived_rev,
    rb.derived_rev,
    result.match,
    JSON.stringify(spans),
    JSON.stringify(result.stats),
    nowIso(),
  );
  return { a, b, match: result.match, spans };
}

/** The ebooks of a title: the books of it that have text to match. */
function ebooksOf(db: DB, books: string[]): string[] {
  return books.filter((id) => bookRev(db, id)?.kind === 'ebook');
}

/**
 * Make sure every two ebooks of one work, in different titles, are matched
 * or on their way to being: a match missing, or stale because a book was
 * indexed again, is queued. Cheap when there is nothing to do, so it is
 * called wherever a group may have changed.
 */
export function ensureMatches(db: DB, bookId: string): number {
  const group = groupOf(db, bookId);
  if (!group) return 0;
  const titles = groupTitles(db, group).map((books) => ebooksOf(db, books));
  let queued = 0;
  for (let i = 0; i < titles.length; i++) {
    for (let j = i + 1; j < titles.length; j++) {
      for (const x of titles[i]!) {
        for (const y of titles[j]!) {
          if (!matchable(bookRev(db, x)) || !matchable(bookRev(db, y))) continue;
          if (storedMatch(db, x, y) || failedForTheseTexts(db, x, y)) continue;
          const [a, b] = ordered(x, y);
          if (enqueueJob(db, TRANSLATION_ALIGN_JOB, { a, b }, { dedupeKey: `talign:${a}:${b}` }))
            queued++;
        }
      }
    }
  }
  return queued;
}

/** The most recent match job for two books, and when it was asked for. */
function lastJob(db: DB, x: string, y: string): { state: string; created_at: string } | undefined {
  const [a, b] = ordered(x, y);
  return db
    .prepare(
      `SELECT state, created_at FROM jobs WHERE type = ?
         AND json_extract(payload_json, '$.a') = ? AND json_extract(payload_json, '$.b') = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(TRANSLATION_ALIGN_JOB, a, b) as { state: string; created_at: string } | undefined;
}

/** A book that is going to have text: found, or being indexed now. */
function onItsWay(b: BookRev | undefined): boolean {
  return (
    !!b && b.kind === 'ebook' && (b.scan_state === 'discovered' || b.scan_state === 'indexing')
  );
}

/**
 * A match that failed for these two texts is not asked for again until one
 * of them changes: indexed again, the book has something new to offer.
 */
function failedForTheseTexts(db: DB, x: string, y: string): boolean {
  const job = lastJob(db, x, y);
  if (!job || job.state !== 'failed') return false;
  const scanned = db
    .prepare('SELECT MAX(COALESCE(scanned_at, added_at)) AS at FROM books WHERE id IN (?, ?)')
    .get(x, y) as { at: string | null };
  return !scanned.at || job.created_at >= scanned.at;
}

/**
 * How closely two titles' texts line up, as the book page says it: through
 * their ebooks, the first pair of them that has been matched.
 */
export function matchState(db: DB, mine: string[], theirs: string[]): TranslationMatch {
  const ea = ebooksOf(db, mine);
  const eb = ebooksOf(db, theirs);
  if (ea.length === 0 || eb.length === 0) return 'none';
  let coming = false;
  for (const x of ea) {
    for (const y of eb) {
      const found = storedMatch(db, x, y);
      if (found) return found.match;
      const rx = bookRev(db, x);
      const ry = bookRev(db, y);
      if (matchable(rx) && matchable(ry)) {
        if (!failedForTheseTexts(db, x, y)) coming = true;
      } else if ((matchable(rx) || onItsWay(rx)) && (matchable(ry) || onItsWay(ry))) {
        coming = true;
      }
    }
  }
  return coming ? 'pending' : 'none';
}

/** The job: match two ebooks' paragraphs. */
export async function runTranslationAlign(
  ctx: AppContext,
  job: JobRow,
  guard: LeaseGuard,
): Promise<void> {
  const { a, b } = JSON.parse(job.payload_json || '{}') as { a?: string; b?: string };
  if (!a || !b) throw new Error('A translation match needs two books');
  jobProgress(ctx.db, job.id, job.lease_token, 0.1, 'Matching paragraphs');
  const stored = await matchEditions(
    ctx,
    a,
    b,
    () => new Promise<void>((r) => setImmediate(r)),
    () => guard.assertHeld(),
  );
  if (!stored) throw new Error('One of the two editions has no text to match yet');
  jobProgress(
    ctx.db,
    job.id,
    job.lease_token,
    1,
    stored.match === 'close' ? 'Matched' : 'Matched loosely',
  );
}
