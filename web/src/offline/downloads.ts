import { api, notifyUnauthorized } from '../api/client';
import { idbAll, idbClear, idbDelete, idbGet, idbPut, STORES } from '../progress/idb';
import { type BookSummary, type Locator, type SwitchResolution } from '@readport/shared';
import { type MessageKey } from '../i18n/messages/en';

/**
 * Explicit per-title offline packages. Downloads go into a dedicated Cache
 * Storage bucket the service worker consults before the network; state and
 * real byte counts live in IndexedDB and drive honest UI.
 *
 * Integrity: every static entry in the server's offline manifest carries its
 * byte size and SHA-256. Each response is verified BEFORE it is cached, and
 * the package is only marked complete after every entry verified. Audio
 * tracks are fetched with Range requests in bounded chunks (never one giant
 * ArrayBuffer), stored chunk-by-chunk, and served back by the service worker
 * with correct 206/Content-Range behavior.
 */

export const OFFLINE_CACHE = 'rp-offline-v1';
/** Per-chunk audio buffer bound (max bytes in memory at once per download). */
export const AUDIO_CHUNK_BYTES = 8 * 1024 * 1024;

/* Cache-key conventions - MUST stay in sync with web/public/sw-range.js
   (asserted by web/src/offline/downloads.test.ts). */
export const chunkPrefix = (url: string) => `${url}${url.includes('?') ? '&' : '?'}rpchunk=`;
export const chunkKey = (url: string, i: number) => `${chunkPrefix(url)}${i}`;
export const metaKey = (url: string) => `${url}${url.includes('?') ? '&' : '?'}rpmeta=1`;
/** In-progress marker recording which source version partial chunks belong to
    (client-only; the service worker never serves from it). */
export const partialMetaKey = (url: string) => `${url}${url.includes('?') ? '&' : '?'}rppartial=1`;
export const chunkCount = (size: number, chunk: number) =>
  size === 0 ? 0 : Math.ceil(size / chunk);

export interface OfflineManifestEntry {
  url: string;
  sizeBytes: number;
  kind: string;
  sha256?: string;
  dynamic?: boolean;
  /** Tracks: immutable identity of the source file's bytes. */
  sourceVersion?: string;
  /** Tracks: fixed chunk size the per-chunk hashes were computed over. */
  chunkSize?: number;
  /** Tracks: SHA-256 per chunk, in order. */
  chunkHashes?: string[];
}

/**
 * Why a download stopped, as something the interface can put into words.
 * The Error itself carries the developer's detail (which URL, which chunk);
 * the code is what a reader is told, in their own language.
 */
export type DownloadErrorCode =
  | 'no-cache-storage'
  | 'out-of-space'
  | 'http'
  | 'invalid-response'
  | 'size-mismatch'
  | 'integrity'
  | 'missing-integrity'
  | 'no-range'
  | 'wrong-range'
  | 'source-changed'
  /** The connection kept failing, however many times it was tried. */
  | 'network'
  /** The server kept answering with an error. */
  | 'server'
  /** Data stopped arriving, and kept stopping. */
  | 'stalled'
  /** The app was closed, or the phone put it to sleep, part way through. */
  | 'interrupted'
  /** Signed out part way through. */
  | 'unauthorized';

export class DownloadError extends Error {
  constructor(
    public code: DownloadErrorCode,
    detail: string,
    /** Worth trying again: the same request may well work in a moment. */
    public transient = false,
  ) {
    super(detail);
    this.name = 'DownloadError';
  }
}

/** The catalog key that explains a stopped download; a plain "failed" when the cause is unknown. */
export function downloadErrorKey(code: DownloadErrorCode | undefined): MessageKey {
  return code ? (`library.download.error.${code}` as const) : 'library.download.failed';
}

export interface DownloadState {
  bookId: string;
  /** The book's title, so anywhere in the app can say what is downloading. */
  title?: string;
  status: 'idle' | 'downloading' | 'done' | 'error' | 'cancelled';
  /**
   * What a running download is doing: `preparing` - the server is readying
   * the files; `checking` - parts an earlier attempt saved are being checked;
   * `saving` - bytes are arriving; `waiting` - for a connection, or for the
   * app to be in front again; `retrying` - something failed and it is about
   * to try again.
   */
  phase?: 'preparing' | 'checking' | 'saving' | 'waiting' | 'retrying';
  /** While preparing: how much of the book the server has read so far. */
  prepared?: { done: number; total: number };
  /** Bytes of the part arriving right now, not stored yet. */
  receivingBytes?: number;
  totalUrls: number;
  doneUrls: number;
  estimatedBytes: number;
  storedBytes: number;
  /** The developer's detail of the failure, kept for diagnosis. */
  error?: string;
  /** What the reader is told, when the cause is one this app can name. */
  errorCode?: DownloadErrorCode;
  updatedAt: string;
  urls: string[];
}

/**
 * How far along a download is, 0–1.
 *
 * Bytes, not files. A paired audiobook is a handful of very large tracks, so
 * counting finished URLs leaves the bar on 0% for minutes and then jumps it to
 * a half - which reads as nothing happening. `storedBytes` is updated every
 * chunk, so it actually moves. The URL count is the fallback for the moment
 * before the manifest's size is known.
 */
export function downloadFraction(
  dl: Pick<
    DownloadState,
    'storedBytes' | 'estimatedBytes' | 'doneUrls' | 'totalUrls' | 'receivingBytes'
  >,
): number {
  // The part arriving counts as it arrives: a part is 8 MB, and on a slow
  // connection a bar that only moves when one is finished moves every half
  // minute.
  if (dl.estimatedBytes > 0)
    return Math.min(1, (dl.storedBytes + (dl.receivingBytes ?? 0)) / dl.estimatedBytes);
  if (dl.totalUrls > 0) return Math.min(1, dl.doneUrls / dl.totalUrls);
  return 0;
}

