import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { applyScan, discardPairing, type ScanReport } from './scan.js';

/**
 * What a changed file invalidates.
 *
 * A pairing says "these two files are the same work" and an alignment says
 * "this sentence is spoken at this second". Both describe the CONTENT, so
 * replacing the file does not make them stale - it makes them wrong, and a
 * wrong alignment is worse than none: switching lands the reader in another
 * chapter with nothing to say anything is amiss.
 *
 * The opposite case matters just as much. A NAS that fails to mount marks
 * every book missing, and destroying pairings then would throw away hours of
 * computed timings for a cable.
 */

let dir: string;
let db: DB;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-pairreset-'));
  db = openDatabase(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const EB = '/library/ebooks';
const AU = '/library/audiobooks';

function report(ebookHash: string, audioHash = 'a-1'): ScanReport {
  return {
    ebooks: [{ rootDir: EB, relPath: 'book.epub', sizeBytes: 1000, contentHash: ebookHash }],
    audiobooks: [
      { rootDir: AU, relPath: 'book.m4b', sizeBytes: 2000, contentHash: audioHash, tracks: [] },
    ],
    unsupported: [],
    errors: [],
  } as unknown as ScanReport;
}

/** Both books ready, paired, with an alignment stored against the pair. */
function seedPairedAndAligned(): { pairId: string; ebookId: string; audioId: string } {
  applyScan(db, report('e-1'));
  db.prepare("UPDATE books SET scan_state = 'ready'").run();
  const ebookId = (db.prepare("SELECT id FROM books WHERE kind='ebook'").get() as { id: string })
    .id;
  const audioId = (db.prepare("SELECT id FROM books WHERE kind='audio'").get() as { id: string })
    .id;
  const pairId = 'pair-1';
  db.prepare(
    `INSERT INTO pairs (id, ebook_id, audio_id, status, score, created_at)
     VALUES (?, ?, ?, 'confirmed', 0.99, datetime('now'))`,
  ).run(pairId, ebookId, audioId);
  db.prepare(
    `INSERT INTO alignments (id, pair_id, version, language, model, coverage, mean_confidence, created_at)
     VALUES ('al-1', ?, 1, 'en', 'mms', 0.9, 0.9, datetime('now'))`,
  ).run(pairId);
  return { pairId, ebookId, audioId };
}

const pairCount = () => (db.prepare('SELECT COUNT(*) AS c FROM pairs').get() as { c: number }).c;
const alignmentCount = () =>
  (db.prepare('SELECT COUNT(*) AS c FROM alignments').get() as { c: number }).c;

describe('a book whose bytes changed', () => {
  it('loses its pairing and its alignment', () => {
    seedPairedAndAligned();
    expect(pairCount()).toBe(1);
    applyScan(db, report('e-2')); // the EPUB was replaced
    expect(pairCount()).toBe(0);
    // The alignment described the old text, so it goes with the pair.
    expect(alignmentCount()).toBe(0);
  });

  it('loses it when the AUDIO is the side that changed', () => {
    seedPairedAndAligned();
    applyScan(db, report('e-1', 'a-2'));
    expect(pairCount()).toBe(0);
  });

  it('is queued to be indexed again', () => {
    const { ebookId } = seedPairedAndAligned();
    const out = applyScan(db, report('e-2'));
    expect(out.needsIndex.map((n) => n.bookId)).toContain(ebookId);
  });
});

describe('a book that has not changed', () => {
  it('keeps its pairing across an ordinary rescan', () => {
    seedPairedAndAligned();
    applyScan(db, report('e-1'));
    expect(pairCount()).toBe(1);
    expect(alignmentCount()).toBe(1);
  });

  it('keeps it when the library merely goes missing', () => {
    // A NAS that fails to mount must not cost hours of computed timings.
    seedPairedAndAligned();
    applyScan(db, { ebooks: [], audiobooks: [], unsupported: [], errors: [] });
    expect(pairCount()).toBe(1);
    expect(alignmentCount()).toBe(1);
  });

  it('still has it when the file comes back', () => {
    seedPairedAndAligned();
    applyScan(db, { ebooks: [], audiobooks: [], unsupported: [], errors: [] });
    applyScan(db, report('e-1'));
    expect(pairCount()).toBe(1);
  });
});

describe('discardPairing', () => {
  it('reports how many pairings it removed', () => {
    const { ebookId } = seedPairedAndAligned();
    expect(discardPairing(db, ebookId)).toBe(1);
    expect(discardPairing(db, ebookId)).toBe(0);
  });

  it('does nothing for a book that was never paired', () => {
    expect(discardPairing(db, 'nobody')).toBe(0);
  });
});
