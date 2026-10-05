import { type Annotation } from '@readport/shared';
import { api, ApiError, isOffline } from '../api/client';
import { backoffMs, queueAccount } from '../progress/engine';
import { openIdb, STORES } from '../progress/idb';

/**
 * Marks made, changed and removed on this device, on their way to the server.
 *
 * A highlight used to be a request and nothing more. With no connection
 * there was no highlight - "could not save" - and on a connection that
 * stalls rather than fails, a tap on Remove seemed to do nothing until one
 * of several got through. Every change to a mark now shows at once and is
 * written to this device's own storage before anything is sent. It reaches
 * the server in the order it was made, whenever the server can be reached:
 * straight away, when the connection comes back, or the next time the app is
 * opened - after the browser was closed, however long after.
 *
 * Any change can arrive twice without harm, which is what makes sending it
 * again safe: a new mark carries the name it was given here, and a second
 * delivery finds the mark the first one made; a colour or a note is set, not
 * added; and removing a mark that is gone is done.
 *
 * Changes belong to the account that made them, by the progress queue's
 * rules (progress/engine.ts): delivered only while that account is the one
 * signed in, and discarded when someone else signs in on this browser, or
 * when its owner signs out.
 */

/** What can change about a mark once it is made. */
export interface MarkPatch {
  color?: string;
  note?: string;
}

export type MarkChange =
  | { type: 'create'; mark: Annotation }
  | { type: 'patch'; id: string; bookId: string; patch: MarkPatch }
  | { type: 'delete'; id: string; bookId: string };

export interface QueuedMarkChange {
  changeId: string;
  /** The account that made it. */
  ownerId: string;
  /** When, by this device's clock: how old a mark is by the time it arrives. */
  at: number;
  /** Its place in the queue: the order the changes were made in, in any tab. */
  order: number;
  change: MarkChange;
}

/* ------------------------------------------------------------------ names */

function randomName(bytes: number): string {
  // getRandomValues, not randomUUID: the second exists only on HTTPS, and
  // the self-hosting guide opens the app on a plain-HTTP LAN address.
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A name for a mark made here, of the shape the server gives its own. */
export function newMarkId(): string {
  return `ann_${randomName(16)}`;
}

/* ---------------------------------------------------------------- storage */

/**
 * Where changes wait when IndexedDB will not open - a private window in an
 * older browser, site data blocked. They are delivered from here while the
 * page lasts, which is less than a promise to outlive it, but still more
 * than refusing to make the mark.
 */
const memory = new Map<string, QueuedMarkChange>();
/** The furthest place in the queue this page has seen, in either tier. */
let lastOrder = 0;

async function db(): Promise<IDBDatabase | null> {
  try {
    return await openIdb();
  } catch {
    return null;
  }
}

function byOrder(a: QueuedMarkChange, b: QueuedMarkChange): number {
  return a.order - b.order || a.at - b.at || (a.changeId < b.changeId ? -1 : 1);
}

function keepInMemory(entry: Omit<QueuedMarkChange, 'order'>): void {
  const queued = { ...entry, order: ++lastOrder };
  memory.set(queued.changeId, queued);
}

/**
 * Put a change at the end of the queue: after every change already in it,
 * whichever tab made those. Its place is taken in the same transaction that
 * stores it, so two tabs cannot take the same one.
 */
async function append(entry: Omit<QueuedMarkChange, 'order'>): Promise<void> {
  const database = await db();
  if (!database) {
    keepInMemory(entry);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORES.markChanges, 'readwrite');
    const store = tx.objectStore(STORES.markChanges);
    const all = store.getAll();
    all.onsuccess = () => {
      for (const c of all.result as QueuedMarkChange[]) lastOrder = Math.max(lastOrder, c.order);
      const queued = { ...entry, order: ++lastOrder };
      store.put(queued, queued.changeId);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Mark change not stored'));
  });
}

