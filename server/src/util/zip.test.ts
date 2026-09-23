import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { zipStream, type ZipEntry } from './zip.js';

/**
 * The archive has to open in the tools people actually have. The format is
 * checked here by reading it back the way an unzip does - from the end,
 * through the central directory - and, where they are installed, by the
 * system's unzip and by Python's zipfile, which read it independently.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-zip-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function file(name: string, bytes: Buffer): ZipEntry {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  const stat = fs.statSync(p);
  return { name: `Book/${name}`, path: p, size: stat.size, mtime: stat.mtime };
}

async function collect(entries: ZipEntry[], limit?: number): Promise<Buffer> {
  const { length, stream } = zipStream(entries, limit ? { limit } : {});
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  const zip = Buffer.concat(parts);
  expect(zip.length).toBe(length);
  return zip;
}

function has(tool: string, ...args: string[]): boolean {
  try {
    execFileSync(tool, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const random = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7919) % 251));
const entries = () => [
  file('01 Chapter one.mp3', random(300_000)),
  file('02 פרק שני.mp3', random(70_001)),
  file('03 empty.mp3', Buffer.alloc(0)),
];

describe('zipStream', () => {
  it('writes exactly the length it promised, and a directory that names every file', async () => {
    const list = entries();
    const zip = await collect(list);
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(3);
    const names: string[] = [];
    let at = zip.readUInt32LE(eocd + 16);
    for (let i = 0; i < 3; i++) {
      expect(zip.readUInt32LE(at)).toBe(0x02014b50);
      const nameLen = zip.readUInt16LE(at + 28);
      names.push(zip.subarray(at + 46, at + 46 + nameLen).toString('utf8'));
      at += 46 + nameLen + zip.readUInt16LE(at + 30);
    }
    expect(names).toEqual(list.map((e) => e.name));
  });

  it.runIf(has('python3', '--version'))(
    'opens in Python, byte for byte, and in ZIP64 too',
    async () => {
      for (const limit of [undefined, 1000]) {
        const list = entries();
        const out = path.join(dir, `check-${limit ?? 'plain'}.zip`);
        fs.writeFileSync(out, await collect(list, limit));
        const script = [
          'import sys, zipfile, hashlib, json',
          'z = zipfile.ZipFile(sys.argv[1])',
          'assert z.testzip() is None',
          'print(json.dumps({i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist()}))',
        ].join('\n');
        const got = JSON.parse(execFileSync('python3', ['-c', script, out]).toString());
        const hash = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        expect(got).toEqual(Object.fromEntries(list.map((e) => [e.name, hash(e.path)])));
      }
    },
  );

  it.runIf(has('unzip', '-v'))('passes the system unzip test, ZIP64 included', async () => {
    for (const limit of [undefined, 1000]) {
      const out = path.join(dir, `unzip-${limit ?? 'plain'}.zip`);
      fs.writeFileSync(out, await collect(entries(), limit));
      expect(() => execFileSync('unzip', ['-tq', out], { stdio: 'pipe' })).not.toThrow();
    }
  });

  it('fails the stream when a file changes size under it', async () => {
    const [e] = entries();
    const { stream } = zipStream([{ ...e!, size: e!.size + 10 }]);
    await expect(
      (async () => {
        for await (const _ of stream) void _;
      })(),
    ).rejects.toThrow(/shrank/);
  });
});
