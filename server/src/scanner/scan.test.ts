import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { AUDIO_NAMING_REV, FACETS_REV, applyScan, type ScanReport } from './scan.js';

/**
 * What a rescan decides to re-index, and - just as important - what it leaves
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
  it('reunites a renamed file with the book it already was', () => {
    // Ids are derived from the path, so a rename used to mint a new book and
    // mark the old one missing - abandoning every highlight, note, bookmark,
    // shelf membership and reading position, all of which hang off the id.
    const id = seedReadyBook(FACETS_REV);
    applyScan(db, {
      ebooks: [{ rootDir: ROOT, relPath: REL, sizeBytes: 1000, contentHash: 'hash-1' }],
      audiobooks: [],
      unsupported: [],
      errors: [],
    });
    // The file goes missing...
    applyScan(db, { ebooks: [], audiobooks: [], unsupported: [], errors: [] });
    expect(stateOf(id)).toBe('missing');
    // ...and comes back under a new name, same bytes.
    const out = applyScan(db, {
      ebooks: [{ rootDir: ROOT, relPath: 'renamed.epub', sizeBytes: 1000, contentHash: 'hash-1' }],
      audiobooks: [],
      unsupported: [],
      errors: [],
    });
    const rows = db.prepare('SELECT id, rel_path FROM books').all() as {
      id: string;
      rel_path: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.rel_path).toBe('renamed.epub');
    expect(out.needsIndex.map((n) => n.bookId)).toEqual([id]);
  });

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
    // from it is not merely stale - it is potentially wrong.
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

describe('a folder moved between two scans', () => {
  const audio = (relPath: string): ScanReport => ({
    ebooks: [],
    audiobooks: [
      {
        rootDir: '/library/audiobooks',
        relPath,
        tracks: [{ relPath: `${relPath}/01.mp3`, sizeBytes: 10, ext: '.mp3' }],
        sizeBytes: 10,
        contentHash: 'audio-hash',
      },
    ],
    unsupported: [],
    errors: [],
  });

  it('is the same book in its new place, with nothing left behind as missing', () => {
    // Moved into a folder of its series: the old place is gone and the new
    // one found in the SAME scan, which never marked the book missing first.
    applyScan(db, audio('Rivka Sharon/Fog Signals. Book 2'));
    const before = db.prepare('SELECT id FROM books').get() as { id: string };
    applyScan(db, audio('Rivka Sharon/Fog Signals/Fog Signals. Book 2'));
    const rows = db.prepare('SELECT id, rel_path, scan_state FROM books').all() as {
      id: string;
      rel_path: string;
      scan_state: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: before.id,
      rel_path: 'Rivka Sharon/Fog Signals/Fog Signals. Book 2',
    });
  });

  it('is not taken from a copy still in its place', () => {
    applyScan(db, audio('Rivka Sharon/Fog Signals. Book 2'));
    const both = audio('Rivka Sharon/Fog Signals. Book 2');
    both.audiobooks.push({ ...audio('Rivka Sharon/Copy/Fog Signals. Book 2').audiobooks[0]! });
    applyScan(db, both);
    expect((db.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }).n).toBe(2);
  });
});

describe('an audiobook named by older rules', () => {
  it('is read again, and stays playable while it waits', () => {
    const r: ScanReport = {
      ebooks: [],
      audiobooks: [
        {
          rootDir: '/library/audiobooks',
          relPath: 'Noa Adler/The Clockmaker’s Garden',
          tracks: [
            { relPath: 'Noa Adler/The Clockmaker’s Garden/01.mp3', sizeBytes: 10, ext: '.mp3' },
          ],
          sizeBytes: 10,
          contentHash: 'h',
        },
      ],
      unsupported: [],
      errors: [],
    };
    applyScan(db, r);
    const { id } = db.prepare('SELECT id FROM books').get() as { id: string };
    db.prepare(
      "UPDATE books SET scan_state = 'ready', facets_rev = ?, meta_json = '{}' WHERE id = ?",
    ).run(FACETS_REV, id);
    expect(applyScan(db, r).needsIndex.map((n) => n.bookId)).toEqual([id]);
    expect(stateOf(id)).toBe('ready');
    db.prepare('UPDATE books SET meta_json = ? WHERE id = ?').run(
      JSON.stringify({ namingRev: AUDIO_NAMING_REV }),
      id,
    );
    expect(applyScan(db, r).needsIndex).toEqual([]);
  });
});
