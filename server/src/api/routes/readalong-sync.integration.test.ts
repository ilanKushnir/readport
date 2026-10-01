import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AlignerResult } from '../../alignment/timings.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import {
  dropPartialAlignment,
  latestAlignment,
  storeAlignment,
  storePartialAlignment,
} from '../../alignment/service.js';

/**
 * Read along on a book still syncing.
 *
 * A sync works through the book from the start forward, and read along
 * follows whatever it has settled: nothing at all before the sync starts,
 * "getting ready" while it is queued, the opening as far as it has got while
 * it runs, and the finished sync once it is done - without anything that
 * reads a finished sync (the switch to the player at the same sentence)
 * mistaking a half-done one for it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-readalong-sync-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: tmp,
    cacheDir: tmp,
    sessionSecret: 'readalong-sync-test-secret-0123456789',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});
const get = (url: string) =>
  app.inject({
    url,
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': 'astra' },
  });
const now = new Date().toISOString();

/** Sentences 0..n-1 of chapter `spine`, five seconds each from `atMs`. */
function timed(spine: number, n: number, atMs: number): AlignerResult['segments'] {
  return Array.from({ length: n }, (_, i) => ({
    sentenceId: `c${spine}s${i}`,
    spineIdx: spine,
    sentenceOrd: i,
    startMs: atMs + i * 5000,
    endMs: atMs + (i + 1) * 5000,
    confidence: 0.9,
    source: 'exact' as const,
    uncertaintyMs: 0,
  }));
}
const result = (segments: AlignerResult['segments'], coverage: number): AlignerResult => ({
  segments,
  gaps: [],
  coverage,
  meanConfidence: 0.9,
});