/** The same thing as a whole percent, which is what every caller displays. */
export function downloadPercent(
  dl: Pick<
    DownloadState,
    'storedBytes' | 'estimatedBytes' | 'doneUrls' | 'totalUrls' | 'receivingBytes'
  >,
): number {
  return Math.round(downloadFraction(dl) * 100);
}

/** How far the server has got preparing the files, 0-1, while it is. */
export function preparedFraction(dl: Pick<DownloadState, 'prepared'>): number {
  const p = dl.prepared;
  return p && p.total > 0 ? Math.min(1, p.done / p.total) : 0;
}

/** Downloads this device is working on right now, newest first. */
export async function listActiveDownloads(): Promise<DownloadState[]> {
  return (await listDownloads())
    .filter((d) => d.status === 'downloading' || d.status === 'error')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getDownloadState(bookId: string): Promise<DownloadState | null> {
  const stored = (await idbGet<DownloadState>(STORES.downloads, bookId)) ?? null;
  return stored ? reconcile(stored) : null;
}

/** Every download this browser knows about (any status). */
export async function listDownloads(): Promise<DownloadState[]> {
  try {
    const all = (await idbAll<DownloadState>(STORES.downloads)).map((d) => d.value);
    return await Promise.all(all.map(reconcile));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------ liveness */

const lockName = (bookId: string) => `rp-download:${bookId}`;

type LockManagerLike = {
  request: (
    name: string,
    opts: { ifAvailable: boolean },
    cb: (lock: unknown) => Promise<void>,
  ) => Promise<void>;
  query?: () => Promise<{ held?: { name?: string }[] }>;
};
const lockManager = (): LockManagerLike | null =>
  typeof navigator !== 'undefined'
    ? ((navigator as unknown as { locks?: LockManagerLike }).locks ?? null)
    : null;

/**
 * A download recorded as running that nothing is running - the app was
 * closed, or the phone put it to sleep - is said to have stopped, so it can
 * be tried again or removed. It used to sit at its last percent for ever,
 * with a Cancel that had nothing to cancel.
 *
 * Every running download holds a Web Lock named for its book, in whichever
 * tab runs it, and a closed tab lets go of its locks. Where there are no
 * Web Locks, a record left untouched for five minutes is taken as stopped.
 */
async function reconcile(d: DownloadState): Promise<DownloadState> {
  if (d.status !== 'downloading' || activeDownloads.has(d.bookId)) return d;
  const locks = lockManager();
  let running: boolean;
  if (locks?.query) {
    try {
      const { held = [] } = await locks.query();
      running = held.some((l) => l.name === lockName(d.bookId));
    } catch {
      running = true;
    }
  } else {
    running = Date.now() - Date.parse(d.updatedAt) < 5 * 60_000;
  }
  if (running) return d;
  const stopped: DownloadState = {
    ...d,
    status: 'error',
    errorCode: 'interrupted',
    phase: undefined,
    receivingBytes: 0,
  };
  try {
    await idbPut(STORES.downloads, d.bookId, stopped);
  } catch {
    /* told as stopped either way */
  }
  return stopped;
}

/* ------------------------------------------------------------- telling */

/** Hears every change to any download: a state, or null when it was removed. */
export type DownloadListener = (bookId: string, state: DownloadState | null) => void;
const listeners = new Set<DownloadListener>();
let channel: BroadcastChannel | null | undefined;

/**
 * Downloads are told to whoever is listening in this tab, and through a
 * BroadcastChannel to every other tab of the app: a download started on the
 * book page is watched from the library, the sidebar and the other tab
 * alike, instead of each of them reading a snapshot once.
 */
function bus(): BroadcastChannel | null {
  if (channel === undefined) {
    channel =
      typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function'
        ? new window.BroadcastChannel('rp-downloads')
        : null;
    channel?.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as { bookId?: unknown; state?: DownloadState | null } | null;
      if (typeof data?.bookId !== 'string') return;
      for (const l of listeners) l(data.bookId, data.state ?? null);
    });
  }
  return channel;
}

function publish(bookId: string, state: DownloadState | null): void {
  for (const l of listeners) l(bookId, state);
  try {
    bus()?.postMessage({ bookId, state });
  } catch {
    /* a closed channel: this tab is going away */
  }
}

/** Listen to every download. `bookId` is `*` when everything changed at once (a purge). */
export function subscribeDownloads(listener: DownloadListener): () => void {
  bus();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The book summary embedded in a downloaded title's cached detail JSON -
 * enough to render a library card with no network at all.
 */
export async function cachedBookSummary(bookId: string): Promise<BookSummary | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const cache = await caches.open(OFFLINE_CACHE);
    const hit = await cache.match(`/api/books/${bookId}`);
    if (!hit) return null;
    const data = (await hit.json()) as { book?: BookSummary };
    return data.book ?? null;
  } catch {
    return null;
  }
}

/** One precomputed cross-medium switch answer (see the offline-switch route). */
interface OfflineSwitchEntry {
  sentenceId?: string;
  atMs?: number;
  to: Locator | null;
  resolution: SwitchResolution;
}

interface OfflineSwitchTable {
  pairId: string;
  otherBookId: string;
  direction: 'ebook-to-audio' | 'audio-to-ebook';
  gridMs?: number;
  entries: OfflineSwitchEntry[];
}

