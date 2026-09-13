import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { FACETS_REV, applyScan, type ScanReport } from './scan.js';

/**
 * What a rescan decides to re-index, and — just as important — what it leaves
 * alone.
 *
 * The dangerous mistake here is taking a book out of service to refresh
 * something derived from it. `discovered` is not a readable state: the reader
 * answers 404 for a book in it and pairing skips it entirely, so a backfill
 * that resets `scan_state` would black out the whole library until every book
 * had been re-indexed. These tests pin the difference between "this file
 * changed" and "our extraction changed".
 */

let dir: string;
let db: DB;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-scan-'));
  db = openDatabase(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ROOT = '/library/ebooks';
const REL = 'a-book.epub';

function report(contentHash: string): ScanReport {
  return {
    ebooks: [{ rootDir: ROOT, relPath: REL, sizeBytes: 1000, contentHash }],
    audiobooks: [],
    unsupported: [],
    errors: [],
  };
}

/** A book as an earlier version left it: indexed, readable, no facets. */
function seedReadyBook(facetsRev: number): string {
  applyScan(db, report('hash-1'));
  const row = db.prepare('SELECT id FROM books LIMIT 1').get() as { id: string };
  db.prepare("UPDATE books SET scan_state = 'ready', facets_rev = ? WHERE id = ?").run(
    facetsRev,
    row.id,
  );
  return row.id;
}

function stateOf(id: string): string {
  return (db.prepare('SELECT scan_state FROM books WHERE id = ?').get(id) as { scan_state: string })
    .scan_state;
}

describe('applyScan', () => {
  it('re-indexes a book from before facets existed', () => {
    const id = seedReadyBook(0);
    const out = applyScan(db, report('hash-1'));
    expect(out.needsIndex.map((n) => n.bookId)).toEqual([id]);
  });

  it('leaves that book readable while it waits its turn', () => {
    // The whole point: a derived-data backfill is not a reason to 404 the
    // reader, and pairing only ever considers books that are 'ready'.
    const id = seedReadyBook(0);
    applyScan(db, report('hash-1'));
    expect(stateOf(id)).toBe('ready');
  });

  it('leaves a book alone once it has been indexed under this generation', () => {
    seedReadyBook(FACETS_REV);
    expect(applyScan(db, report('hash-1')).needsIndex).toEqual([]);
  });

  it('still takes a book out of service when the file itself changed', () => {
    // A different hash means the text may be different, so what is derived
    // from it is not merely stale — it is potentially wrong.
    const id = seedReadyBook(FACETS_REV);
    const out = applyScan(db, report('hash-2'));
    expect(out.needsIndex.map((n) => n.bookId)).toEqual([id]);
    expect(stateOf(id)).toBe('discovered');
  });

  it('records the new hash even when only the facets were stale', () => {
    const id = seedReadyBook(0);
    applyScan(db, report('hash-1'));
    const row = db.prepare('SELECT content_hash FROM books WHERE id = ?').get(id) as {
      content_hash: string;
    };
    expect(row.content_hash).toBe('hash-1');
  });
});
