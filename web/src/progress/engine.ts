import {
  progressEventSchema,
  resolveResume,
  type Locator,
  type ProgressAck,
  type ProgressEvent,
  type ProgressIntent,
  type ProgressState,
} from '@readport/shared';
import { api, ApiError, isOffline } from '../api/client';
import {
  clearProgressStores,
  deletePendingEvent,
  enqueueProgressEvent,
  mergeProgressSnapshot,
  progressStorageDegraded,
  readPendingEvents,
  readProgressSnapshot,
} from './storage';

/**
 * Local-first progress engine.
 *
 * Every checkpoint is written to IndexedDB *before* any network I/O, as an
 * idempotent event (UUID + device/session/seq). A background flusher syncs
 * pending events whenever online; acknowledged events are removed and the
 * server's reconciled state is cached locally. Resume combines the newest
 * acknowledged server state with any newer unacknowledged local events using
 * the same decision function the server uses (shared/reconcile).
 */

/**
 * A v4 UUID, on any origin.
 *
 * `crypto.randomUUID` exists only in a secure context, so on a plain-HTTP LAN
 * address - `http://server.lan:8383`, which is exactly what the self-hosting
 * guide tells people to open - it is undefined. This module is imported by
 * App.tsx, so calling it unguarded threw during module evaluation and the app
 * rendered nothing at all: a white screen with one line in the console, on the
 * documented URL. `crypto.getRandomValues` has no such gate.
 *
 * The shape matters as much as the randomness: progress events are validated
 * with `z.uuid()` on the way in, so anything else here would be rejected by
 * the server rather than merely looking odd.
 */
function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function getDeviceId(): string {
  try {
    let id = localStorage.getItem('rp-device-id');
    if (!id) {
      id = randomUuid();
      localStorage.setItem('rp-device-id', id);
    }
    return id;
  } catch {
    // Private mode, or storage blocked. A per-load id keeps this browser
    // distinguishable from every other one; a shared constant would make two
    // devices look like one and let a stale tab argue with a live one.
    return randomUuid();
  }
}

export const deviceId = getDeviceId();
export const sessionId = randomUuid();
let seq = 0;

/**
 * Queue ownership.
 *
 * The un-synced queue is the reader's own writing, not cached server
 * content: an expired or revoked session must NOT destroy it, or an hour of
 * offline reading dies with the session. It is therefore kept across
 * revocation and delivered once the SAME account signs back in. The account
 * that recorded it is stamped here so a DIFFERENT person signing in on this
 * browser can never inherit - or silently publish - someone else's reading
 * positions.
 *
 * Two things make that stamp more than a hint. Every event carries the
 * owner it was captured for, and the server refuses to file an event under
 * anybody else, whatever cookie delivers it. And the flusher only runs for
 * the account this page has actually confirmed is signed in: a tab left on
 * the login screen used to keep flushing its old owner's backlog, and when a
 * different person signed in from another tab - the cookie being shared by
 * the whole browser - that backlog went out under the new name.
 */
const OWNER_KEY = 'rp-progress-owner';
/** Fallback when storage is unavailable (private mode): at least keep the
 *  owner right for the lifetime of this page. */
let ownerFallback: string | null = null;
/** Set while a foreign account's backlog is being discarded, so the
 *  background flusher cannot deliver it under the new session first. */
let queueSuspended = false;
/**
 * The account this page has confirmed is signed in, or null between sign-out
 * and the next sign-in. Nothing is sent, and nothing is queued, while null:
 * a surface unmounting on the way to the login screen has nobody to write
 * for, and its farewell checkpoint used to land in the emptied queue for the
 * next person to adopt.
 */
let sessionUserId: string | null = null;

function readOwner(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return ownerFallback;
  }
}