/**
 * Where a switch to the other edition lands, answered from the downloaded
 * package alone.
 *
 * Every answer here was computed by the SERVER's resolver when the package
 * was built, so an offline handoff lands exactly where an online one would;
 * this only picks the right entry. Returns null when the position has no
 * stored answer - an unaligned passage, or a saved position with no sentence
 * id - and the caller should say so rather than guess.
 */
export async function cachedSwitch(
  bookId: string,
  from: Locator,
): Promise<{ to: Locator | null; resolution: SwitchResolution } | null> {
  let table: OfflineSwitchTable;
  try {
    if (typeof caches === 'undefined') return null;
    const cache = await caches.open(OFFLINE_CACHE);
    const hit = await cache.match(`/api/books/${bookId}/offline-switch`);
    if (!hit) return null;
    table = (await hit.json()) as OfflineSwitchTable;
  } catch {
    return null;
  }
  if (!Array.isArray(table.entries)) return null;
  if (from.medium === 'ebook') {
    if (table.direction !== 'ebook-to-audio' || !from.sentenceId) return null;
    const hit = table.entries.find((e) => e.sentenceId === from.sentenceId);
    return hit ? { to: hit.to, resolution: hit.resolution } : null;
  }
  if (table.direction !== 'audio-to-ebook' || from.bookMs === undefined) return null;
  // Entries are run-length encoded in time order: the answer in force is the
  // last one starting at or before this position.
  let found: OfflineSwitchEntry | null = null;
  for (const e of table.entries) {
    if (e.atMs === undefined || e.atMs > from.bookMs) break;
    found = e;
  }
  return found ? { to: found.to, resolution: found.resolution } : null;
}

const controllers = new Map<string, AbortController>();

async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  try {
    if (!crypto?.subtle) return null; // insecure context: size checks still apply
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Sent on every request a download makes, so the service worker stays out
 * of the way (web/public/sw.js): the page stores what it fetches itself,
 * and a worker in the middle of a long transfer is one more thing a phone
 * can stop half way.
 */
export const DIRECT_HEADER = 'x-rp-direct';

function fetchOpts(range?: string): RequestInit {
  return {
    credentials: 'same-origin',
    headers: { 'x-rp-csrf': '1', [DIRECT_HEADER]: '1', ...(range ? { range } : {}) },
  };
}

/* ------------------------------------------------------------ retrying */

/**
 * How a failed request is tried again.
 *
 * A gigabyte of audio is some 120 requests in a row, and on a phone one of
 * them failing is not bad luck but a certainty: with nothing tried again, a
 * one-in-two-hundred failure rate ended almost half of all such downloads,
 * and the reader had to tap Try again. Now each request gets several more
 * goes, further apart each time, after waiting for the network - and for
 * the app to be in front again - before each one. A request that goes
 * quiet (`stallMs` with no bytes) is given up on and tried again too.
 *
 * Mutable only so tests can take the waiting out.
 */
export const downloadTiming = {
  retryDelaysMs: [1000, 2000, 4000, 8000, 16000, 30000],
  stallMs: 30_000,
  preparePollMs: 1500,
};

const abortError = () => new DOMException('aborted', 'AbortError');

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Online, and in front: a request made from a hidden page or with no network only fails again. */
function canTry(): boolean {
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const shown = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  return online && shown;
}

async function untilCanTry(signal: AbortSignal, onWait: () => void): Promise<void> {
  if (canTry()) return;
  onWait();
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!canTry()) return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    // The events are the signal; the poll is for a browser that misses one.
    const poll = setInterval(check, 5000);
    const cleanup = () => {
      clearInterval(poll);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
      signal.removeEventListener('abort', onAbort);
    };
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Whether a failure is worth another try: a dropped connection or a busy server, not a refusal. */
function isTransient(err: unknown): boolean {
  if (err instanceof DownloadError) return err.transient;
  if (isQuotaError(err)) return false;
  if (err instanceof DOMException) return err.name === 'NetworkError';
  // The api() wrapper's errors: status 0 is the network, 5xx and friends a
  // server that may answer in a moment.
  const status = (err as { name?: string; status?: number }).status;
  if ((err as { name?: string }).name === 'ApiError' && typeof status === 'number')
    return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  // fetch() rejects with a TypeError when the connection fails ("Load
  // failed", "Failed to fetch", "NetworkError when attempting..."), and a
  // body cut off half way rejects much the same.
  return err instanceof Error;
}

interface RetryHooks {
  /** An attempt is starting. */
  onAttempt?: () => void;
  /** Waiting for a connection, or for the app to be in front again. */
  onWait?: () => void;
  /** An attempt failed and another is coming. */
  onRetry?: (err: unknown) => void;
}

async function withRetry<T>(
  signal: AbortSignal,
  attempt: () => Promise<T>,
  hooks: RetryHooks = {},
): Promise<T> {
  const delays = downloadTiming.retryDelaysMs;
  for (let i = 0; ; i++) {
    if (signal.aborted) throw abortError();
    await untilCanTry(signal, () => hooks.onWait?.());
    hooks.onAttempt?.();
    try {
      return await attempt();
    } catch (err) {
      if (signal.aborted || !isTransient(err) || i >= delays.length) throw err;
      hooks.onRetry?.(err);
      // Jittered, so two tabs or two devices do not retry in step.
      await sleep(delays[i]! * (0.8 + Math.random() * 0.4), signal);
    }
  }
}

/**
 * One request, watched: `signal` is the download's own (cancel, sign-out),
 * and a request that sends nothing for `stallMs` - no answer, or no more of
 * its body - is abandoned as stalled, which is tried again.
 */
async function watchedFetch<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  read: (res: Response, alive: () => void, attempt: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw abortError();
  const ctl = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctl.abort();
    }, downloadTiming.stallMs);
  };
  const forward = () => ctl.abort();
  signal.addEventListener('abort', forward, { once: true });
  alive();
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    alive();
    return await read(res, alive, ctl.signal);
  } catch (err) {
    if (stalled && !signal.aborted) {
      throw new DownloadError(
        'stalled',
        `Nothing arrived for ${downloadTiming.stallMs / 1000}s from ${url}`,
        true,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forward);
  }
}

