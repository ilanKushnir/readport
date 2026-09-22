import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { openMemoryDatabase } from '../db/index.js';
import { type AppContext, derivedVersionDir } from '../context.js';
import { claimNextJob, finishJob, makeLeaseGuard } from '../jobs/queue.js';
import { proseWindows } from './prose.js';
import {
  BACKFILL_BATCH,
  LANGUAGE_BACKFILL_JOB,
  LANGUAGE_DETECTOR_REV,
  countStaleBooks,
  redetectBook,
  requestLanguageBackfill,
  runLanguageBackfill,
} from './redetect.js';

/**
 * The upgrade path: books indexed before the detector could read them
 * properly are read again from the chapter text already on disk, a batch
 * at a time, and a Hebrew novel Calibre had tagged "en" comes out Hebrew.
 */

let tmp: string;
let ctx: AppContext;
let seq = 0;

const HEBREW = `בכל ערב, בדיוק בשעה שבע, הייתה נורית פותחת את חלון דירתה הקטנה ומביטה בשדרה
הנדלקת פנס אחר פנס. הפנס הראשון עמד מול המאפייה של אדון לוי, והאור שלו היה תמיד חם יותר מן
האחרים. היא הייתה בטוחה שהעירייה אינה יודעת על כך דבר. פעם אחת, בחורף, נשאר הפנס הראשון כבוי
שלושה לילות רצופים, והשדרה כולה נראתה כמו משפט שחסרה בו המילה הראשונה. `;
const ENGLISH = `Maren Solt arrived at Ash Harbor on the last ferry of October, carrying one canvas
bag and a brass key that did not yet fit any lock she knew. The lighthouse stood on the northern
spit like a patient animal, white paint peeling in long ribbons above the rocks, and the keeper's
cottage beside it had a door that opened only when you leaned on it with your whole weight. `;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-redetect-'));
  const config = loadConfig({
    dataDir: path.join(tmp, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    modelsDir: path.join(tmp, 'models'),
    sessionSecret: 'redetect-test-secret-0123456789',
    logLevel: 'error',
  });
  ctx = { db: openMemoryDatabase(), config, log: { info() {}, warn() {}, error() {} } };
});
afterAll(() => {
  ctx.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An indexed ebook with the given chapter text on disk, or no derived files at all. */
function ebook(opts: {
  tag?: string | null;
  chapters?: string[];
  meta?: Record<string, unknown>;
  kind?: 'ebook' | 'audio';
}): string {
  const id = `book${++seq}`;
  const rev = opts.chapters ? 'v-test' : null;
  ctx.db
    .prepare(
      `INSERT INTO books (id, kind, root_dir, rel_path, format, title, scan_state, added_at,
         language_metadata, derived_rev, meta_json)
       VALUES (?, ?, '/lib', ?, 'epub', ?, 'ready', '2026-01-01T00:00:00.000Z', ?, ?, ?)`,
    )
    .run(
      id,
      opts.kind ?? 'ebook',
      `${id}.epub`,
      `Title ${id}`,
      opts.tag ?? null,
      rev,
      JSON.stringify(opts.meta ?? {}),
    );
  ctx.db
    .prepare('UPDATE books SET language = language_metadata, language_source = ? WHERE id = ?')
    .run(opts.tag ? 'metadata' : null, id);
  if (opts.chapters) {
    const dir = derivedVersionDir(ctx, id, rev);
    fs.mkdirSync(dir, { recursive: true });
    let cum = 0;
    const chapters = opts.chapters.map((text, idx) => {
      fs.writeFileSync(path.join(dir, `text_${idx}.txt`), text);
      const c = {
        idx,
        href: `ch${idx}.xhtml`,
        title: null,
        charCount: text.length,
        sentenceCount: 1,
        cumChars: cum,
      };
      cum += text.length;
      return c;
    });
    fs.writeFileSync(
      path.join(dir, 'book.json'),
      JSON.stringify({
        bookId: id,
        title: id,
        author: null,
        language: opts.tag ?? null,
        direction: 'ltr',
        directionDeclared: false,
        totalChars: cum,
        chapters,
        toc: [],
      }),
    );
  }
  return id;
}
const stored = (id: string) =>
  ctx.db
    .prepare('SELECT language, language_source AS source, meta_json FROM books WHERE id = ?')
    .get(id) as { language: string | null; source: string | null; meta_json: string };
const rev = (id: string) => (JSON.parse(stored(id).meta_json) as { langRev?: number }).langRev;

describe('proseWindows', () => {
  it('reads windows out of the chapter files by the manifest, across chapter ends', () => {
    const id = ebook({ chapters: [ENGLISH.repeat(4), HEBREW.repeat(4), ENGLISH.repeat(4)] });
    const windows = proseWindows(derivedVersionDir(ctx, id, 'v-test'));
    expect(windows.length).toBeGreaterThanOrEqual(3);
    expect(windows.join('')).toContain('Maren Solt');
    expect(windows.join('')).toContain('נורית');
  });
  it('has nothing to read from a directory that is not there', () => {
    expect(proseWindows(path.join(tmp, 'nowhere'))).toEqual([]);
  });
});

describe('redetectBook', () => {
  it('reads a Hebrew novel Calibre tagged "en" as Hebrew, and says so', () => {
    const id = ebook({ tag: 'en', chapters: [HEBREW.repeat(6), HEBREW.repeat(6)] });
    expect(stored(id)).toMatchObject({ language: 'en', source: 'metadata' });
    expect(redetectBook(ctx, id)).toEqual({ read: true, changed: true });
    expect(stored(id)).toMatchObject({ language: 'he', source: 'detected' });
    expect(rev(id)).toBe(LANGUAGE_DETECTOR_REV);
  });
  it('leaves a correctly tagged book as it was, stamped', () => {
    const id = ebook({ tag: 'en', chapters: [ENGLISH.repeat(8)] });
    expect(redetectBook(ctx, id)).toEqual({ read: true, changed: true });
    // Same language, but now on the prose's own authority.
    expect(stored(id)).toMatchObject({ language: 'en', source: 'detected' });
    expect(rev(id)).toBe(LANGUAGE_DETECTOR_REV);
  });
  it('keeps what an earlier detector said when there is nothing on disk to read, and still stamps', () => {
    const id = ebook({ tag: null, meta: { totalChars: 10 } });
    ctx.db.prepare("UPDATE books SET language_detected = 'de' WHERE id = ?").run(id);
    expect(redetectBook(ctx, id)).toEqual({ read: false, changed: true });
    expect(stored(id)).toMatchObject({ language: 'de', source: 'detected' });
    expect(JSON.parse(stored(id).meta_json)).toEqual({
      totalChars: 10,
      langRev: LANGUAGE_DETECTOR_REV,
    });
  });
});

describe('the backfill job', () => {
  it('is queued once, waits behind everything else, and is not queued twice', () => {
    const id = requestLanguageBackfill(ctx.db);
    expect(id).not.toBeNull();
    expect(requestLanguageBackfill(ctx.db)).toBeNull();
    const row = ctx.db.prepare('SELECT type, priority, state FROM jobs WHERE id = ?').get(id) as {
      type: string;
      priority: number;
      state: string;
    };
    expect(row).toEqual({ type: LANGUAGE_BACKFILL_JOB, priority: -2, state: 'queued' });
  });
  it('reads every stale ebook in batches, re-queues itself until none are left, then stops', async () => {
    // Everything above is stamped by now; add a batch and a bit more.
    const before = countStaleBooks(ctx.db);
    const fresh = ebook({
      tag: 'en',
      chapters: [HEBREW.repeat(6)],
      meta: { langRev: LANGUAGE_DETECTOR_REV },
    });
    const audio = ebook({ kind: 'audio', tag: 'en' });
    const stale = Array.from({ length: BACKFILL_BATCH + 2 - before }, () => ebook({ tag: 'en' }));
    const hebrew = ebook({ tag: 'en', chapters: [HEBREW.repeat(6)] });
    expect(countStaleBooks(ctx.db)).toBe(BACKFILL_BATCH + 3);

    const run = async () => {
      const job = claimNextJob(ctx.db)!;
      expect(job.type).toBe(LANGUAGE_BACKFILL_JOB);
      await runLanguageBackfill(ctx, job, makeLeaseGuard(ctx.db, job));
      finishJob(ctx.db, job.id, job.lease_token!);
      return job;
    };
    const first = await run();
    expect(countStaleBooks(ctx.db)).toBe(3);
    expect(
      (ctx.db.prepare('SELECT detail FROM jobs WHERE id = ?').get(first.id) as { detail: string })
        .detail,
    ).toMatch(/read \d+ of 100 books, \d+ changed language, 3 to go/);
    // The continuation was queued by the run itself.
    const queued = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = ? AND state = 'queued'`)
      .get(LANGUAGE_BACKFILL_JOB) as { n: number };
    expect(Number(queued.n)).toBe(1);
    await run();
    expect(countStaleBooks(ctx.db)).toBe(0);
    expect(stored(hebrew)).toMatchObject({ language: 'he', source: 'detected' });
    for (const id of stale) expect(rev(id)).toBe(LANGUAGE_DETECTOR_REV);
    // Already stamped, and an audiobook: neither was touched.
    expect(stored(fresh)).toMatchObject({ language: 'en', source: 'metadata' });
    expect(stored(audio)).toMatchObject({ language: 'en', source: 'metadata' });
    expect(claimNextJob(ctx.db)).toBeNull();

    // Asked again on the next start: one look, nothing to do, no chain.
    requestLanguageBackfill(ctx.db);
    const last = await run();
    expect(
      (ctx.db.prepare('SELECT detail FROM jobs WHERE id = ?').get(last.id) as { detail: string })
        .detail,
    ).toBe('Every book has been read');
    expect(claimNextJob(ctx.db)).toBeNull();
  });
});
