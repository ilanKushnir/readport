import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DecodedChar, type ProbeDecoder, type ProbeWindow } from './emissions.js';
import { dropProbeCache, pruneProbeCaches, readProbeCache, withProbeCache } from './probe-cache.js';

/**
 * A sync's probes, kept so that a restart picks up where it stopped: what
 * comes back must be exactly what was heard, only for the audio it was
 * heard from, and a cache that cannot be trusted or written must never stop
 * a sync.
 */

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-probe-cache-'));
  file = path.join(dir, 'pair.ndjson');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** What the model "hears" in a window: a letter per second, stamped. */
const heardIn = (w: ProbeWindow): DecodedChar[] =>
  Array.from({ length: Math.round(w.durationMs / 1000) }, (_, i) => ({
    c: String.fromCharCode(97 + ((w.startMs / 1000 + i) % 26)),
    ms: w.startMs + i * 1000,
  }));

/** A decoder that records every window it is asked to listen to. */
function fakeDecoder(listened: ProbeWindow[]): ProbeDecoder {
  let decodedMs = 0;
  return {
    model: 'mms-fa/model_int8.onnx',
    audioMs: 3_600_000,
    get decodedMs() {
      return decodedMs;
    },
    async decode(windows, onWindow) {
      return windows.map((w, i) => {
        listened.push(w);
        decodedMs += w.durationMs;
        onWindow?.(i + 1, windows.length);
        return heardIn(w);
      });
    },
    async close() {},
  };
}

const win = (s: number): ProbeWindow => ({ startMs: s * 1000, durationMs: 8000 });
const opts = (signature = 'audio-v1') => ({
  file,
  signature,
  heardMsOf: (w: ProbeWindow) => w.durationMs,
});

describe('withProbeCache', () => {
  it('serves what an earlier sync heard and listens only to the rest', async () => {
    const first: ProbeWindow[] = [];
    const a = withProbeCache(fakeDecoder(first), opts());
    const heardBefore = await a.decode([win(0), win(60)]);
    expect(first).toEqual([win(0), win(60)]);

    // The sync starts again - a deploy, a crash - over what it left behind.
    const second: ProbeWindow[] = [];
    const b = withProbeCache(fakeDecoder(second), opts());
    const done: number[] = [];
    const runs = await b.decode([win(0), win(60), win(120)], (n) => done.push(n));
    expect(second).toEqual([win(120)]);
    expect(runs.slice(0, 2)).toEqual(heardBefore);
    expect(runs[2]).toEqual(heardIn(win(120)));
    // Progress counts the windows served from disk too, and only rises.
    expect(done.at(-1)).toBe(3);
    expect([...done].sort((x, y) => x - y)).toEqual(done);
    // A window served from the cache is still audio heard.
    expect(b.decodedMs).toBe(3 * 8000);
  });

  it('never serves a cache written for other audio or another model', async () => {
    await withProbeCache(fakeDecoder([]), opts('audio-v1')).decode([win(0)]);
    const listened: ProbeWindow[] = [];
    await withProbeCache(fakeDecoder(listened), opts('audio-v2')).decode([win(0)]);
    expect(listened).toEqual([win(0)]);
    // ...and starts that cache afresh rather than mixing the two.
    expect(readProbeCache(file, 'audio-v1').size).toBe(0);
    expect(readProbeCache(file, 'audio-v2').size).toBe(1);
  });

  it('keeps everything before a line a crash cut short', async () => {
    await withProbeCache(fakeDecoder([]), opts()).decode([win(0), win(60)]);
    fs.appendFileSync(file, '{"k":"120000:8000","h":8000,"c":["a","b"');
    const kept = readProbeCache(file, 'audio-v1');
    expect([...kept.keys()]).toEqual(['0:8000', '60000:8000']);
  });

  it('goes on syncing when the cache cannot be written', async () => {
    const listened: ProbeWindow[] = [];
    const blocked = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocked, 'a file where the cache folder should be');
    const d = withProbeCache(fakeDecoder(listened), {
      ...opts(),
      file: path.join(blocked, 'pair.ndjson'),
    });
    const runs = await d.decode([win(0)]);
    expect(runs[0]).toEqual(heardIn(win(0)));
  });

  it('is forgotten once the sync is done with it', async () => {
    await withProbeCache(fakeDecoder([]), opts()).decode([win(0)]);
    dropProbeCache(file);
    expect(fs.existsSync(file)).toBe(false);
    dropProbeCache(file); // and again, harmlessly
  });
});

describe('pruneProbeCaches', () => {
  it('removes caches nothing has touched for a fortnight, and only those', () => {
    const old = path.join(dir, 'old.ndjson');
    const fresh = path.join(dir, 'fresh.ndjson');
    const other = path.join(dir, 'notes.txt');
    for (const f of [old, fresh, other]) fs.writeFileSync(f, '{}\n');
    const now = Date.now();
    const longAgo = new Date(now - 20 * 86_400_000);
    fs.utimesSync(old, longAgo, longAgo);
    fs.utimesSync(other, longAgo, longAgo);
    pruneProbeCaches(dir, 14 * 86_400_000, now);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });
});