/** A refusal or a failure, by status: which of them are worth another try. */
function statusError(url: string, status: number): DownloadError {
  if (status === 401) {
    // Signed out: the app finds out and clears what it holds. Not awaited -
    // that clearing waits for this download to stop, which it is about to.
    void notifyUnauthorized(url);
    return new DownloadError('unauthorized', `Signed out while downloading ${url}`);
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500)
    return new DownloadError('server', `The server answered ${status} for ${url}`, true);
  return new DownloadError('http', `Download failed (${status}) for ${url}`);
}

/**
 * A response body, read as it arrives: `alive` is told of every piece, so a
 * body that stops arriving is caught as a stall, and `onBytes` hears the
 * running total, so a bar can move inside one 8 MB part. With `expected`,
 * the bytes go straight into a buffer of that size and anything else is a
 * size mismatch.
 */
async function readBody(
  res: Response,
  url: string,
  expected: number | null,
  alive: () => void,
  attempt: AbortSignal,
  onBytes?: (received: number) => void,
): Promise<ArrayBuffer> {
  const reader = res.body?.getReader();
  /**
   * The next piece, or the attempt's end: a body is supposed to fail when
   * its request is aborted, and not every one does, so a stall must not
   * depend on it.
   */
  const next = () =>
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      const onAbort = () => {
        void reader?.cancel().catch(() => {});
        reject(abortError());
      };
      if (attempt.aborted) return onAbort();
      attempt.addEventListener('abort', onAbort, { once: true });
      reader!.read().then(
        (r) => {
          attempt.removeEventListener('abort', onAbort);
          resolve(r);
        },
        (err: unknown) => {
          attempt.removeEventListener('abort', onAbort);
          reject(err as Error);
        },
      );
    });
  if (!reader) {
    const buf = await res.arrayBuffer();
    onBytes?.(buf.byteLength);
    if (expected !== null && buf.byteLength !== expected) {
      throw new DownloadError(
        'size-mismatch',
        `Size mismatch for ${url}: got ${buf.byteLength}, expected ${expected}`,
        true,
      );
    }
    return buf;
  }
  const out = expected !== null ? new Uint8Array(expected) : null;
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await next();
    if (done) break;
    alive();
    if (out) {
      if (got + value.byteLength > out.byteLength) {
        await reader.cancel().catch(() => {});
        throw new DownloadError(
          'size-mismatch',
          `Size mismatch for ${url}: more than the expected ${expected} bytes`,
          true,
        );
      }
      out.set(value, got);
    } else parts.push(value);
    got += value.byteLength;
    onBytes?.(got);
  }
  if (out) {
    if (got !== out.byteLength) {
      throw new DownloadError(
        'size-mismatch',
        `Size mismatch for ${url}: got ${got}, expected ${expected}`,
        true,
      );
    }
    return out.buffer;
  }
  const whole = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    whole.set(p, at);
    at += p.byteLength;
  }
  return whole.buffer;
}

/** Download + verify one non-chunked entry; returns stored byte count. */
export async function downloadEntry(
  cache: Cache,
  entry: OfflineManifestEntry,
  signal: AbortSignal,
  hooks: RetryHooks = {},
): Promise<number> {
  const existing = await cache.match(entry.url);
  if (existing) return Number(existing.headers.get('content-length') ?? 0);
  return withRetry(
    signal,
    () =>
      watchedFetch(entry.url, fetchOpts(), signal, async (res, alive, attempt) => {
        if (!res.ok) throw statusError(entry.url, res.status);
        const buf = await readBody(
          res,
          entry.url,
          entry.dynamic ? null : entry.sizeBytes,
          alive,
          attempt,
        );
        if (entry.dynamic) {
          // Dynamic JSON has no stable hash; validate structure instead.
          try {
            JSON.parse(new TextDecoder().decode(buf));
          } catch {
            throw new DownloadError('invalid-response', `Invalid response for ${entry.url}`);
          }
        } else if (entry.sha256) {
          const digest = await sha256Hex(buf);
          if (digest !== null && digest !== entry.sha256) {
            throw new DownloadError('integrity', `Integrity check failed for ${entry.url}`, true);
          }
        }
        await cache.put(
          entry.url,
          new Response(buf, {
            headers: {
              'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
              'content-length': String(buf.byteLength),
            },
          }),
        );
        return buf.byteLength;
      }),
    hooks,
  );
}

/**
 * Every key this cache holds, spelled the way entries were written.
 *
 * Enumerated ONCE per removal and passed down: a package is hundreds of
 * URLs and the cache is thousands of entries, so re-reading the key list per
 * URL turns removing one audiobook into thousands of full enumerations.
 */
async function cacheKeyPaths(cache: Cache): Promise<string[]> {
  return (await cache.keys()).map((req) => {
    // Cache Storage hands back absolute URLs; entries were written relative.
    try {
      const parsed = new URL(req.url, 'http://vx.invalid');
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return req.url; // not a parseable URL: compare as given
    }
  });
}