function writeOwner(id: string | null): void {
  ownerFallback = id;
  try {
    if (id === null) localStorage.removeItem(OWNER_KEY);
    else localStorage.setItem(OWNER_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

/** Whether this page may currently write and deliver checkpoints, and for whom. */
function deliveringFor(): string | null {
  if (queueSuspended || sessionUserId === null) return null;
  const owner = readOwner();
  return owner === null || owner === sessionUserId ? sessionUserId : null;
}

/** Discard the un-synced queue. Deliberate logout and a change of account
 *  only - never session revocation. Seals the queue until the next claim. */
export async function purgeProgressQueue(): Promise<void> {
  sessionUserId = null;
  writeOwner(null);
  writeStash([]);
  knownRevision.clear();
  activeGenerations.clear();
  try {
    await clearProgressStores();
  } catch {
    /* indexeddb unavailable */
  }
}

/**
 * The session ended without a sign-out - revoked, expired - or the page is
 * back on the login screen for any other reason. The queue is kept for its
 * owner; delivery stops until somebody has signed in again.
 */
export function releaseProgressSession(): void {
  sessionUserId = null;
}

/**
 * Hand the queue to the signed-in account. The same person returning - after
 * a logout-less session expiry, a re-login, or a week offline - keeps every
 * queued checkpoint; anybody else starts empty.
 */
export async function claimProgressQueue(userId: string): Promise<void> {
  const previous = readOwner();
  if (previous !== userId && previous !== null) {
    queueSuspended = true;
    try {
      await purgeProgressQueue();
    } finally {
      queueSuspended = false;
    }
  }
  writeOwner(userId);
  sessionUserId = userId;
  failures = 0;
}

type Listener = () => void;
const listeners = new Set<Listener>();
export function onProgressSync(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Something a surface should tell the reader about, because the engine has
 * silently stopped doing what they expect of it.
 *
 * `reset-elsewhere`: the book's progress was reset from another device or
 * tab, and every checkpoint this surface makes is being refused until it
 * explicitly starts again under the new generation. `storage-degraded`:
 * IndexedDB is unavailable, so checkpoints live only in memory for this page.
 */
export type ProgressNotice =
  { type: 'reset-elsewhere'; bookId: string } | { type: 'storage-degraded'; bookId: string };
type NoticeListener = (notice: ProgressNotice) => void;
const noticeListeners = new Set<NoticeListener>();
const noticedResets = new Set<string>();
let noticedDegraded = false;
export function onProgressNotice(fn: NoticeListener): () => void {
  noticeListeners.add(fn);
  return () => noticeListeners.delete(fn);
}
function notify(notice: ProgressNotice): void {
  noticeListeners.forEach((fn) => fn(notice));
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

/** Last server revision seen per book, mirrored in memory so an event can be
 *  built synchronously (pagehide gives us no time for an IndexedDB read). */
const knownRevision = new Map<string, number>();
// Bound at open/resume, NEVER advanced by an ack arriving at an old live surface.
const activeGenerations = new Map<string, number>();
const resetting = new Set<string>();

/** Never optimistically erase progress: offline reset fails without hiding anything. */
export async function resetBookProgress(bookId: string): Promise<void> {
  resetting.add(bookId);
  try {
    const result = await api<{ generation: number }>(
      `/api/progress/${encodeURIComponent(bookId)}`,
      { method: 'DELETE' },
    );
    if (!Number.isSafeInteger(result.generation) || result.generation < 1)
      throw new Error('Reset was not confirmed by this server');
    await mergeProgressSnapshot(bookId, result.generation, null);
    writeStash(
      readStash().filter(
        (event) => event.bookId !== bookId || (event.generation ?? 0) >= result.generation,
      ),
    );
    knownRevision.delete(bookId);
    listeners.forEach((listener) => listener());
  } finally {
    resetting.delete(bookId);
  }
}

/** Locators are validated server-side; keep them in range at the source so a
 *  slightly-over-duration audio position can never poison the queue. */
function sanitizeLocator(locator: Locator): Locator {
  const pct = Math.min(1, Math.max(0, Number.isFinite(locator.pct) ? locator.pct : 0));
  if (locator.medium === 'audio') {
    return {
      ...locator,
      pct,
      positionMs: Math.max(0, Math.round(locator.positionMs || 0)),
      bookMs: locator.bookMs === undefined ? undefined : Math.max(0, Math.round(locator.bookMs)),
    };
  }
  return {
    ...locator,
    pct,
    charOffset:
      locator.charOffset === undefined ? undefined : Math.max(0, Math.round(locator.charOffset)),
  };
}

function buildEvent(
  bookId: string,
  intent: ProgressIntent,
  locator: Locator,
  ownerId: string,
): ProgressEvent {
  seq += 1;
  return {
    eventId: randomUuid(),
    bookId,
    deviceId,
    sessionId,
    seq,
    occurredAt: new Date().toISOString(),
    // Declare which server revision this action was based on (causal ordering
    // beats clock ordering during reconciliation; clocks are just a hint).
    baseRevision: knownRevision.get(bookId),
    generation: activeGenerations.get(bookId) ?? 0,
    ownerId,
    intent,
    locator: sanitizeLocator(locator),
  };
}

/**
 * Record a checkpoint. Resolves to whether it was accepted into the queue:
 * false when nobody is signed in to write for, or when the book's progress
 * was reset elsewhere and this surface is still on the old generation - in
 * which case the surface has been told, once, through `onProgressNotice`.
 */
export async function recordCheckpoint(
  bookId: string,
  intent: ProgressIntent,
  locator: Locator,
  opts: { flush?: boolean } = {},
): Promise<boolean> {
  const owner = deliveringFor();
  if (owner === null) return false;
  // Capture intent, generation and locator before asynchronous storage reads.
  const event = buildEvent(bookId, intent, locator, owner);
  if (!knownRevision.has(bookId)) {
    try {
      const known = await readProgressSnapshot(bookId);
      if (known.state && known.generation === event.generation) {
        knownRevision.set(bookId, known.state.revision);
        event.baseRevision = known.state.revision;
      }
    } catch {
      /* no cached state */
    }
  }
  // IndexedDB first - never lose a checkpoint to a dropped connection.
  const accepted = await enqueueProgressEvent(event);
  if (!accepted) {
    if (!noticedResets.has(bookId)) {
      noticedResets.add(bookId);
      notify({ type: 'reset-elsewhere', bookId });
    }
    return false;
  }
  if (progressStorageDegraded()) {
    // Memory is the only tier: mirror the newest checkpoints into the stash
    // so a reload still has somewhere to resume from.
    stashEvent(event);
    if (!noticedDegraded) {
      noticedDegraded = true;
      notify({ type: 'storage-degraded', bookId });
    }
  }
  if (opts.flush !== false) scheduleFlush(intent !== 'heartbeat');
  return true;
}

/**
 * The active reader/player surface registers a provider returning its CURRENT
 * position, so lifecycle events can persist the live locator - not just
 * whatever already made it past the debounce/heartbeat windows.
 */
export type ActiveLocatorProvider = () => { bookId: string; locator: Locator } | null;
let activeLocatorProvider: ActiveLocatorProvider | null = null;

export function setActiveLocatorProvider(fn: ActiveLocatorProvider): () => void {
  activeLocatorProvider = fn;
  return () => {
    if (activeLocatorProvider === fn) activeLocatorProvider = null;
  };
}

/**
 * Last-gasp stash.
 *
 * pagehide can be followed by freeze or termination before an IndexedDB
 * transaction commits, and the keepalive request cannot help when there is
 * no network - exactly the case offline reading depends on. localStorage
 * writes synchronously, so the live position survives even a page that never
 * runs again; the next start puts it back in the queue. Events are
 * idempotent (eventId), so a stash that turns out to have been stored or
 * delivered already costs nothing.
 */
const STASH_KEY = 'rp-progress-stash';
const STASH_MAX = 20;

function readStash(): ProgressEvent[] {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is ProgressEvent => progressEventSchema.safeParse(e).success);
  } catch {
    return [];
  }
}

function writeStash(events: ProgressEvent[]): void {
  try {
    if (events.length === 0) localStorage.removeItem(STASH_KEY);
    else localStorage.setItem(STASH_KEY, JSON.stringify(events.slice(-STASH_MAX)));
  } catch {
    /* storage unavailable or full; IndexedDB remains the primary queue */
  }
}

function stashEvent(event: ProgressEvent): void {
  writeStash([...readStash().filter((e) => e.eventId !== event.eventId), event]);
}

function unstashEvent(eventId: string): void {
  const rest = readStash().filter((e) => e.eventId !== eventId);
  writeStash(rest);
}

/** Put anything the last page load could not commit back in the queue. */
export async function drainLastGasp(): Promise<number> {
  const stashed = readStash();
  if (stashed.length === 0) return 0;
  let restored = 0;
  for (const event of stashed) {
    try {
      if (await enqueueProgressEvent(event)) restored += 1;
    } catch {
      return restored; // storage is down; keep the stash for the next start
    }
  }
  // With no durable tier the stash IS the durable tier: leave it alone.
  if (!progressStorageDegraded()) writeStash([]);
  return restored;
}

/**
 * The envelope every delivery travels in: who it is for, and what time this
 * device thinks it is, so the server can correct a slow or fast clock rather
 * than judge every offline move by it.
 */
function envelope(events: ProgressEvent[], ownerId: string) {
  return { events, ownerId, clientNow: new Date().toISOString() };
}

/**
 * The unload path fires twice on most browsers - `visibilitychange` to
 * hidden, then `pagehide` - within the same few milliseconds. Each used to
 * build a fresh event and start a fresh keepalive batch, so the browser's
 * 64 KiB per-origin keepalive budget was shared by two singles and two
 * batches, and the second batch was refused by fetch before it left. One
 * capture, one batch, and the second call finds nothing new to do.
 */
const UNLOAD_DEDUPE_MS = 1500;
let lastUnload: { at: number; key: string } | null = null;
let unloadFlushInFlight = false;

/**
 * visibilitychange/pagehide path. The page may be frozen or killed within
 * milliseconds, so the live position is stashed SYNCHRONOUSLY, sent
 * IMMEDIATELY with a keepalive request (no IndexedDB round-trip first) and
 * written to IndexedDB in parallel; the queued copy is removed only once the
 * server acknowledges it. Everything already queued is flushed the same way.
 */
export function persistActiveLocatorAndFlush(): void {
  const owner = deliveringFor();
  if (owner === null) return;
  const current = activeLocatorProvider?.();
  const now = Date.now();
  if (current && !resetting.has(current.bookId)) {
    const key = `${current.bookId}:${JSON.stringify(sanitizeLocator(current.locator))}`;
    const repeat = lastUnload && now - lastUnload.at < UNLOAD_DEDUPE_MS && lastUnload.key === key;
    if (!repeat) {
      lastUnload = { at: now, key };
      const event = buildEvent(current.bookId, 'heartbeat', current.locator, owner);
      stashEvent(event);
      const stored = enqueueProgressEvent(event)
        .then((accepted) => {
          if (accepted && !progressStorageDegraded()) unstashEvent(event.eventId);
        })
        .catch(() => {});
      void api<ProgressAck>('/api/progress/events', {
        method: 'POST',
        body: envelope([event], owner),
        keepalive: true,
      })
        .then(async (ack) => {
          await stored;
          await handleAck(ack, [event]);
        })
        .catch(() => {
          /* stays queued in IndexedDB; the next flush retries */
        });
    }
  }
  if (unloadFlushInFlight) return;
  unloadFlushInFlight = true;
  void flushPending(true, /* bypassInFlightGuard */ true).finally(() => {
    unloadFlushInFlight = false;
  });
}

/** Re-claims issued after a lost claim, per book, so a second live surface
 *  elsewhere cannot make this one write on every ack. */
const lastReclaim = new Map<string, number>();
const RECLAIM_MIN_INTERVAL_MS = 10_000;

async function handleAck(ack: ProgressAck, sent: ProgressEvent[]): Promise<void> {
  for (const r of ack.results) {
    // applied / recorded / duplicate are all durable server outcomes; a
    // rejected event is malformed or misfiled and would be rejected forever.
    await deletePendingEvent(r.eventId);
  }
  // Every book the batch touched, not just the last: falling back to `state`
  // keeps this working against a server that predates `states`.
  const states = ack.states?.length ? ack.states : ack.state ? [ack.state] : [];
  for (const { bookId, generation } of ack.generations ?? []) {
    await mergeProgressSnapshot(
      bookId,
      generation,
      states.find((state) => state.bookId === bookId) ?? null,
    );
    // The reset happened elsewhere and this surface is still writing under
    // the generation it opened with: from here on every checkpoint it makes
    // is refused, so say so once, rather than let an hour of reading vanish
    // without a word.
    const active = activeGenerations.get(bookId);
    if (active !== undefined && generation > active && !noticedResets.has(bookId)) {
      noticedResets.add(bookId);
      notify({ type: 'reset-elsewhere', bookId });
    }
  }
  for (const state of states) {
    await mergeProgressSnapshot(state.bookId, state.generation ?? 0, state);
    if ((activeGenerations.get(state.bookId) ?? 0) === (state.generation ?? 0))
      knownRevision.set(state.bookId, state.revision);
  }
  listeners.forEach((l) => l());

  // Another session took the claim - a phone opened the book to look at it
  // - and the heartbeats this visible surface has been sending since are
  // being recorded but never applied. A reader who kept turning pages for an
  // hour would then resume at the phone's position. A visible surface is not
  // a stale tab: it states its position once as an explicit move, based on
  // the revision it has just been told about, and holds the claim again.
  const unclaimed = new Set<string>();
  for (const r of ack.results) {
    if (r.status !== 'recorded' || r.reason !== 'unclaimed-session') continue;
    const ev = sent.find((e) => e.eventId === r.eventId);
    if (ev && ev.sessionId === sessionId && !isExplicitIntent(ev.intent)) unclaimed.add(ev.bookId);
  }
  if (unclaimed.size === 0) return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  const current = activeLocatorProvider?.();
  if (!current || !unclaimed.has(current.bookId)) return;
  const at = Date.now();
  if (at - (lastReclaim.get(current.bookId) ?? 0) < RECLAIM_MIN_INTERVAL_MS) return;
  lastReclaim.set(current.bookId, at);
  void recordCheckpoint(current.bookId, 'seek', current.locator);
}

function isExplicitIntent(intent: ProgressIntent): boolean {
  return intent !== 'heartbeat';
}

/**
 * A batch the server refuses outright (4xx) would block every later event
 * for every book, forever. Drop only the events that fail the shared schema
 * locally; if all validate the failure is transient and they stay queued.
 */
async function quarantineInvalid(events: ProgressEvent[]): Promise<number> {
  let dropped = 0;
  for (const ev of events) {
    if (!progressEventSchema.safeParse(ev).success) {
      await deletePendingEvent(ev.eventId);
      dropped += 1;
    }
  }
  return dropped;
}

/**
 * Fetch caps in-flight keepalive bodies at 64 KiB per origin - a budget this
 * batch shares with the single-event request the pagehide path just issued.
 * Over quota the fetch rejects, which reads as "offline" and delivers
 * nothing, precisely when the backlog is largest. Trim to a batch that fits;
 * whatever is left over stays queued for the next flush.
 */
const KEEPALIVE_BUDGET_BYTES = 48 * 1024;

export function withinKeepaliveBudget(events: ProgressEvent[]): ProgressEvent[] {
  let bytes = '{"events":[]}'.length;
  let n = 0;
  for (const ev of events) {
    bytes += JSON.stringify(ev).length + 1;
    if (bytes > KEEPALIVE_BUDGET_BYTES) break;
    n += 1;
  }
  return n === events.length ? events : events.slice(0, Math.max(1, n));
}

/**
 * Retry pacing. A server that answers 500 every 30 seconds used to be asked
 * again every 30 seconds, and on every checkpoint in between; a batch it
 * finds too large was resent at the same size forever. Failures back off
 * exponentially to five minutes, and a 413 halves the batch until it goes
 * through, doubling back up once it does.
 */
const BATCH_MAX = 200;
let batchCap = BATCH_MAX;
let failures = 0;
let nextFlushAllowedAt = 0;

/** How long to wait after the n-th consecutive failure. */
export function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(5 * 60_000, 5000 * 2 ** (consecutiveFailures - 1));
}

export function scheduleFlush(soon = false): void {
  if (flushTimer) clearTimeout(flushTimer);
  const wanted = soon ? 250 : 5000;
  const delay = Math.max(wanted, nextFlushAllowedAt - Date.now());
  flushTimer = setTimeout(() => void flushPending(), delay);
}

export async function flushPending(
  useKeepalive = false,
  bypassInFlightGuard = false,
): Promise<void> {
  if (flushing && !bypassInFlightGuard) return;
  const owner = deliveringFor();
  if (owner === null) return;
  if (!useKeepalive && Date.now() < nextFlushAllowedAt) return;
  const ownsGuard = !flushing;
  flushing = true;
  let events: ProgressEvent[] = [];
  try {
    const pending = await readPendingEvents();
    if (pending.length === 0) return;
    if (deliveringFor() !== owner) return; // a different account signed in mid-read
    // Anything stamped for somebody else is not ours to deliver, and never
    // will be: it is dropped here rather than sent to be refused.
    const foreign = pending.filter((e) => e.ownerId !== undefined && e.ownerId !== owner);
    for (const e of foreign) await deletePendingEvent(e.eventId);
    events = pending
      .filter((e) => e.ownerId === undefined || e.ownerId === owner)
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.seq - b.seq)
      .slice(0, batchCap);
    if (events.length === 0) return;
    if (useKeepalive) events = withinKeepaliveBudget(events);
    const ack = await api<ProgressAck>('/api/progress/events', {
      method: 'POST',
      body: envelope(events, owner),
      keepalive: useKeepalive,
    });
    failures = 0;
    nextFlushAllowedAt = 0;
    batchCap = Math.min(BATCH_MAX, batchCap * 2);
    await handleAck(ack, events);
    // A full batch means there is more behind it. Without re-arming, a
    // backlog built up over a week offline drained 200 events per flush
    // interval - so signing out sent the oldest positions and abandoned the
    // newest, which is the wrong way round in the only case that matters.
    if (events.length === batchCap) scheduleFlush(true);
  } catch (err) {
    if (isOffline(err)) return; // events stay queued; the next flush retries
    console.warn('progress flush failed', err);
    if (err instanceof ApiError && err.status === 413) {
      batchCap = Math.max(1, Math.floor(batchCap / 2));
    } else if (
      err instanceof ApiError &&
      err.status >= 400 &&
      err.status < 500 &&
      err.status !== 401
    ) {
      const dropped = await quarantineInvalid(events);
      if (dropped > 0) console.warn(`dropped ${dropped} malformed progress event(s)`);
    }
    if (!(err instanceof ApiError && err.status === 401)) {
      failures += 1;
      nextFlushAllowedAt = Date.now() + backoffMs(failures);
    }
  } finally {
    if (ownsGuard) flushing = false;
  }
}

/** Resume position: newest acked server state + newer local pending events. */
export async function resumeLocator(
  bookId: string,
  opts: { activate?: boolean } = {},
): Promise<{ locator: Locator; source: 'server' | 'local' } | null> {
  let served: { state: ProgressState | null; generation: number } | null = null;
  try {
    const res = await api<{ state: ProgressState | null; generation?: number }>(
      `/api/progress/${bookId}`,
    );
    served = { state: res.state ?? null, generation: res.generation ?? res.state?.generation ?? 0 };
    await mergeProgressSnapshot(bookId, served.generation, served.state);
  } catch {
    // Offline uses the durable snapshot, including its reset generation.
  }
  // A position stashed as the app was killed must be part of THIS resume,
  // not only of the next background flush.
  await drainLastGasp();
  // Storage that will not answer must not keep a book shut: the server's
  // answer is a resume position on its own.
  let snapshot: { generation: number; state: ProgressState | null };
  try {
    snapshot = await readProgressSnapshot(bookId);
  } catch {
    snapshot = served ?? { generation: 0, state: null };
  }
  if (opts.activate !== false) {
    activeGenerations.set(bookId, snapshot.generation);
    noticedResets.delete(bookId);
    if (snapshot.state) knownRevision.set(bookId, snapshot.state.revision);
    else knownRevision.delete(bookId);
  }
  let pending: ProgressEvent[] = [];
  try {
    pending = (await readPendingEvents()).filter(
      (e) => e.bookId === bookId && (e.generation ?? 0) === snapshot.generation,
    );
  } catch {
    /* nothing queued that can be read */
  }
  return resolveResume(snapshot.state, pending);
}

export function startProgressLifecycle(): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') persistActiveLocatorAndFlush();
  };
  const onPageHide = () => persistActiveLocatorAndFlush();
  const onOnline = () => {
    failures = 0;
    nextFlushAllowedAt = 0;
    scheduleFlush(true);
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);
  const interval = setInterval(() => void flushPending(), 30_000);
  void drainLastGasp().then(() => flushPending());
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('online', onOnline);
    clearInterval(interval);
  };
}
