import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openMemoryDatabase } from '../db/index.js';
import { bookTrackHashes, settleHashing } from './hashes.js';
import { hashFileChunks, trackSourceVersion } from './integrity.js';

/** The hashes an offline download needs: prepared once, off the request, and kept. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-hashes-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function track(name: string, size: number) {
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, Buffer.alloc(size, name.length));
  const stat = fs.statSync(abs);
  return { abs, relPath: name, size, sourceVersion: trackSourceVersion(stat, name) };
}

describe('bookTrackHashes', () => {
  it('reports progress while it works, then answers from what it kept', async () => {
    const db = openMemoryDatabase();
    const tracks = [track('a.mp3', 3000), track('b.mp3', 5000)];
    const first = bookTrackHashes(db, 'book', tracks, 1024);
    expect(first).toEqual({ ready: false, done: expect.any(Number), total: 8000 });
    // A second ask joins the work under way rather than starting another.
    expect(bookTrackHashes(db, 'book', tracks, 1024).ready).toBe(false);
    await settleHashing('book');
    const second = bookTrackHashes(db, 'book', tracks, 1024);
    expect(second.ready).toBe(true);
    if (second.ready) {
      expect(second.hashes[0]).toEqual(await hashFileChunks(tracks[0]!.abs, 1024));
      expect(second.hashes[1]).toHaveLength(5);
    }
  });

  it('does not vouch for a replaced file with the old one’s hashes, and lets the old ones go', async () => {
    const db = openMemoryDatabase();
    const before = track('c.mp3', 2048);
    bookTrackHashes(db, 'c', [before], 1024);
    await settleHashing('c');
    // Same path, new bytes: a new source version.
    fs.writeFileSync(before.abs, Buffer.alloc(4096, 9));
    const after = {
      ...before,
      size: 4096,
      sourceVersion: trackSourceVersion(fs.statSync(before.abs), 'c.mp3'),
    };
    expect(bookTrackHashes(db, 'c', [after], 1024).ready).toBe(false);
    await settleHashing('c');
    const now = bookTrackHashes(db, 'c', [after], 1024);
    expect(now.ready && now.hashes[0]).toHaveLength(4);
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM track_hashes WHERE rel_path = 'c.mp3'")
      .get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });
});