/**
 * Every chunk key this cache actually holds for `url`.
 *
 * Deletion must ENUMERATE rather than count upwards from zero: chunks go
 * missing out of order (a failed resume, an eviction under storage
 * pressure), and a scan that stops at - or a fixed window past - the first
 * gap orphans everything beyond it, with nothing else in the app that would
 * ever collect it.
 */
async function storedChunkKeys(cache: Cache, url: string, paths?: string[]): Promise<string[]> {
  const prefix = chunkPrefix(url);
  const all = paths ?? (await cacheKeyPaths(cache));
  return all.filter((p) => p.startsWith(prefix) && /^\d+$/.test(p.slice(prefix.length)));
}

/** Remove a chunked track's completion meta, partial marker, and chunks. */
async function deleteTrackChunks(cache: Cache, url: string, paths?: string[]): Promise<void> {
  await cache.delete(metaKey(url));
  await cache.delete(partialMetaKey(url));
  for (const key of await storedChunkKeys(cache, url, paths)) await cache.delete(key);
}

/**
 * Download one audio track as verified fixed-size chunks. Memory use is
 * bounded by the chunk size regardless of the track size (a whole-file
 * ArrayBuffer of a large M4B would OOM an iPhone tab), and hashing is
 * per-chunk - the file is never digested through one giant buffer.
 *
 * Integrity: the manifest supplies an immutable sourceVersion plus a
 * SHA-256 per chunk. Every fetched chunk must arrive as an exact 206 with
 * the exact Content-Range, the expected byte count, an ETag matching the
 * sourceVersion, and a matching chunk digest - otherwise the download
 * fails without storing the chunk. A resume first checks the stored
 * partial marker: chunks downloaded under a DIFFERENT source version are
 * discarded wholesale (old and new bytes are never combined), and chunks
 * kept from a matching earlier attempt are re-hashed before being trusted.
 * The completion meta - which makes the track servable offline - is
 * written only after every chunk verified.
 */
