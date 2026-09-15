import { type ProgressEvent, type ProgressState } from '@readport/shared';
import { openIdb, STORES } from './idb';

export interface ProgressSnapshot {
  generation: number;
  state: ProgressState | null;
}
const names = [STORES.progressMeta, STORES.serverState, STORES.pendingEvents];

/**
 * The tier under IndexedDB.
 *
 * Some browsers refuse IndexedDB outright - private windows in older Firefox,
 * "block all site data", a few WebViews. The queue used to be IndexedDB or
 * nothing, so on those the book would not even open: resume read the
 * snapshot, the read threw, and the reader showed "could not open". Progress
 * that lives only for this page is a smaller promise than progress that
 * survives it, but it is honest and it keeps the book readable; the last-gasp
 * stash in localStorage still carries the newest checkpoints across a reload.
 */
const memory = {
  meta: new Map<string, number>(),
  state: new Map<string, ProgressState>(),
  pending: new Map<string, ProgressEvent>(),
};
let idbDown = false;

/** Whether checkpoints are being kept only in memory for this page. */
export function progressStorageDegraded(): boolean {
  return idbDown;
}

async function db(): Promise<IDBDatabase | null> {
  try {
    const opened = await openIdb();
    idbDown = false;
    return opened;
  } catch {
    idbDown = true;
    return null;
  }
}

/** Atomic across tabs: an older response cannot lower a generation or restore its locator. */
export async function mergeProgressSnapshot(
  bookId: string,
  generation: number,
  state: ProgressState | null,
): Promise<void> {
  const database = await db();
  if (!database) {
    const current = memory.meta.get(bookId) ?? 0;
    if (generation < current) return;
    if (generation > current) {
      memory.meta.set(bookId, generation);
      memory.state.delete(bookId);
      for (const [key, ev] of memory.pending) {
        if (ev.bookId === bookId && (ev.generation ?? 0) < generation) memory.pending.delete(key);
      }
    }
    if (state && (state.generation ?? 0) === generation) {
      const previous = memory.state.get(bookId);
      if (!previous || previous.revision <= state.revision) memory.state.set(bookId, state);
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(names, 'readwrite');
    const meta = tx.objectStore(STORES.progressMeta);
    const cached = tx.objectStore(STORES.serverState);
    const req = meta.get(bookId);
    req.onsuccess = () => {
      const current = Number(req.result ?? 0);
      if (generation < current) return;
      if (generation > current) {
        meta.put(generation, bookId);
        cached.delete(bookId);
        const cursor = tx.objectStore(STORES.pendingEvents).openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          const ev = c.value as ProgressEvent;
          if (ev.bookId === bookId && (ev.generation ?? 0) < generation) c.delete();
          c.continue();
        };
      }
      if (state && (state.generation ?? 0) === generation) {
        const previous = cached.get(bookId);
        previous.onsuccess = () => {
          if (!previous.result || previous.result.revision <= state.revision)
            cached.put(state, bookId);
        };
      }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Progress transaction aborted'));
  });
}

/** Compare and enqueue in ONE transaction: reset and an old tab's capture cannot interleave. */
export async function enqueueProgressEvent(event: ProgressEvent): Promise<boolean> {
  const database = await db();
  if (!database) {
    if ((event.generation ?? 0) !== (memory.meta.get(event.bookId) ?? 0)) return false;
    memory.pending.set(event.eventId, event);
    return true;
  }
  return new Promise((resolve, reject) => {
    const tx = database.transaction(names, 'readwrite');
    let accepted = false;
    const req = tx.objectStore(STORES.progressMeta).get(event.bookId);
    req.onsuccess = () => {
      if ((event.generation ?? 0) !== Number(req.result ?? 0)) return;
      tx.objectStore(STORES.pendingEvents).put(event, event.eventId);
      accepted = true;
    };
    tx.oncomplete = () => resolve(accepted);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Progress transaction aborted'));
  });
}

export async function readProgressSnapshot(bookId: string): Promise<ProgressSnapshot> {
  const database = await db();
  if (!database) {
    return { generation: memory.meta.get(bookId) ?? 0, state: memory.state.get(bookId) ?? null };
  }
  return new Promise((resolve, reject) => {
    const tx = database.transaction(names, 'readonly');
    const meta = tx.objectStore(STORES.progressMeta).get(bookId);
    const state = tx.objectStore(STORES.serverState).get(bookId);
    tx.oncomplete = () =>
      resolve({ generation: Number(meta.result ?? 0), state: state.result ?? null });
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Progress read aborted'));
  });
}

/** Every queued event, from whichever tier is holding them. */
export async function readPendingEvents(): Promise<ProgressEvent[]> {
  const database = await db();
  if (!database) return [...memory.pending.values()];
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORES.pendingEvents, 'readonly');
    const req = tx.objectStore(STORES.pendingEvents).getAll();
    tx.oncomplete = () => resolve(req.result as ProgressEvent[]);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Progress read aborted'));
  });
}

export async function deletePendingEvent(eventId: string): Promise<void> {
  const database = await db();
  if (!database) {
    memory.pending.delete(eventId);
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORES.pendingEvents, 'readwrite');
    tx.objectStore(STORES.pendingEvents).delete(eventId);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Progress delete aborted'));
  });
}

/** Forget everything progress-related, in whichever tier holds it. */
export async function clearProgressStores(): Promise<void> {
  memory.meta.clear();
  memory.state.clear();
  memory.pending.clear();
  const database = await db();
  if (!database) return;
  return new Promise((resolve, reject) => {
    const tx = database.transaction(names, 'readwrite');
    for (const name of names) tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Progress clear aborted'));
  });
}
