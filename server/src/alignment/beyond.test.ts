import { type AlignmentGap, type AlignmentSegment } from '@readport/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDatabase, nowIso, type DB } from '../db/index.js';
import { narrationBeyondText } from './beyond.js';
import { storeAlignment } from './service.js';

/**
 * Which holes in an alignment are narration the ebook does not have, and
 * which are only text the aligner could not place.
 *
 * The book: two chapters of 100-character sentences, 60 and 40 of them,
 * read at five seconds a sentence - 50 ms a character, the pace the judge
 * measures on the synced stretches and reads the untimed text at.
 */

const sentences = [60, 40].map((n, spine) =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${spine}s${i}`,
    ord: i,
    start: i * 100,
    end: (i + 1) * 100,
  })),
);

let db: DB;
let run = 0;

beforeEach(() => {
  db = openMemoryDatabase();
  db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, size_bytes, scan_state, added_at)
     VALUES ('e1','ebook','/x','a.epub','epub','E',1,'ready',?), ('a1','audio','/x','a','m4b','A',1,'ready',?)`,
  ).run(nowIso(), nowIso());
  db.prepare(
    `INSERT INTO pairs (id, ebook_id, audio_id, status, score, created_at) VALUES ('p1','e1','a1','confirmed',0.9,?)`,
  ).run(nowIso());
});

/** Sentences `from`..`to` of a chapter, spoken back to back from `atMs`. */
function spoken(spine: number, from: number, to: number, atMs: number): AlignmentSegment[] {
  return Array.from({ length: to - from + 1 }, (_, k) => ({
    sentenceId: `c${spine}s${from + k}`,
    spineIdx: spine,
    sentenceOrd: from + k,
    startMs: atMs + k * 5000,
    endMs: atMs + (k + 1) * 5000,
    confidence: 0.9,
    source: 'exact' as const,
    uncertaintyMs: 0,
  }));
}

function judge(segments: AlignmentSegment[], gaps: AlignmentGap[]) {
  const id = storeAlignment(
    db,
    'p1',
    'en',
    'test',
    { segments, gaps, coverage: 1, meanConfidence: 0.9 },
    {},
  );
  // A fresh key per run: the answer is kept per alignment and index.
  return narrationBeyondText(db, id, gaps, sentences, `test-${run++}`);
}

const hole = (fromMs: number, toMs: number): AlignmentGap => ({
  fromMs,
  toMs,
  reason: 'narration-only',
});

describe('narration the ebook does not have', () => {
  it('is a passage between two sentences that follow each other in the book', () => {
    // The first chapter ends at 300 s, the second begins at 390 s: a minute
    // and a half of narration, and not a word of text between them.
    const found = judge(
      [...spoken(0, 0, 59, 0), ...spoken(1, 0, 39, 390_000)],
      [hole(300_000, 390_000)],
    );
    expect(found).toEqual([
      {
        fromMs: 300_000,
        toMs: 390_000,
        extraMs: 90_000,
        where: 'middle',
        resume: { spineIdx: 1, sentenceId: 'c1s0', charOffset: 0 },
      },
    ]);
  });

  it('is not text the aligner could not place', () => {
    // Sentences 30-45 have no timings; read at the book's pace they take
    // 80 of the hole's 85 seconds. What is left is a pause, not a passage.
    const found = judge(
      [...spoken(0, 0, 29, 0), ...spoken(0, 46, 59, 235_000), ...spoken(1, 0, 39, 305_000)],
      [hole(150_000, 235_000)],
    );
    expect(found).toEqual([]);
  });

  it('is what is left of a hole once its untimed text is read', () => {
    // Four untimed sentences (20 s of reading) in a hole of 100 s: 80 s of
    // it is narration the ebook does not have, and the text picks up at 34.
    const found = judge(
      [...spoken(0, 0, 29, 0), ...spoken(0, 34, 59, 250_000), ...spoken(1, 0, 39, 380_000)],
      [hole(150_000, 250_000)],
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.extraMs).toBe(80_000);
    expect(found[0]!.resume).toEqual({ spineIdx: 0, sentenceId: 'c0s34', charOffset: 3400 });
  });

  it('is the whole hole when the text in it is text the narration leaves out', () => {
    // The same untimed sentences 30-45 as above - but the aligner found the
    // narration leaves them out (a preface), so none of the hole is theirs:
    // it is the audiobook's own announcement, all 85 seconds of it.
    const found = judge(
      [...spoken(0, 0, 29, 0), ...spoken(0, 46, 59, 235_000), ...spoken(1, 0, 39, 305_000)],
      [hole(150_000, 235_000), { fromMs: 150_000, toMs: 235_000, reason: 'text-only' }],
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.extraMs).toBe(85_000);
    expect(found[0]!.resume?.sentenceId).toBe('c0s46');
  });

  it('is not a sentence or two told differently', () => {
    // Twenty seconds with nothing between, and 35 s with two untimed
    // sentences in it (10 s of reading): neither is a passage.
    const found = judge(
      [
        ...spoken(0, 0, 29, 0),
        ...spoken(0, 30, 45, 170_000),
        ...spoken(0, 48, 59, 285_000),
        ...spoken(1, 0, 39, 345_000),
      ],
      [hole(150_000, 170_000), hole(250_000, 285_000)],
    );
    expect(found).toEqual([]);
  });

  it('comes before the text begins, and picks up at its first sentence', () => {
    const found = judge(
      [...spoken(0, 0, 59, 45_000), ...spoken(1, 0, 39, 345_000)],
      [hole(0, 45_000)],
    );
    expect(found).toEqual([
      {
        fromMs: 0,
        toMs: 45_000,
        extraMs: 45_000,
        where: 'start',
        resume: { spineIdx: 0, sentenceId: 'c0s0', charOffset: 0 },
      },
    ]);
  });

  it('goes on after the text ends, with nowhere to pick up', () => {
    const found = judge(
      [...spoken(0, 0, 59, 0), ...spoken(1, 0, 39, 300_000)],
      [hole(500_000, 560_000)],
    );
    expect(found).toEqual([
      { fromMs: 500_000, toMs: 560_000, extraMs: 60_000, where: 'end', resume: null },
    ]);
  });

  it('ignores holes the aligner did not call narration', () => {
    const found = judge(
      [...spoken(0, 0, 59, 0), ...spoken(1, 0, 39, 390_000)],
      [{ fromMs: 300_000, toMs: 390_000, reason: 'low-confidence' }],
    );
    expect(found).toEqual([]);
  });
});