export async function downloadTrackChunked(
  cache: Cache,
  entry: OfflineManifestEntry,
  signal: AbortSignal,
  onChunk: (bytes: number) => Promise<void>,
  hooks: RetryHooks & {
    /** Bytes of the part arriving now, as they arrive; 0 when it is stored or given up. */
    onReceiving?: (bytes: number) => void;
    /** Parts an earlier attempt saved are being checked before anything is fetched. */
    onChecking?: () => void;
  } = {},
): Promise<void> {
  const version = entry.sourceVersion;
  const hashes = entry.chunkHashes;
  const chunkSize = entry.chunkSize ?? AUDIO_CHUNK_BYTES;
  const total = entry.sizeBytes;
  const chunks = chunkCount(total, chunkSize);
  if (!version || !hashes || hashes.length !== chunks) {
    // Fail closed: without the integrity contract nothing is stored.
    throw new DownloadError(
      'missing-integrity',
      `Offline manifest is missing integrity data for ${entry.url}`,
    );
  }

  const doneMetaRes = await cache.match(metaKey(entry.url));
  if (doneMetaRes) {
    const doneMeta = (await doneMetaRes.json()) as { sourceVersion?: string };
    if (doneMeta.sourceVersion === version) {
      await onChunk(entry.sizeBytes);
      return;
    }
    // The source was replaced since this track completed: rebuild from zero.
    await deleteTrackChunks(cache, entry.url);
  }

  // Resume bookkeeping: partial chunks are only reusable when they were
  // fetched from the SAME source version.
  const partialRes = await cache.match(partialMetaKey(entry.url));
  if (partialRes) {
    const partial = (await partialRes.json()) as { sourceVersion?: string };
    if (partial.sourceVersion !== version) await deleteTrackChunks(cache, entry.url);
  }
  await cache.put(
    partialMetaKey(entry.url),
    new Response(JSON.stringify({ sourceVersion: version, chunkSize }), {
      headers: { 'content-type': 'application/json' },
    }),
  );

  let contentType = 'audio/mpeg';
  let checking = false;
  for (let i = 0; i < chunks; i++) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const start = i * chunkSize;
    const end = Math.min(total, start + chunkSize) - 1;
    const expectedLen = end - start + 1;

    const existing = await cache.match(chunkKey(entry.url, i));
    if (existing) {
      // Same-version leftover from an interrupted attempt: re-verify its
      // bytes before counting it.
      if (!checking) {
        checking = true;
        hooks.onChecking?.();
      }
      const buf = await existing.arrayBuffer();
      const digest = await sha256Hex(buf);
      if (buf.byteLength === expectedLen && (digest === null || digest === hashes[i])) {
        await onChunk(buf.byteLength);
        continue;
      }
      await cache.delete(chunkKey(entry.url, i));
    }
    checking = false;

    // One part, tried again as often as it takes (see withRetry). The
    // bytes of an attempt that fails are not counted: the bar goes back to
    // what is actually stored.
    const part = await withRetry(
      signal,
      () =>
        watchedFetch(
          entry.url,
          fetchOpts(`bytes=${start}-${end}`),
          signal,
          async (res, alive, attempt) => {
            if (res.status !== 206) {
              // A 200 is a server that ignores Range: asking again will not
              // change its mind, and buffering the whole file is not an option.
              if (res.status === 200 || res.status === 416) {
                throw new DownloadError(
                  'no-range',
                  `Server did not honor Range for ${entry.url} (status ${res.status})`,
                );
              }
              throw statusError(entry.url, res.status);
            }
            const contentRange = res.headers.get('content-range');
            if (contentRange !== `bytes ${start}-${end}/${total}`) {
              throw new DownloadError(
                'wrong-range',
                `Wrong Content-Range for ${entry.url}: got "${contentRange ?? ''}", expected "bytes ${start}-${end}/${total}"`,
                true,
              );
            }
            const etag = res.headers.get('etag');
            if (etag && etag.replace(/^(W\/)?"|"$/g, '') !== version) {
              // The source file changed under us mid-download: nothing stored
              // so far may be combined with the new bytes.
              await deleteTrackChunks(cache, entry.url);
              throw new DownloadError(
                'source-changed',
                `Source changed during download of ${entry.url}; download restarted`,
              );
            }
            try {
              const buf = await readBody(
                res,
                entry.url,
                expectedLen,
                alive,
                attempt,
                hooks.onReceiving,
              );
              const digest = await sha256Hex(buf);
              if (digest !== null && digest !== hashes[i]) {
                throw new DownloadError(
                  'integrity',
                  `Integrity check failed for ${entry.url} (chunk ${i})`,
                  true,
                );
              }
              return { buf, type: res.headers.get('content-type') };
            } catch (err) {
              hooks.onReceiving?.(0);
              throw err;
            }
          },
        ),
      hooks,
    );
    contentType = part.type ?? contentType;
    await cache.put(
      chunkKey(entry.url, i),
      new Response(part.buf, { headers: { 'content-length': String(part.buf.byteLength) } }),
    );
    hooks.onReceiving?.(0);
    await onChunk(part.buf.byteLength);
  }
  // Completion marker: only now does the service worker serve this track.
  await cache.put(
    metaKey(entry.url),
    new Response(JSON.stringify({ size: total, chunkSize, contentType, sourceVersion: version }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await cache.delete(partialMetaKey(entry.url));
}

/** In-flight download loops, so a purge can wait for writers to stop. */
const activeDownloads = new Map<string, Promise<void>>();

/**
 * Slack demanded on top of a package's own size before starting it. Cache
 * Storage adds per-entry overhead and the estimate itself is deliberately
 * fuzzy in every browser, so a download that only just fits is one that
 * fails halfway.
 */
const QUOTA_HEADROOM = 1.1;

/**
 * Running out of room is reported as its own code: the raw DOMException
 * ("The quota has been exceeded.") tells the reader nothing they can act on.
 */
function isQuotaError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

/**
 * Purge generation: bumped by purgeOfflineData() once every registered
 * writer has settled. A download continuation from before the bump - e.g.
 * a manifest request that resolves only after logout completed - belongs
 * to a dead generation and must not write to Cache Storage or IndexedDB.
 */
let purgeGeneration = 0;

/** Reject as soon as the signal aborts, even if `p` itself never settles. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal.aborted) {
      p.catch(() => {}); // abandoned: its outcome is discarded
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err as Error);
      },
    );
  });
}

/**
 * Ask the browser to keep this origin's storage.
 *
 * Without it Safari evicts everything after seven days of not opening the app
 * - the downloaded books AND the queue of unsent reading positions - which is
 * precisely the interval between packing for a trip and getting on the plane.
 * Asked at the moment someone downloads a book, because that is the clearest
 * possible statement that they want it kept, and because Chrome grants it on
 * engagement while Firefox may prompt: neither is something to spring on a
 * reader who has not asked for anything yet.
 */
async function requestPersistentStorage(): Promise<void> {
  try {
    const s = navigator.storage;
    if (!s?.persist || !s.persisted) return;
    if (await s.persisted()) return;
    await s.persist();
  } catch {
    /* nothing we can do, and nothing that should stop a download */
  }
}

/**
 * Keep the screen on while a download runs. A phone that locks itself
 * stops the page and the download with it - a web app has no background
 * downloads on iOS - and a gigabyte takes longer than the screen stays on.
 * Taken again whenever the page comes back to the front, because the
 * browser lets go of it whenever the page leaves.
 */
function holdAwake(): () => void {
  type Sentinel = { release: () => Promise<void> };
  const wl =
    typeof navigator !== 'undefined'
      ? (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } })
          .wakeLock
      : undefined;
  if (!wl || typeof document === 'undefined') return () => {};
  let sentinel: Sentinel | null = null;
  let stopped = false;
  const take = () => {
    if (stopped || document.visibilityState !== 'visible') return;
    wl.request('screen').then(
      (s) => {
        if (stopped) void s.release().catch(() => {});
        else sentinel = s;
      },
      () => {},
    );
  };
  document.addEventListener('visibilitychange', take);
  take();
  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', take);
    void sentinel?.release().catch(() => {});
  };
}

/** What a failure is called where a reader will see it. */
function errorCodeOf(err: unknown): DownloadErrorCode | undefined {
  if (isQuotaError(err)) return 'out-of-space';
  if (err instanceof DownloadError) return err.code;
  const status = (err as { name?: string; status?: number }).status;
  if ((err as { name?: string }).name === 'ApiError' && typeof status === 'number') {
    if (status === 0) return 'network';
    if (status === 401) return 'unauthorized';
    if (status >= 500 || status === 408 || status === 429) return 'server';
    return 'http';
  }
  return err instanceof Error ? 'network' : undefined;
}

type Manifest = { urls: OfflineManifestEntry[]; totalBytes: number };
type Preparing = { status: 'preparing'; done: number; total: number };

/**
 * Save a book for reading or listening offline.
 *
 * One download per book: a second call while one runs follows it rather
 * than starting another beside it - a big audiobook shows nothing for a
 * while as the server prepares it, and a second tap used to start a second
 * loop that fought the first over the same record.
 *
 * The record is written from the first moment, `preparing`, so every
 * surface can show the download at once, and any failure leaves an `error`
 * the reader can try again from.
 */