async function readQueue(): Promise<QueuedMarkChange[]> {
  let stored: QueuedMarkChange[] = [];
  const database = await db();
  if (database) {
    try {
      stored = await new Promise((resolve, reject) => {
        const tx = database.transaction(STORES.markChanges, 'readonly');
        const req = tx.objectStore(STORES.markChanges).getAll();
        tx.oncomplete = () => resolve(req.result as QueuedMarkChange[]);
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Mark changes unreadable'));
      });
    } catch {
      /* unreadable for now: what memory holds is still this page's */
    }
  }
  for (const c of stored) lastOrder = Math.max(lastOrder, c.order);
  return [...stored, ...memory.values()].sort(byOrder);
}

async function remove(changeIds: string[]): Promise<void> {
  for (const id of changeIds) memory.delete(id);
  const database = await db();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORES.markChanges, 'readwrite');
    const store = tx.objectStore(STORES.markChanges);
    for (const id of changeIds) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Mark changes not removed'));
  });
}

/** Whatever is still queued for a mark the server named differently follows it to its name. */
async function renameQueued(from: string, to: string): Promise<void> {
  const renamed = (c: QueuedMarkChange): QueuedMarkChange | null => {
    const ch = c.change;
    if (ch.type === 'create') {
      return ch.mark.id === from ? { ...c, change: { ...ch, mark: { ...ch.mark, id: to } } } : null;
    }
    return ch.id === from ? { ...c, change: { ...ch, id: to } } : null;
  };
  for (const [key, c] of memory) {
    const r = renamed(c);
    if (r) memory.set(key, r);
  }
  const database = await db();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORES.markChanges, 'readwrite');
    const store = tx.objectStore(STORES.markChanges);
    const all = store.getAll();
    all.onsuccess = () => {
      for (const c of all.result as QueuedMarkChange[]) {
        const r = renamed(c);
        if (r) store.put(r, r.changeId);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Mark changes not renamed'));
  });
}

/** Everything queued, gone: signing out leaves nothing of the account behind. */
export async function purgeMarkChanges(): Promise<void> {
  memory.clear();
  const database = await db();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORES.markChanges, 'readwrite');
    tx.objectStore(STORES.markChanges).clear();
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Mark changes not cleared'));
  });
}

/**
 * Hand the queue to the account signed in: the same person keeps every
 * change, delivered from here; anybody else on this browser never sees, or
 * sends, someone else's marks.
 */
export async function claimMarkChanges(userId: string): Promise<void> {
  const foreign = (await readQueue()).filter((c) => c.ownerId !== userId);
  if (foreign.length > 0) await remove(foreign.map((c) => c.changeId));
}