beforeAll(async () => {
  await app.ready();
  const add = (id: string, kind: 'ebook' | 'audio', title: string) =>
    db
      .prepare(
        `INSERT INTO books (id,kind,root_dir,rel_path,format,title,scan_state,added_at,duration_ms)
         VALUES (?,?,?,?,?,?,'ready',?,?)`,
      )
      .run(id, kind, tmp, id, kind === 'ebook' ? 'epub' : 'm4b', title, now, 3_600_000);
  add('new-ebook', 'ebook', 'A Lantern for the Ferryman');
  add('new-audio', 'audio', 'A Lantern for the Ferryman');
  db.prepare(
    "INSERT INTO pairs (id,ebook_id,audio_id,status,score,created_at) VALUES ('p','new-ebook','new-audio','confirmed',1,?)",
  ).run(now);
  await get('/api/auth/me');
});
afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('read along while the book syncs', () => {
  it('has nothing to follow before a sync is even asked for', async () => {
    expect((await get('/api/pairs/p/chapters')).statusCode).toBe(404);
    expect((await get('/api/pairs/p/segments/0')).statusCode).toBe(404);
    const pair = (await get('/api/books/new-ebook')).json().book.pair;
    expect(pair.switchable).toBe(false);
    expect(pair.syncing).toBeNull();
  });

  it('is getting ready the moment the sync is queued', async () => {
    db.prepare(
      `INSERT INTO jobs (id,type,payload_json,dedupe_key,state,created_at)
       VALUES ('j','align','{"pairId":"p"}','align:p','queued',?)`,
    ).run(now);
    const chapters = (await get('/api/pairs/p/chapters')).json();
    expect(chapters.chapters).toEqual([]);
    expect(chapters.alignmentId).toBeNull();
    expect(chapters.syncing).toMatchObject({
      throughMs: 0,
      throughSpine: -1,
      audioMs: 3_600_000,
      active: true,
    });
    const segments = (await get('/api/pairs/p/segments/0')).json();
    expect(segments.segments).toEqual([]);
    expect(segments.syncing.active).toBe(true);
    // The book page and the reader offer read along on this alone.
    const pair = (await get('/api/books/new-ebook')).json().book.pair;
    expect(pair.syncing).toMatchObject({ throughMs: 0, active: true });
    expect(pair.switchable).toBe(false);
  });

  it('follows the opening the sync has settled, and says how far that is', async () => {
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = 'j'").run();
    storePartialAlignment(
      db,
      'p',
      'en',
      'mms-fa/model_int8.onnx',
      result([...timed(0, 10, 4000), ...timed(1, 4, 60_000)], 0.1),
      {
        throughMs: 80_000,
        throughSpine: 1,
        audioMs: 3_600_000,
        rate: 20,
        updatedAt: now,
      },
    );
    const chapters = (await get('/api/pairs/p/chapters')).json();
    expect(chapters.chapters.map((c: { spineIdx: number }) => c.spineIdx)).toEqual([0, 1]);
    expect(chapters.alignmentId).toEqual(expect.any(String));
    expect(chapters.syncing).toMatchObject({ throughMs: 80_000, throughSpine: 1, active: true });
    expect((await get('/api/pairs/p/segments/0')).json().segments).toHaveLength(10);
    // A chapter it has not reached is not an error: just not timed yet.
    const later = await get('/api/pairs/p/segments/2');
    expect(later.statusCode).toBe(200);
    expect(later.json().segments).toEqual([]);
    // Switching to the player at the same sentence waits for the finished
    // sync: half a book is not something to hand a reader's place to.
    expect(latestAlignment(db, 'p')).toBeNull();
    expect((await get('/api/books/new-ebook')).json().book.pair.switchable).toBe(false);
  });

  it('replaces the opening as it grows, rather than adding a second one', async () => {
    storePartialAlignment(
      db,
      'p',
      'en',
      'mms-fa/model_int8.onnx',
      result([...timed(0, 10, 4000), ...timed(1, 10, 60_000), ...timed(2, 5, 120_000)], 0.2),
      {
        throughMs: 145_000,
        throughSpine: 2,
        audioMs: 3_600_000,
        rate: 20,
        updatedAt: now,
      },
    );
    const partials = db
      .prepare("SELECT COUNT(*) AS c FROM alignments WHERE pair_id = 'p' AND status = 'partial'")
      .get() as { c: number };
    expect(partials.c).toBe(1);
    expect((await get('/api/pairs/p/segments/1')).json().segments).toHaveLength(10);
    expect((await get('/api/pairs/p/chapters')).json().syncing.throughMs).toBe(145_000);
  });

  it('still reads along with what was settled when the sync stops short', async () => {
    db.prepare("UPDATE jobs SET state = 'failed' WHERE id = 'j'").run();
    const chapters = (await get('/api/pairs/p/chapters')).json();
    expect(chapters.syncing).toMatchObject({ throughMs: 145_000, active: false });
    expect((await get('/api/pairs/p/segments/2')).json().segments).toHaveLength(5);
  });

  it('follows the finished sync once it is done, and the opening is gone', async () => {
    const ready = storeAlignment(
      db,
      'p',
      'en',
      'mms-fa/model_int8.onnx',
      result([...timed(0, 10, 4000), ...timed(1, 10, 60_000), ...timed(2, 10, 120_000)], 0.95),
      {},
    );
    dropPartialAlignment(db, 'p');
    const chapters = (await get('/api/pairs/p/chapters')).json();
    expect(chapters.alignmentId).toBe(ready);
    expect(chapters.syncing).toBeNull();
    expect((await get('/api/pairs/p/segments/2')).json().segments).toHaveLength(10);
    const pair = (await get('/api/books/new-ebook')).json().book.pair;
    expect(pair.syncing).toBeNull();
    expect(pair.switchable).toBe(true);
    const left = db
      .prepare("SELECT COUNT(*) AS c FROM alignments WHERE pair_id = 'p' AND status = 'partial'")
      .get() as { c: number };
    expect(left.c).toBe(0);
  });

  it('leaves the finished sync alone while a sync of it runs again', async () => {
    db.prepare(
      `INSERT INTO jobs (id,type,payload_json,dedupe_key,state,created_at)
       VALUES ('j2','align','{"pairId":"p","force":true}','align:p','running',?)`,
    ).run(now);
    const chapters = (await get('/api/pairs/p/chapters')).json();
    expect(chapters.syncing).toBeNull();
    expect((await get('/api/pairs/p/segments/2')).json().segments).toHaveLength(10);
  });
});
