/** Minimal typed IndexedDB wrapper for the progress queue and offline state. */

const DB_NAME = 'readport';
const DB_VERSION = 3;

export const STORES = {
  pendingEvents: 'pending-events', // key: eventId
  serverState: 'server-state', // key: bookId
  progressMeta: 'progress-meta', // server reset generation, key: bookId
  downloads: 'downloads', // key: bookId
  prefs: 'prefs', // key: string
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Open the database, once per page - but not once per page FOREVER.
 *
 * A rejected open used to be cached like a successful one, so a tab that was
 * blocked by an older tab holding the previous schema, or that hit a
 * transient quota error, could never store anything again without a reload.
 * A failure is forgotten so the next call tries afresh, and a connection
 * that another tab wants to upgrade closes itself instead of blocking the
 * upgrade for everyone.
 */
export function openIdb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error('IndexedDB unavailable'));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        if (dbPromise === attempt) dbPromise = null;
      };
      db.onclose = () => {
        if (dbPromise === attempt) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  dbPromise = attempt;
  attempt.catch(() => {
    if (dbPromise === attempt) dbPromise = null;
  });
  return attempt;
}

export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbClear(store: string): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbAll<T>(store: string): Promise<{ key: string; value: T }[]> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const keysReq = os.getAllKeys();
    const valsReq = os.getAll();
    tx.oncomplete = () => {
      const keys = keysReq.result as string[];
      const vals = valsReq.result as T[];
      resolve(keys.map((k, i) => ({ key: k, value: vals[i]! })));
    };
    tx.onerror = () => reject(tx.error);
  });
}
