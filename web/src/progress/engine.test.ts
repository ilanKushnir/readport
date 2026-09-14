import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map<string, Map<string, unknown>>();
const store = (s: string) => {
  if (!stores.has(s)) stores.set(s, new Map());
  return stores.get(s)!;
};

vi.mock('./idb', () => ({
  STORES: {
    pendingEvents: 'pending-events',
    serverState: 'server-state',
    progressMeta: 'progress-meta',
    downloads: 'downloads',
    prefs: 'prefs',
  },
  idbPut: vi.fn(async (s: string, k: string, v: unknown) => void store(s).set(k, v)),
  idbGet: vi.fn(async (s: string, k: string) => store(s).get(k)),
  idbDelete: vi.fn(async (s: string, k: string) => void store(s).delete(k)),
  idbClear: vi.fn(async (s: string) => void store(s).clear()),
  idbAll: vi.fn(async (s: string) =>
    [...store(s).entries()].map(([key, value]) => ({ key, value })),
  ),
}));

vi.mock('./storage', () => ({
  readProgressSnapshot: async (id: string) => ({
    generation: store('progress-meta').get(id) ?? 0,
    state: store('server-state').get(id) ?? null,
  }),
  enqueueProgressEvent: async (event: ProgressEvent) => {
    if ((event.generation ?? 0) !== (store('progress-meta').get(event.bookId) ?? 0)) return false;
    await idbPut('pending-events', event.eventId, event);
    return true;
  },
  mergeProgressSnapshot: async (id: string, generation: number, state: unknown) => {
    const current = Number(store('progress-meta').get(id) ?? 0);
    if (generation < current) return;
    if (generation > current) {
      store('progress-meta').set(id, generation);
      store('server-state').delete(id);
      for (const [key, value] of store('pending-events')) {
        const event = value as ProgressEvent;
        if (event.bookId === id && (event.generation ?? 0) < generation)
          store('pending-events').delete(key);
      }
    }
    if (state) store('server-state').set(id, state);
  },
}));
const apiMock = vi.fn(async (): Promise<Record<string, unknown>> => ({ results: [], state: null }));
vi.mock('../api/client', () => ({
  api: (...args: unknown[]) => apiMock(...(args as [])),
  isOffline: () => false,
  isUnauthorized: () => false,
}));

import {
  claimProgressQueue,
  drainLastGasp,
  flushPending,
  persistActiveLocatorAndFlush,
  recordCheckpoint,
  resetBookProgress,
  resumeLocator,
  setActiveLocatorProvider,
  withinKeepaliveBudget,
} from './engine';
import { idbPut } from './idb';
import { type ProgressEvent } from '@readport/shared';

