import fs from 'node:fs';
import path from 'node:path';
import { type DecodedChar, type ProbeDecoder, type ProbeWindow } from './emissions.js';

/**
 * What a sync has heard so far, kept on disk so that it outlives the process.
 *
 * Listening is the whole cost of a sync - more than an hour and a half of it
 * for a long book - and a restart used to throw all of it away: a deploy, a
 * container recreated, a server that froze and was restarted three times
 * over, each one sending the sync back to the first second of the narration.
 * The probes themselves are cheap to keep (a few megabytes for the longest
 * book) and are exactly the same next time - the same window of the same
 * audio through the same model hears the same characters - so a sync that
 * starts again over a cache it left behind serves those from disk and only
 * listens to what it had not reached.
 *
 * One file per pair: a header saying what the probes were heard from, then a
 * line per probe. Appended a batch at a time, so a crash costs at most the
 * batch it interrupted; a line cut short by one is where the cache ends.
 */

const FORMAT = 1;

interface Kept {
  chars: DecodedChar[];
  /** Audio this probe put through the model, so the total heard stays honest. */
  heardMs: number;
}

export interface ProbeCacheOptions {
  file: string;
  /**
   * What the probes were heard from - the model and the audio files - so
   * that a cache of anything else is never served. Any change starts afresh.
   */
  signature: string;
  /**
   * How much audio a window puts through the model. A probe served from the
   * cache is still a probe heard, and the abridgement check divides by the
   * total.
   */
  heardMsOf: (window: ProbeWindow) => number;
}

const keyOf = (w: ProbeWindow) => `${Math.round(w.startMs)}:${Math.round(w.durationMs)}`;

/** The probes a cache file holds, when it was written for `signature`. */
export function readProbeCache(file: string, signature: string): Map<string, Kept> {
  const kept = new Map<string, Kept>();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return kept;
  }
  const lines = text.split('\n');
  try {
    const head = JSON.parse(lines[0] ?? '') as { v?: unknown; sig?: unknown };
    if (head.v !== FORMAT || head.sig !== signature) return kept;
  } catch {
    return kept;
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const e = JSON.parse(line) as { k: string; h: number; c: string[]; m: number[] };
      if (typeof e.k !== 'string' || !Array.isArray(e.c) || !Array.isArray(e.m)) break;
      if (e.c.length !== e.m.length) break;
      kept.set(e.k, {
        chars: e.c.map((c, j) => ({ c: String(c), ms: Number(e.m[j]) })),
        heardMs: Number(e.h) || 0,
      });
    } catch {
      // A line cut short by a crash: everything before it is good.
      break;
    }
  }
  return kept;
}

/**
 * The decoder, answering from the cache where it can and adding to it what
 * it has to listen to.
 *
 * Never fails a sync over the cache: a file that cannot be written is
 * a sync that will not resume, not a sync that stops.
 */
export function withProbeCache(inner: ProbeDecoder, opts: ProbeCacheOptions): ProbeDecoder {
  const kept = readProbeCache(opts.file, opts.signature);
  let writable = true;
  try {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    // Anything that is not this signature's cache is replaced, header first.
    if (kept.size === 0) {
      fs.writeFileSync(opts.file, `${JSON.stringify({ v: FORMAT, sig: opts.signature })}\n`);
    }
  } catch {
    writable = false;
  }
  let fromCacheMs = 0;

  return {
    get model() {
      return inner.model;
    },
    get audioMs() {
      return inner.audioMs;
    },
    get decodedMs() {
      return inner.decodedMs + fromCacheMs;
    },
    async decode(windows, onWindow) {
      const out: DecodedChar[][] = new Array<DecodedChar[]>(windows.length);
      const todo: number[] = [];
      windows.forEach((w, i) => {
        const hit = kept.get(keyOf(w));
        if (hit) {
          out[i] = hit.chars;
          fromCacheMs += hit.heardMs;
        } else {
          todo.push(i);
        }
      });
      const served = windows.length - todo.length;
      if (served > 0) onWindow?.(served, windows.length);
      if (todo.length > 0) {
        const runs = await inner.decode(
          todo.map((i) => windows[i]!),
          (done) => onWindow?.(served + done, windows.length),
        );
        const lines: string[] = [];
        todo.forEach((i, j) => {
          const chars = runs[j] ?? [];
          const w = windows[i]!;
          out[i] = chars;
          const entry = { chars, heardMs: opts.heardMsOf(w) };
          kept.set(keyOf(w), entry);
          lines.push(
            JSON.stringify({
              k: keyOf(w),
              h: entry.heardMs,
              c: chars.map((c) => c.c),
              m: chars.map((c) => c.ms),
            }),
          );
        });
        if (writable && lines.length > 0) {
          try {
            fs.appendFileSync(opts.file, `${lines.join('\n')}\n`);
          } catch {
            writable = false;
          }
        }
      }
      return out;
    },
    close: () => inner.close(),
  };
}

/** Forget a pair's probes: the sync they were for is finished, or refused. */
export function dropProbeCache(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* a cache that cannot be removed is a few megabytes, not a fault */
  }
}

/**
 * Remove caches nothing has touched for `maxAgeMs`: a sync that failed for
 * good and was never asked for again leaves its probes behind otherwise.
 */
export function pruneProbeCaches(dir: string, maxAgeMs: number, now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.ndjson')) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.rmSync(file, { force: true });
    } catch {
      /* raced with a sync finishing, or not ours to touch */
    }
  }
}
