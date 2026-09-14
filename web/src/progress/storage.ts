import { type ProgressEvent, type ProgressState } from '@readport/shared';
import { openIdb, STORES } from './idb';

export interface ProgressSnapshot {
  generation: number;
  state: ProgressState | null;
}
const names = [STORES.progressMeta, STORES.serverState, STORES.pendingEvents];

/** Atomic across tabs: an older response cannot lower a generation or restore its locator. */
export async function mergeProgressSnapshot(
  bookId: string,
  generation: number,
  state: ProgressState | null,
): Promise<void> {
  const db = await openIdb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
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
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
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
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readonly');
    const meta = tx.objectStore(STORES.progressMeta).get(bookId);
    const state = tx.objectStore(STORES.serverState).get(bookId);
    tx.oncomplete = () =>
      resolve({ generation: Number(meta.result ?? 0), state: state.result ?? null });
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Progress read aborted'));
  });
}
