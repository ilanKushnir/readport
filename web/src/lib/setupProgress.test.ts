import type { JobCount } from '@readport/shared';
import { describe, expect, it } from 'vitest';
import { setupProgress } from './setupProgress';

/**
 * The state a real first run actually reaches, and the two ways the old
 * version of this never left "Reading your shelves".
 *
 * Reported from a live 178-book library: scanning and indexing had finished,
 * the alignment model was fully downloaded, every job had succeeded - and the
 * wizard still showed a 4% bar that never moved.
 */

const c = (type: string, state: JobCount['state'], count: number): JobCount => ({
  type,
  state,
  count,
});

/** The library that broke it: 109 ebooks, 69 audiobooks, 13 pairs to align. */
const REAL_LIBRARY: JobCount[] = [
  c('scan', 'done', 1),
  c('index-ebook', 'done', 109),
  c('index-audio', 'done', 69),
  c('pair-scan', 'done', 1),
  c('import-alignments', 'done', 1),
  c('model-download', 'done', 1),
  c('align', 'running', 1),
  c('align', 'queued', 12),
];

describe('setupProgress', () => {
  it('is done once the books are in, even with alignment still queued', () => {
    // The bug: `done` waited for every job, and an align job is queued as soon
    // as a pair is found. 13 of them meant the wizard never finished.
    const p = setupProgress(REAL_LIBRARY, true);
    expect(p.done).toBe(true);
    expect(p.percent).toBe(100);
    expect(p.aligningLater).toBe(13);
  });

  it('does not need the scan job to be in the row list', () => {
    // The other half: /api/jobs is capped at 100 rows and 178 index jobs push
    // the scan out of it. Reading totals instead of rows is the whole point.
    const p = setupProgress(REAL_LIBRARY, true);
    expect(p.done).toBe(true);
  });

  it('reports progress by books indexed while indexing runs', () => {
    const p = setupProgress(
      [c('scan', 'done', 1), c('index-ebook', 'done', 40), c('index-ebook', 'queued', 60)],
      true,
    );
    expect(p.done).toBe(false);
    expect(p.percent).toBe(40);
    expect(p.indexing).toBe(60);
  });

  it('falls back to the scan job while nothing is indexed yet', () => {
    const p = setupProgress([c('scan', 'running', 1)], true, 0.3);
    expect(p.done).toBe(false);
    expect(p.percent).toBe(30);
  });

  it('waits for the scan itself', () => {
    expect(setupProgress([c('scan', 'running', 1)], true).done).toBe(false);
  });

  it('waits for indexing', () => {
    const p = setupProgress(
      [c('scan', 'done', 1), c('index-ebook', 'running', 1), c('index-ebook', 'done', 5)],
      true,
    );
    expect(p.done).toBe(false);
  });

  it('waits for pairing, which is quick and is setup', () => {
    const p = setupProgress([c('scan', 'done', 1), c('pair-scan', 'running', 1)], true);
    expect(p.done).toBe(false);
  });

  it('is never done without any library folders', () => {
    expect(setupProgress(REAL_LIBRARY, false).done).toBe(false);
  });

  it('handles a library with no books at all', () => {
    const p = setupProgress([c('scan', 'done', 1)], true);
    expect(p.done).toBe(true);
    expect(p.percent).toBe(100);
    expect(p.indexing).toBe(0);
  });

  it('survives totals it has never heard of', () => {
    const p = setupProgress([c('scan', 'done', 1), c('some-future-job', 'queued', 3)], true);
    // An unknown type is not setup work, so it must not wedge the wizard.
    expect(p.done).toBe(true);
  });

  it('reports nothing rather than throwing on empty totals', () => {
    const p = setupProgress([], true);
    expect(p).toMatchObject({ done: false, indexing: 0, aligningLater: 0 });
  });
});
