import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { scanRoots } from './scan.js';

/**
 * The scan reads each file's head and tail to notice a changed book. It
 * reads them without blocking the server (a network share takes its time),
 * never twice for a file that has not changed, and to exactly the hash it
 * always gave - a new hash for an unchanged file would re-index the whole
 * library the first time the new version scans it.
 */

let tmp: string;
let ebooks: string;
let audio: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-scan-hash-'));
  ebooks = path.join(tmp, 'ebooks');
  audio = path.join(tmp, 'audio');
  fs.mkdirSync(path.join(ebooks, 'Some Author'), { recursive: true });
  fs.mkdirSync(path.join(audio, 'Some Author', 'A Book'), { recursive: true });
  fs.writeFileSync(path.join(ebooks, 'Some Author', 'a.epub'), randomBytes(200_000));
  for (const n of [1, 2, 3])
    fs.writeFileSync(path.join(audio, 'Some Author', 'A Book', `0${n}.mp3`), randomBytes(90_000));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The hash as the scan has always worked it out. */
function expected(file: string): string {
  const st = fs.statSync(file);
  const buf = fs.readFileSync(file);
  const h = createHash('sha256');
  h.update(`${st.size}:${Math.floor(st.mtimeMs)}`);
  h.update(buf.subarray(0, Math.min(65536, st.size)));
  if (st.size > 65536) h.update(buf.subarray(st.size - 65536));
  return h.digest('hex').slice(0, 32);
}

describe('scanning a library', () => {
  it('hashes every file to what it always hashed to', async () => {
    const report = await scanRoots([ebooks], [audio]);
    expect(report.ebooks[0]!.contentHash).toBe(
      expected(path.join(ebooks, 'Some Author', 'a.epub')),
    );
    const book = report.audiobooks[0]!;
    const h = createHash('sha256');
    for (const t of book.tracks) h.update(expected(path.join(audio, t.relPath)));
    expect(book.contentHash).toBe(h.digest('hex').slice(0, 32));
    expect(book.tracks.map((t) => path.basename(t.relPath))).toEqual([
      '01.mp3',
      '02.mp3',
      '03.mp3',
    ]);
  });

  it('does not read a file again until it changes', async () => {
    const open = vi.spyOn(fs.promises, 'open');
    await scanRoots([ebooks], [audio]);
    expect(open).not.toHaveBeenCalled();
    const changed = path.join(audio, 'Some Author', 'A Book', '02.mp3');
    fs.writeFileSync(changed, randomBytes(91_000));
    const report = await scanRoots([ebooks], [audio]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toBe(changed);
    const h = createHash('sha256');
    for (const t of report.audiobooks[0]!.tracks) h.update(expected(path.join(audio, t.relPath)));
    expect(report.audiobooks[0]!.contentHash).toBe(h.digest('hex').slice(0, 32));
    open.mockRestore();
  });
});
