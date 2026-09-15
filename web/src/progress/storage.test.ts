import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ProgressEvent, type ProgressState } from '@readport/shared';

vi.mock('./idb', () => ({
  STORES: {
    pendingEvents: 'pending-events',
    serverState: 'server-state',
    progressMeta: 'progress-meta',
    downloads: 'downloads',
    prefs: 'prefs',
  },
  openIdb: async () => {
    throw new Error('IndexedDB unavailable');
  },
}));

import {
  clearProgressStores,
  deletePendingEvent,
  enqueueProgressEvent,
  mergeProgressSnapshot,
  progressStorageDegraded,
  readPendingEvents,
  readProgressSnapshot,
} from './storage';

const event = (bookId: string, generation = 0, pct = 0.5): ProgressEvent => ({
  eventId: crypto.randomUUID(),
  bookId,
  deviceId: 'd',
  sessionId: 's',
  seq: 1,
  occurredAt: new Date().toISOString(),
  generation,
  intent: 'open',
  locator: { medium: 'audio', trackIdx: 0, positionMs: 1, pct },
});
const state = (bookId: string, revision: number, generation = 0): ProgressState => ({
  bookId,
  generation,
  revision,
  locator: { medium: 'audio', trackIdx: 0, positionMs: 1, pct: 0.5 },
  intent: 'open',
  occurredAt: new Date().toISOString(),
  sessionId: 's',
  deviceId: 'd',
  seq: 1,
  updatedAt: new Date().toISOString(),
  finished: false,
});

beforeEach(async () => {
  await clearProgressStores();
});

describe('when IndexedDB will not open, progress lives in memory instead of nowhere', () => {
  it('reports the degradation and still keeps a queue', async () => {
    expect(await enqueueProgressEvent(event('b1'))).toBe(true);
    expect(progressStorageDegraded()).toBe(true);
    expect((await readPendingEvents()).map((e) => e.bookId)).toEqual(['b1']);
    const [only] = await readPendingEvents();
    await deletePendingEvent(only!.eventId);
    expect(await readPendingEvents()).toEqual([]);
  });

  it('keeps the same generation and revision rules as the durable tier', async () => {
    await mergeProgressSnapshot('b2', 0, state('b2', 3));
    expect((await readProgressSnapshot('b2')).state?.revision).toBe(3);
    // An older revision cannot overwrite a newer one.
    await mergeProgressSnapshot('b2', 0, state('b2', 2));
    expect((await readProgressSnapshot('b2')).state?.revision).toBe(3);
    // A reset drops the cached state and the old generation's queue.
    await enqueueProgressEvent(event('b2', 0));
    await mergeProgressSnapshot('b2', 1, null);
    expect(await readProgressSnapshot('b2')).toEqual({ generation: 1, state: null });
    expect(await readPendingEvents()).toEqual([]);
    // And refuses an old-generation capture afterwards.
    expect(await enqueueProgressEvent(event('b2', 0))).toBe(false);
    expect(await enqueueProgressEvent(event('b2', 1))).toBe(true);
    // An older generation arriving late cannot lower it.
    await mergeProgressSnapshot('b2', 0, state('b2', 9, 0));
    expect((await readProgressSnapshot('b2')).generation).toBe(1);
  });
});