/** The changes still on their way for the account signed in, oldest first. */
export async function pendingMarkChanges(): Promise<QueuedMarkChange[]> {
  const owner = queueAccount();
  if (owner === null) return [];
  try {
    return (await readQueue()).filter((c) => c.ownerId === owner);
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------- recording */

type RenameListener = (from: string, to: string) => void;
const renameListeners = new Set<RenameListener>();

/**
 * Told when the server kept a mark made here under another name than the
 * one it was given - a name already taken - so a page showing it can follow.
 */
export function onMarkRenamed(fn: RenameListener): () => void {
  renameListeners.add(fn);
  return () => renameListeners.delete(fn);
}

/**
 * Make a change to a mark: kept on this device, then sent from there. False
 * only when it could not be kept at all - nobody is signed in to keep it
 * for - and the page should say it was not saved.
 */
export async function recordMarkChange(change: MarkChange): Promise<boolean> {
  const ownerId = queueAccount();
  if (ownerId === null) return false;
  const entry = { changeId: randomName(12), ownerId, at: Date.now(), change };
  try {
    await append(entry);
  } catch {
    // Storage that opened and then refused - full, or gone mid-write: the
    // change still goes, from this page.
    keepInMemory(entry);
  }
  scheduleMarkDelivery();
  return true;
}

/* --------------------------------------------------------------- delivery */

/** A request that has not been answered in this long is a connection that stalled. */
const DELIVERY_TIMEOUT_MS = 20_000;
/** Answers that say the change will never be taken: sending it again would only hold up the rest. */
const REFUSED = new Set([400, 404, 410, 413, 422]);

let delivering: Promise<void> | null = null;
let again = false;
let failures = 0;
let notBefore = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const timeoutSignal = (): AbortSignal | undefined =>
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
    : undefined;

/** Deliver soon - after a server that failed has had its rest. */
export function scheduleMarkDelivery(delayMs = 0): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(
    () => {
      timer = null;
      void deliverMarkChanges();
    },
    Math.max(delayMs, notBefore - Date.now()),
  );
}

/**
 * Send what is queued, oldest first, until nothing is left or the server
 * cannot be reached. One delivery at a time: in this tab, and - where the
 * browser can say so - across tabs, which share the queue, so one account's
 * changes are never sent out of order.
 */
export function deliverMarkChanges(): Promise<void> {
  if (delivering) {
    again = true;
    return delivering;
  }
  delivering = (async () => {
    try {
      do {
        again = false;
        await oneAtATime(deliverQueued);
      } while (again);
    } catch {
      /* storage gave out mid-delivery: what is left goes next time */
    } finally {
      delivering = null;
    }
  })();
  return delivering;
}

async function oneAtATime(deliver: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return deliver();
  await locks.request('rp-mark-changes', { ifAvailable: true }, async (lock) => {
    // Another tab is delivering, from the same queue; whatever it misses of
    // this tab's changes goes on the next try.
    if (!lock) {
      scheduleMarkDelivery(5000);
      return;
    }
    await deliver();
  });
}

function bookOf(change: MarkChange): string {
  return change.type === 'create' ? change.mark.bookId : change.bookId;
}

async function deliverQueued(): Promise<void> {
  const owner = queueAccount();
  if (owner === null || Date.now() < notBefore) return;
  const delivered = new Set<string>();
  try {
    // Read afresh for every change: a rename rewrites what follows, and a
    // change made meanwhile joins the end.
    for (let n = 0; ; n++) {
      if (queueAccount() !== owner) return; // signed out, or someone else signed in
      const next = (await readQueue()).find((c) => c.ownerId === owner);
      if (!next) break;
      // A backlog this long is let go of now and then, and picked up again.
      if (n === 500) {
        scheduleMarkDelivery(1000);
        break;
      }
      if (!(await deliverOne(next))) return;
      delivered.add(bookOf(next.change));
    }
    failures = 0;
    notBefore = 0;
  } finally {
    // A downloaded book keeps a copy of its marks to open with offline, and
    // that copy is renewed when the list is fetched online: fetched now, it
    // has the marks that just left the queue, rather than lose them from
    // view the next time the book is opened without a connection.
    for (const bookId of delivered) void api(`/api/books/${bookId}/annotations`).catch(() => {});
  }
}

/** True when the change has left the queue; false to stop, keeping it, and try again later. */
async function deliverOne(c: QueuedMarkChange): Promise<boolean> {
  let renamed: { from: string; to: string } | null = null;
  try {
    renamed = await send(c);
  } catch (err) {
    const refused = err instanceof ApiError && REFUSED.has(err.status);
    if (!refused) {
      // No connection, a connection that stalled, the session gone (signing
      // back in delivers it), or a server or proxy that answered badly: all
      // kept. Only a bad answer earns a pause, so a failing server is not
      // asked again every few seconds.
      if (!isOffline(err) && !(err instanceof ApiError && err.status === 401)) {
        failures += 1;
        notBefore = Date.now() + backoffMs(failures);
        scheduleMarkDelivery();
      }
      return false;
    }
    // The book or the mark is gone, or the change is one the server will
    // never take: done with, either way.
    if (!(err instanceof ApiError && err.status === 404)) console.warn('mark change refused', err);
  }
  await remove([c.changeId]);
  if (renamed) {
    const { from, to } = renamed;
    await renameQueued(from, to);
    renameListeners.forEach((fn) => fn(from, to));
  }
  return true;
}

/** Deliver one change - and for a new mark the server named otherwise, both its names. */
async function send(c: QueuedMarkChange): Promise<{ from: string; to: string } | null> {
  const ch = c.change;
  const signal = timeoutSignal();
  if (ch.type === 'create') {
    const { mark } = ch;
    const res = await api<{ annotation: Annotation }>(
      `/api/books/${encodeURIComponent(mark.bookId)}/annotations`,
      {
        method: 'POST',
        body: {
          id: mark.id,
          ageMs: Math.max(0, Date.now() - c.at),
          kind: mark.kind,
          locator: mark.locator,
          endLocator: mark.endLocator,
          color: mark.color,
          selectedText: mark.selectedText,
          note: mark.note,
        },
        signal,
      },
    );
    return res.annotation.id === mark.id ? null : { from: mark.id, to: res.annotation.id };
  }
  const url = `/api/annotations/${encodeURIComponent(ch.id)}`;
  if (ch.type === 'patch') await api(url, { method: 'PATCH', body: ch.patch, signal });
  else await api(url, { method: 'DELETE', signal });
  return null;
}

/* ---------------------------------------------------------------- reading */

/** A mark with a change of colour or note applied: only what the change names. */
export function patchedMark<T extends Annotation>(mark: T, patch: MarkPatch): T {
  return {
    ...mark,
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
  };
}

/**
 * A book's marks as this device knows them: the server's list with every
 * change still on its way applied on top, in the order they were made.
 */
export function withPendingChanges(
  marks: Annotation[],
  queue: QueuedMarkChange[],
  bookId: string,
): Annotation[] {
  let out = marks;
  for (const { change } of queue) {
    if (bookOf(change) !== bookId) continue;
    if (change.type === 'create') {
      if (!out.some((m) => m.id === change.mark.id)) out = [...out, change.mark];
    } else if (change.type === 'patch') {
      out = out.map((m) => (m.id === change.id ? patchedMark(m, change.patch) : m));
    } else {
      out = out.filter((m) => m.id !== change.id);
    }
  }
  return out;
}

/**
 * Marks of every book with the changes on their way applied - all but the
 * new ones, which a list of every book has nothing to show beside (it is
 * fetched after a delivery has had its chance: settleMarkChanges).
 */
export function withPendingEdits<T extends Annotation>(marks: T[], queue: QueuedMarkChange[]): T[] {
  let out = marks;
  for (const { change } of queue) {
    if (change.type === 'patch') {
      out = out.map((m) => (m.id === change.id ? patchedMark(m, change.patch) : m));
    } else if (change.type === 'delete') {
      out = out.filter((m) => m.id !== change.id);
    }
  }
  return out;
}

/**
 * One book's marks: the server's list - or the copy kept with a downloaded
 * book, offline - and on top, the changes made on this device and not yet
 * delivered. The queue is read before the list is fetched and again after,
 * so a change delivered while the list was on its way is in it either way.
 */
export async function loadBookMarks(bookId: string): Promise<Annotation[]> {
  const before = await pendingMarkChanges();
  let served: Annotation[] = [];
  try {
    served = (await api<{ annotations: Annotation[] }>(`/api/books/${bookId}/annotations`))
      .annotations;
  } catch {
    /* no connection, and no copy kept: only the marks made here */
  }
  const after = await pendingMarkChanges();
  const seen = new Set(before.map((c) => c.changeId));
  const queue = [...before, ...after.filter((c) => !seen.has(c.changeId))].sort(byOrder);
  return withPendingChanges(served, queue, bookId);
}

/**
 * Before fetching a list of marks: whatever is queued, delivered first if
 * that can be done quickly, so the list comes back with it.
 */
export async function settleMarkChanges(withinMs = 2500): Promise<void> {
  let wait: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    deliverMarkChanges(),
    new Promise<void>((resolve) => {
      wait = setTimeout(resolve, withinMs);
    }),
  ]);
  clearTimeout(wait);
}

/**
 * Deliver whenever there may be a way through: on start, when the browser
 * says the connection is back, when the app comes back to the front, and
 * every half minute besides - a connection can come back without a word.
 */
export function startMarkDelivery(): () => void {
  const onOnline = () => {
    failures = 0;
    notBefore = 0;
    scheduleMarkDelivery();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') scheduleMarkDelivery();
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  const interval = setInterval(() => scheduleMarkDelivery(), 30_000);
  scheduleMarkDelivery(1000);
  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(interval);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