/** The engine's synchronous storage (queue owner, last-gasp stash). */
class MemoryStorage {
  private readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

beforeEach(() => {
  stores.clear();
  apiMock.mockReset();
  apiMock.mockResolvedValue({ results: [], state: null });
  vi.stubGlobal('localStorage', new MemoryStorage());
});

const audio = (pct: number) => ({ medium: 'audio' as const, trackIdx: 0, positionMs: 1000, pct });

/** The events in the most recent POST body. */
const lastBatch = (): ProgressEvent[] => {
  const call = apiMock.mock.calls.at(-1) as unknown as [
    string,
    { body: { events: ProgressEvent[] } },
  ];
  return call[1].body.events;
};

const flushMicro = () => new Promise((r) => setTimeout(r, 20));

describe('lifecycle persistence (visibilitychange/pagehide path)', () => {
  it('writes the LIVE locator to IndexedDB before the keepalive flush', async () => {
    const locator = { medium: 'audio' as const, trackIdx: 1, positionMs: 42_000, pct: 0.3 };
    const unregister = setActiveLocatorProvider(() => ({ bookId: 'bookX', locator }));
    persistActiveLocatorAndFlush();
    await flushMicro();
    const pending = [...store('pending-events').values()] as ProgressEvent[];
    // The current position - inside the debounce/heartbeat window - is durable.
    expect(pending.some((e) => e.bookId === 'bookX' && e.locator.pct === 0.3)).toBe(true);
    unregister();
  });

  it('without an active surface it still flushes the queue', async () => {
    await recordCheckpoint('bookY', 'pause', {
      medium: 'audio',
      trackIdx: 0,
      positionMs: 1,
      pct: 0.01,
    });
    persistActiveLocatorAndFlush();
    await flushMicro();
    expect(apiMock).toHaveBeenCalled();
  });

  it('unregistering the provider stops live capture', async () => {
    const unregister = setActiveLocatorProvider(() => ({
      bookId: 'bookZ',
      locator: { medium: 'audio', trackIdx: 0, positionMs: 5, pct: 0.5 },
    }));
    unregister();
    persistActiveLocatorAndFlush();
    await flushMicro();
    const pending = [...store('pending-events').values()] as ProgressEvent[];
    expect(pending.some((e) => e.bookId === 'bookZ')).toBe(false);
  });
});

describe('baseRevision propagation', () => {
  it('events declare the last server revision known for the book', async () => {
    store('server-state').set('bookR', { revision: 12 });
    await recordCheckpoint(
      'bookR',
      'seek',
      { medium: 'audio', trackIdx: 0, positionMs: 9, pct: 0.9 },
      { flush: false },
    );
    const pending = [...store('pending-events').values()] as ProgressEvent[];
    const ev = pending.find((e) => e.bookId === 'bookR')!;
    expect(ev.baseRevision).toBe(12);
  });

  it('events without cached server state omit baseRevision', async () => {
    await recordCheckpoint(
      'bookNew',
      'open',
      { medium: 'audio', trackIdx: 0, positionMs: 0, pct: 0 },
      { flush: false },
    );
    const ev = ([...store('pending-events').values()] as ProgressEvent[]).find(
      (e) => e.bookId === 'bookNew',
    )!;
    expect(ev.baseRevision).toBeUndefined();
  });
});

describe('queue ownership (a revoked session must not cost the reader their writing)', () => {
  it('a different account cannot inherit a last-gasp stash or cached progress', async () => {
    localStorage.setItem('rp-progress-owner', 'user-a');
    store('server-state').set('private', { revision: 4 });
    localStorage.setItem(
      'rp-progress-stash',
      JSON.stringify([
        {
          eventId: crypto.randomUUID(),
          bookId: 'private',
          deviceId: 'a',
          sessionId: 'a',
          seq: 1,
          occurredAt: new Date().toISOString(),
          intent: 'open',
          locator: audio(0.4),
        },
      ]),
    );
    await claimProgressQueue('user-b');
    expect(await drainLastGasp()).toBe(0);
    expect(store('server-state').size).toBe(0);
  });
  it('the same account signing back in keeps its un-synced backlog', async () => {
    localStorage.setItem('rp-progress-owner', 'user-a');
    await recordCheckpoint('bookQ', 'pause', audio(0.4), { flush: false });
    await claimProgressQueue('user-a');
    expect(store('pending-events').size).toBe(1);
    await flushPending();
    expect(apiMock).toHaveBeenCalled(); // the hour on the plane is delivered
  });

  it('a backlog left by ANOTHER account is discarded, never posted to the new one', async () => {
    localStorage.setItem('rp-progress-owner', 'user-a');
    await recordCheckpoint('bookQ', 'pause', audio(0.4), { flush: false });
    await claimProgressQueue('user-b');
    expect(store('pending-events').size).toBe(0);
    await flushPending();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('a first sign-in on this browser adopts an unowned queue', async () => {
    await recordCheckpoint('bookQ', 'seek', audio(0.2), { flush: false });
    await claimProgressQueue('user-a');
    expect(store('pending-events').size).toBe(1);
  });
});

describe('keepalive flush budget', () => {
  it('trims the last-chance batch to fit the 64 KiB keepalive quota', async () => {
    for (let i = 0; i < 200; i++) {
      await recordCheckpoint('bookB', 'heartbeat', audio(i / 1000), { flush: false });
    }
    await flushPending(true);
    const batch = lastBatch();
    expect(batch.length).toBeLessThan(200);
    expect(JSON.stringify({ events: batch }).length).toBeLessThan(64 * 1024);
  });

  it('a normal flush still sends the full batch', async () => {
    for (let i = 0; i < 200; i++) {
      await recordCheckpoint('bookB', 'heartbeat', audio(i / 1000), { flush: false });
    }
    await flushPending();
    expect(lastBatch()).toHaveLength(200);
  });

  it('an oversized single event is still sent rather than blocking the queue', () => {
    const huge = {
      eventId: 'x',
      locator: { note: 'x'.repeat(70 * 1024) },
    } as unknown as ProgressEvent;
    expect(withinKeepaliveBudget([huge])).toHaveLength(1);
  });
});

describe('last-gasp stash (page killed before IndexedDB commits)', () => {
  it('restores a locator whose IndexedDB write never committed', async () => {
    const unregister = setActiveLocatorProvider(() => ({
      bookId: 'bookK',
      locator: audio(0.77),
    }));
    // iOS freezes the page right after pagehide: the transaction is aborted.
    vi.mocked(idbPut).mockRejectedValueOnce(new Error('transaction aborted'));
    persistActiveLocatorAndFlush();
    await flushMicro();
    unregister();
    expect(store('pending-events').size).toBe(0);

    // Next start: the position is back in the queue, exactly once.
    expect(await drainLastGasp()).toBe(1);
    const pending = [...store('pending-events').values()] as ProgressEvent[];
    expect(pending.some((e) => e.bookId === 'bookK' && e.locator.pct === 0.77)).toBe(true);
    expect(await drainLastGasp()).toBe(0);
  });

  it('does not discard pending progress when the server cannot confirm reset', async () => {
    await recordCheckpoint('reset-fail', 'open', audio(0.3), { flush: false });
    apiMock.mockRejectedValueOnce(new Error('offline'));
    await expect(resetBookProgress('reset-fail')).rejects.toThrow('offline');
    expect(store('pending-events').size).toBe(1);
  });
  it('clears only the selected edition after server acknowledgement', async () => {
    await recordCheckpoint('reset-ok', 'open', audio(0.3), { flush: false });
    await recordCheckpoint('paired', 'open', audio(0.7), { flush: false });
    store('server-state').set('reset-ok', { revision: 1 });
    store('downloads').set('reset-ok', { status: 'done' });
    apiMock.mockResolvedValueOnce({ generation: 1 });
    await resetBookProgress('reset-ok');
    expect([...store('pending-events').values()].map((v) => (v as ProgressEvent).bookId)).toEqual([
      'paired',
    ]);
    expect(store('server-state').has('reset-ok')).toBe(false);
    expect(store('downloads').has('reset-ok')).toBe(true);
  });
  it('reopen after another device reset cannot promote an old offline locator into a fresh open', async () => {
    await recordCheckpoint('remote-reset', 'open', audio(0.8), { flush: false });
    apiMock.mockResolvedValueOnce({ state: null, generation: 1 });
    expect(await resumeLocator('remote-reset')).toBeNull();
    await recordCheckpoint('remote-reset', 'open', audio(0.2), { flush: false });
    const pending = [...store('pending-events').values()] as ProgressEvent[];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ generation: 1, locator: { pct: 0.2 } });
  });
  it('an in-flight pre-reset ack cannot restore cached progress', async () => {
    await recordCheckpoint('ack-race', 'open', audio(0.8), { flush: false });
    let respond!: (value: Record<string, unknown>) => void;
    apiMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const flushing = flushPending();
    await flushMicro();
    apiMock.mockResolvedValueOnce({ generation: 1 });
    await resetBookProgress('ack-race');
    respond({
      results: [],
      state: {
        bookId: 'ack-race',
        revision: 100,
        generation: 0,
        locator: audio(0.8),
        occurredAt: '2099-01-01T00:00:00Z',
      },
    });
    await flushing;
    expect(store('server-state').has('ack-race')).toBe(false);
  });
  it('a committed write leaves nothing stashed to replay', async () => {
    const unregister = setActiveLocatorProvider(() => ({ bookId: 'bookL', locator: audio(0.5) }));
    persistActiveLocatorAndFlush();
    await flushMicro();
    unregister();
    expect(await drainLastGasp()).toBe(0);
  });
});