export async function startDownload(
  bookId: string,
  onUpdate: (s: DownloadState) => void,
  opts: { title?: string } = {},
): Promise<void> {
  if (!('caches' in window)) {
    throw new DownloadError('no-cache-storage', 'Cache Storage is not available in this browser.');
  }
  const running = activeDownloads.get(bookId);
  if (running) {
    const off = subscribeDownloads((id, s) => {
      if (id === bookId && s) onUpdate(s);
    });
    try {
      await running;
    } finally {
      off();
    }
    return;
  }
  void requestPersistentStorage();
  // Register the controller and in-flight marker BEFORE the first await: a
  // purge that begins while the manifest request is still pending must see
  // this attempt, abort it, and wait for it to settle - otherwise the
  // resolved manifest would repopulate caches after logout.
  const generation = purgeGeneration;
  const controller = new AbortController();
  controllers.set(bookId, controller);
  let release: () => void = () => {};
  activeDownloads.set(
    bookId,
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const invalidated = () => generation !== purgeGeneration;
  const letSleep = holdAwake();
  try {
    const locks = lockManager();
    const body = () => runDownload(bookId, controller, invalidated, onUpdate, opts.title);
    if (!locks) await body();
    else
      await locks.request(lockName(bookId), { ifAvailable: true }, async (lock) => {
        // Another tab is downloading this book already; it carries on, and
        // this one hears about it through the channel.
        if (lock) await body();
      });
  } finally {
    letSleep();
    if (controllers.get(bookId) === controller) controllers.delete(bookId);
    activeDownloads.delete(bookId);
    release();
  }
}

async function runDownload(
  bookId: string,
  controller: AbortController,
  invalidated: () => boolean,
  onUpdate: (s: DownloadState) => void,
  title: string | undefined,
): Promise<void> {
  const signal = controller.signal;
  // Read before anything is written: what an earlier attempt stored is
  // credited against the quota below, and its URLs stay removable.
  const resumed = (await idbGet<DownloadState>(STORES.downloads, bookId)) ?? null;
  const state: DownloadState = {
    bookId,
    title: title ?? resumed?.title,
    status: 'downloading',
    phase: 'preparing',
    totalUrls: resumed?.totalUrls ?? 0,
    doneUrls: 0,
    estimatedBytes: resumed?.estimatedBytes ?? 0,
    storedBytes: 0,
    updatedAt: new Date().toISOString(),
    urls: resumed?.urls ?? [],
  };
  // Told often, written seldom: the bar moves several times a second, the
  // record is written at most once a second, and on every real step.
  let lastTold = 0;
  let lastWritten = 0;
  const tell = () => {
    if (invalidated()) return;
    lastTold = Date.now();
    const copy = { ...state };
    onUpdate(copy);
    publish(bookId, copy);
  };
  const save = async (force = true) => {
    // A continuation running after a completed purge must not repopulate
    // the download registry the purge just cleared.
    if (invalidated()) return;
    state.updatedAt = new Date().toISOString();
    if (force || Date.now() - lastWritten > 1000) {
      lastWritten = Date.now();
      await idbPut(STORES.downloads, bookId, { ...state });
    }
    tell();
  };
  const moved = () => {
    if (Date.now() - lastTold > 200) void save(false);
  };
  const phase = (p: DownloadState['phase']) => {
    if (state.phase === p) return;
    state.phase = p;
    void save(false);
  };
  const hooks = (attempt: DownloadState['phase']): RetryHooks => ({
    onAttempt: () => phase(attempt),
    onWait: () => phase('waiting'),
    onRetry: () => phase('retrying'),
  });

  if (signal.aborted || invalidated()) return;
  await save();

  let manifest: Manifest;
  try {
    manifest = await withRetry(
      signal,
      async () => {
        // An audiobook is prepared by the server first (see the manifest
        // route): asked again until it is ready, saying how far along it is.
        for (;;) {
          const m = await raceAbort(
            api<Manifest | Preparing>(`/api/books/${bookId}/offline-manifest`, {
              signal,
              headers: { [DIRECT_HEADER]: '1' },
            }),
            signal,
          );
          if (!('status' in m && m.status === 'preparing')) return m as Manifest;
          state.prepared = { done: m.done, total: m.total };
          state.phase = 'preparing';
          void save(false);
          await sleep(downloadTiming.preparePollMs, signal);
        }
      },
      hooks('preparing'),
    );
  } catch (err) {
    // Aborted (logout or cancel) before anything was stored: settle
    // silently and store NOTHING - nothing may outlive the purge.
    if (signal.aborted || invalidated()) {
      if (!invalidated()) {
        state.status = 'cancelled';
        state.phase = undefined;
        await save();
      }
      return;
    }
    state.status = 'error';
    state.phase = undefined;
    state.error = (err as Error).message;
    state.errorCode = errorCodeOf(err);
    await save();
    return;
  }
  if (signal.aborted || invalidated()) return;
  state.totalUrls = manifest.urls.length;
  state.estimatedBytes = manifest.totalBytes;
  state.urls = manifest.urls.map((u) => u.url);
  state.prepared = undefined;
  state.phase = 'saving';
  // Ask before writing, not after: a package that cannot fit fails here
  // with something the reader can act on, instead of a raw quota
  // exception hundreds of megabytes into an audiobook. Bytes an earlier
  // attempt already stored are part of the reported usage, so they are
  // credited back or every resume would look too big to finish.
  const estimate = await storageEstimate();
  const stillNeeded = Math.max(0, manifest.totalBytes - (resumed?.storedBytes ?? 0));
  if (
    estimate &&
    estimate.quota > 0 &&
    estimate.quota - estimate.usage < stillNeeded * QUOTA_HEADROOM
  ) {
    state.status = 'error';
    state.phase = undefined;
    state.errorCode = 'out-of-space';
    await save();
    return;
  }
  // Register the attempt BEFORE the first byte is written. Nothing else
  // records which URLs this package owns, so a tab killed mid-download
  // would otherwise leave chunks on the device that "Remove offline copy"
  // could never find.
  await save();
  const cache = await caches.open(OFFLINE_CACHE);
  try {
    for (const entry of manifest.urls) {
      if (signal.aborted) {
        state.status = 'cancelled';
        state.phase = undefined;
        await save();
        return;
      }
      if (entry.kind === 'track') {
        await downloadTrackChunked(
          cache,
          entry,
          signal,
          async (bytes) => {
            state.storedBytes += bytes;
            state.receivingBytes = 0;
            await save(false);
          },
          {
            ...hooks('saving'),
            onChecking: () => phase('checking'),
            onReceiving: (bytes) => {
              state.receivingBytes = bytes;
              moved();
            },
          },
        );
      } else {
        state.storedBytes += await downloadEntry(cache, entry, signal, hooks('saving'));
      }
      state.doneUrls += 1;
      await save();
    }
    // Atomic completion: 'done' is written only after every entry verified.
    state.status = 'done';
    state.phase = undefined;
    state.receivingBytes = 0;
    await save();
  } catch (err) {
    state.phase = undefined;
    state.receivingBytes = 0;
    if (signal.aborted) {
      state.status = 'cancelled';
    } else {
      state.status = 'error';
      state.error = (err as Error).message;
      state.errorCode = errorCodeOf(err);
    }
    await save();
  }
}

/**
 * Stop a download. One this tab is not running - left behind by a closed
 * app - has nothing to abort, so it is marked stopped here and can be
 * tried again or removed.
 */
export function cancelDownload(bookId: string): void {
  const controller = controllers.get(bookId);
  if (controller) {
    controller.abort();
    return;
  }
  void (async () => {
    const stored = await idbGet<DownloadState>(STORES.downloads, bookId);
    if (!stored || stored.status !== 'downloading') return;
    const stopped: DownloadState = {
      ...stored,
      status: 'cancelled',
      phase: undefined,
      receivingBytes: 0,
      updatedAt: new Date().toISOString(),
    };
    await idbPut(STORES.downloads, bookId, stopped);
    publish(bookId, stopped);
  })();
}

/**
 * Carry on with what the app was downloading when it was closed or put to
 * sleep, one book after another. Called once the session is known, so a
 * download never runs for somebody who has signed out.
 */
export async function resumeInterruptedDownloads(): Promise<void> {
  for (const d of await listDownloads()) {
    if (d.status !== 'error' || d.errorCode !== 'interrupted') continue;
    try {
      await startDownload(d.bookId, () => {}, { title: d.title });
    } catch {
      /* told through its record */
    }
  }
}

export async function removeDownload(bookId: string): Promise<void> {
  const state = (await idbGet<DownloadState>(STORES.downloads, bookId)) ?? null;
  if (state) {
    const cache = await caches.open(OFFLINE_CACHE);
    const paths = await cacheKeyPaths(cache);
    for (const url of state.urls) await deleteEntry(cache, url, paths);
  }
  await idbDelete(STORES.downloads, bookId);
  publish(bookId, null);
}

async function deleteEntry(cache: Cache, url: string, paths?: string[]): Promise<void> {
  await cache.delete(url);
  // Chunked tracks: the meta may be absent after a failed download, so the
  // chunks are enumerated either way.
  await deleteTrackChunks(cache, url, paths);
}

/**
 * Abort every in-flight download and WAIT for its loop to settle, so no
 * writer can repopulate caches or IndexedDB after a purge started.
 */
export async function abortAllDownloads(): Promise<void> {
  for (const c of controllers.values()) c.abort();
  await Promise.allSettled([...activeDownloads.values()]);
}

/**
 * Logout-as-revocation: remove every copy of server CONTENT this browser
 * profile holds - downloaded books (Cache Storage), the download registry
 * and the cached server progress state. Active download controllers are
 * aborted and AWAITED first, so a logout/download race cannot leave freshly
 * written content behind. Called on logout and whenever the session is
 * discovered invalid (any API 401, or the service worker's own revocation
 * check). Documented in docs/security.md.
 *
 * Deliberately NOT touched: the un-synced progress queue. Those are the
 * reader's own unsent writes, not content they are no longer entitled to
 * see, and a session that expires mid-flight would otherwise take a whole
 * offline reading session with it. The queue is owned by the account that
 * recorded it (progress/engine claimProgressQueue) and discarded only on a
 * deliberate logout or when a different account signs in here.
 */
export async function purgeOfflineData(): Promise<void> {
  try {
    await abortAllDownloads();
  } catch {
    /* no active downloads */
  }
  // Every registered writer has settled. Anything still pending beyond
  // this point - a manifest request that survived the abort, or a
  // download started mid-purge - now belongs to a dead generation and
  // refuses to write to Cache Storage or IndexedDB.
  purgeGeneration += 1;
  try {
    if (typeof caches !== 'undefined') await caches.delete(OFFLINE_CACHE);
  } catch {
    /* cache storage unavailable */
  }
  try {
    await idbClear(STORES.downloads);
    await idbClear(STORES.serverState);
  } catch {
    /* indexeddb unavailable */
  }
  publish('*', null);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}
