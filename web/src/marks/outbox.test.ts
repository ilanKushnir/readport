import { annotationIdSchema, type Annotation } from '@readport/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Outbox from './outbox';
import { type QueuedMarkChange } from './outbox';

const h = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
    ) {
      super(code);
    }
  }
  return {
    ApiError,
    api: vi.fn(),
    account: { current: 'u1' as string | null },
    /** How the database opens: by default, it does not. */
    openIdb: { current: null as null | (() => Promise<IDBDatabase>) },
  };
});

vi.mock('../api/client', () => ({
  api: (...args: unknown[]) => h.api(...args),
  ApiError: h.ApiError,
  isOffline: (err: unknown) => err instanceof h.ApiError && err.status === 0,
}));
vi.mock('../progress/engine', () => ({
  queueAccount: () => h.account.current,
  backoffMs: (n: number) => 5000 * n,
}));
// No IndexedDB here: the changes wait in memory, by the same rules.
vi.mock('../progress/idb', () => ({
  STORES: { markChanges: 'mark-changes' },
  openIdb: async () => {
    if (h.openIdb.current) return h.openIdb.current();
    throw new Error('IndexedDB unavailable');
  },
}));

let o: typeof Outbox;

const mark = (over: Partial<Annotation> = {}): Annotation => ({
  id: 'ann_onTheServer01',
  bookId: 'b1',
  kind: 'highlight',
  locator: { medium: 'ebook', spineIdx: 0, charOffset: 10, pct: 0.1 },
  endLocator: { medium: 'ebook', spineIdx: 0, charOffset: 34, pct: 0.11 },
  color: 'amber',
  selectedText: 'the lamps along the quay',
  note: null,
  createdAt: '2026-10-05T09:00:00.000Z',
  ...over,
});

let order = 0;
const queued = (change: QueuedMarkChange['change']): QueuedMarkChange => ({
  changeId: `c${++order}`,
  ownerId: 'u1',
  at: order,
  order,
  change,
});

/** The requests made, as "METHOD url". */
const calls = () =>
  h.api.mock.calls.map(
    ([url, opts]) => `${(opts as { method?: string } | undefined)?.method ?? 'GET'} ${url}`,
  );

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
  h.api.mockReset();
  h.account.current = 'u1';
  h.openIdb.current = null;
  o = await import('./outbox');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** localStorage, as a browser keeps it: there for the next page too. */
function stubLocalStorage(): Map<string, string> {
  const kept = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  });
  return kept;
}

describe('a book’s marks with the changes still on their way', () => {
  it('lays them over the served list in the order they were made, and keeps to the book', () => {
    const served = [mark({ id: 'ann_onTheServer01' })];
    const made = mark({ id: 'ann_madeHereOffline', color: 'sky' });
    const queue = [
      queued({ type: 'create', mark: made }),
      queued({ type: 'patch', id: 'ann_onTheServer01', bookId: 'b1', patch: { color: 'rose' } }),
      queued({ type: 'patch', id: made.id, bookId: 'b1', patch: { note: 'ask about this' } }),
      queued({ type: 'delete', id: 'ann_onTheServer01', bookId: 'b1' }),
      queued({ type: 'create', mark: mark({ id: 'ann_inAnotherBook', bookId: 'b2' }) }),
    ];
    expect(o.withPendingChanges(served, queue, 'b1')).toEqual([
      { ...made, note: 'ask about this' },
    ]);
  });

  it('shows a mark once when it has reached the server already', () => {
    const made = mark({ id: 'ann_madeHereOffline' });
    const queue = [queued({ type: 'create', mark: made })];
    expect(o.withPendingChanges([made], queue, 'b1')).toEqual([made]);
  });

  it('across every book, takes colours, notes and removals - and leaves new marks to the list', () => {
    const a = mark({ id: 'ann_inTheFirstBook' });
    const d = mark({ id: 'ann_inTheOtherBook', bookId: 'b2' });
    const queue = [
      queued({ type: 'patch', id: d.id, bookId: 'b2', patch: { color: 'plum' } }),
      queued({ type: 'delete', id: a.id, bookId: 'b1' }),
      queued({ type: 'create', mark: mark({ id: 'ann_notYetDelivered' }) }),
    ];
    expect(o.withPendingEdits([a, d], queue)).toEqual([{ ...d, color: 'plum' }]);
  });

  it('changes only what a change names', () => {
    const m = mark({ note: 'kept' });
    expect(o.patchedMark(m, { color: 'sand' })).toEqual({ ...m, color: 'sand' });
  });
});

describe('a name made on this device', () => {
  it('is one the server takes, and never the same twice', () => {
    const names = new Set(Array.from({ length: 200 }, () => o.newMarkId()));
    expect(names.size).toBe(200);
    for (const name of names) expect(annotationIdSchema.safeParse(name).success).toBe(true);
  });
});

describe('the queue', () => {
  it('keeps a mark made offline and delivers it when the server answers, dated when it was made', async () => {
    h.api.mockRejectedValue(new h.ApiError(0, 'network'));
    const m = mark({ id: o.newMarkId() });
    expect(await o.recordMarkChange({ type: 'create', mark: m })).toBe(true);
    await o.deliverMarkChanges();
    expect(calls()).toEqual(['POST /api/books/b1/annotations']);
    expect(await o.pendingMarkChanges()).toHaveLength(1);

    // Three hours later the connection is back.
    vi.setSystemTime(new Date('2026-10-05T13:00:00Z'));
    h.api.mockReset();
    h.api.mockImplementation(async (url: string) =>
      url.endsWith('/annotations') ? { annotation: m, annotations: [m] } : { ok: true },
    );
    await o.deliverMarkChanges();
    const [, sent] = h.api.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(sent.body).toMatchObject({ id: m.id, ageMs: 3 * 3600_000, color: 'amber' });
    expect(await o.pendingMarkChanges()).toEqual([]);
    // And the copy a downloaded book opens with offline is renewed with it.
    expect(calls()).toEqual(['POST /api/books/b1/annotations', 'GET /api/books/b1/annotations']);
  });

  it('sends changes in the order they were made, and a removal of a mark already gone is done', async () => {
    const m = mark({ id: o.newMarkId() });
    await o.recordMarkChange({ type: 'create', mark: m });
    await o.recordMarkChange({ type: 'patch', id: m.id, bookId: 'b1', patch: { color: 'rose' } });
    await o.recordMarkChange({ type: 'delete', id: m.id, bookId: 'b1' });
    h.api.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'DELETE') throw new h.ApiError(404, 'not-found');
      return { annotation: m, annotations: [] };
    });
    await o.deliverMarkChanges();
    expect(calls()).toEqual([
      'POST /api/books/b1/annotations',
      `PATCH /api/annotations/${m.id}`,
      `DELETE /api/annotations/${m.id}`,
      'GET /api/books/b1/annotations',
    ]);
    expect(await o.pendingMarkChanges()).toEqual([]);
  });

  it('gives a failing server a rest, and the changes wait for it', async () => {
    h.api.mockRejectedValue(new h.ApiError(503, 'http-503'));
    await o.recordMarkChange({ type: 'delete', id: 'ann_onTheServer01', bookId: 'b1' });
    await o.deliverMarkChanges();
    await o.deliverMarkChanges();
    expect(h.api).toHaveBeenCalledTimes(1);
    expect(await o.pendingMarkChanges()).toHaveLength(1);

    h.api.mockReset();
    h.api.mockResolvedValue({ ok: true, annotations: [] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls()[0]).toBe('DELETE /api/annotations/ann_onTheServer01');
    expect(await o.pendingMarkChanges()).toEqual([]);
  });

  it('lets go of a change the server will never take, and sends the ones behind it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await o.recordMarkChange({ type: 'create', mark: mark({ id: o.newMarkId() }) });
    await o.recordMarkChange({ type: 'create', mark: mark({ id: o.newMarkId(), bookId: 'b2' }) });
    h.api
      .mockRejectedValueOnce(new h.ApiError(400, 'invalid'))
      .mockResolvedValue({ annotation: mark(), annotations: [] });
    await o.deliverMarkChanges();
    expect(calls().slice(0, 2)).toEqual([
      'POST /api/books/b1/annotations',
      'POST /api/books/b2/annotations',
    ]);
    expect(await o.pendingMarkChanges()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps everything when the session has gone, to deliver once its owner is back', async () => {
    await o.recordMarkChange({ type: 'delete', id: 'ann_onTheServer01', bookId: 'b1' });
    h.api.mockRejectedValueOnce(new h.ApiError(401, 'unauthorized'));
    await o.deliverMarkChanges();
    expect(await o.pendingMarkChanges()).toHaveLength(1);
    // Not a failing server: no rest is imposed on the next try.
    h.api.mockResolvedValue({ ok: true, annotations: [] });
    await o.deliverMarkChanges();
    expect(await o.pendingMarkChanges()).toEqual([]);
  });

  it('follows a mark the server named otherwise with whatever is queued after it', async () => {
    const m = mark({ id: o.newMarkId() });
    await o.recordMarkChange({ type: 'create', mark: m });
    await o.recordMarkChange({ type: 'patch', id: m.id, bookId: 'b1', patch: { note: 'later' } });
    const renamed = vi.fn();
    o.onMarkRenamed(renamed);
    h.api.mockImplementation(async (url: string, opts?: { method?: string }) =>
      opts?.method === 'POST'
        ? { annotation: { ...m, id: 'ann_namedByTheServer' } }
        : { annotation: m, annotations: [] },
    );
    await o.deliverMarkChanges();
    expect(calls()[1]).toBe('PATCH /api/annotations/ann_namedByTheServer');
    expect(renamed).toHaveBeenCalledWith(m.id, 'ann_namedByTheServer');
  });

  it('keeps one account’s changes from anyone else, and keeps nothing for nobody', async () => {
    await o.recordMarkChange({ type: 'delete', id: 'ann_onTheServer01', bookId: 'b1' });
    h.account.current = 'u2';
    await o.deliverMarkChanges();
    expect(h.api).not.toHaveBeenCalled();
    expect(await o.pendingMarkChanges()).toEqual([]);
    // Someone else signed in on this browser: the first account's changes go.
    await o.claimMarkChanges('u2');
    h.account.current = 'u1';
    expect(await o.pendingMarkChanges()).toEqual([]);

    h.account.current = null;
    expect(await o.recordMarkChange({ type: 'delete', id: 'ann_x0000000000', bookId: 'b1' })).toBe(
      false,
    );
  });

  it('opens a book with the marks on their way, with or without the server', async () => {
    const onServer = mark({ id: 'ann_onTheServer01' });
    const made = mark({ id: o.newMarkId(), color: 'plum' });
    await o.recordMarkChange({ type: 'create', mark: made });
    await o.recordMarkChange({ type: 'delete', id: onServer.id, bookId: 'b1' });
    h.api.mockResolvedValue({ annotations: [onServer] });
    expect(await o.loadBookMarks('b1')).toEqual([made]);
    h.api.mockRejectedValue(new h.ApiError(0, 'network'));
    expect(await o.loadBookMarks('b1')).toEqual([made]);
  });

  it('waits for a delivery before a list is fetched, but not for one that hangs', async () => {
    await o.recordMarkChange({ type: 'delete', id: 'ann_onTheServer01', bookId: 'b1' });
    h.api.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    void o.settleMarkChanges(2500).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(settled).toBe(true);
  });
});

describe('storage that will not answer', () => {
  // The test before these leaves a delivery hanging, and with it the lock
  // deliveries take turns by: here they go without one.
  beforeEach(() => vi.stubGlobal('navigator', {}));

  it('does not hold a mark back: it is made at once, and sent all the same', async () => {
    // A phone's database after a while in the background: no error, no event.
    h.openIdb.current = () => new Promise(() => {});
    h.api.mockResolvedValue({ annotation: mark({ id: 'ann_madeWhileItHung' }) });
    const m = mark({ id: 'ann_madeWhileItHung' });
    let made: boolean | null = null;
    void o.recordMarkChange({ type: 'create', mark: m }).then((ok) => (made = ok));
    await vi.advanceTimersByTimeAsync(0);
    expect(made).toBe(true);
    // The write is given up on, the change is kept elsewhere, and it goes.
    await vi.advanceTimersByTimeAsync(2100);
    await o.deliverMarkChanges();
    expect(calls()).toContain('POST /api/books/b1/annotations');
    expect(await o.pendingMarkChanges()).toEqual([]);
  });

  it('opens a book with the mark on it while the database is still silent', async () => {
    h.openIdb.current = () => new Promise(() => {});
    h.api.mockRejectedValue(new h.ApiError(0, 'network'));
    const m = mark({ id: 'ann_madeWhileItHung' });
    await o.recordMarkChange({ type: 'create', mark: m });
    let marks: Annotation[] | null = null;
    void o.loadBookMarks('b1').then((list) => (marks = list));
    await vi.advanceTimersByTimeAsync(2100);
    expect(marks).toEqual([m]);
  });

  it('keeps a change through the page closing, without a database at all', async () => {
    const kept = stubLocalStorage();
    h.api.mockRejectedValue(new h.ApiError(0, 'network'));
    const m = mark({ id: 'ann_madeWithNoDatabase' });
    await o.recordMarkChange({ type: 'create', mark: m });
    await o.deliverMarkChanges();
    expect(kept.size).toBe(1);

    // The page is closed, and opened again.
    vi.resetModules();
    o = await import('./outbox');
    expect((await o.pendingMarkChanges()).map((c) => c.change)).toEqual([
      { type: 'create', mark: m },
    ]);
    h.api.mockReset();
    h.api.mockResolvedValue({ annotation: m });
    await o.deliverMarkChanges();
    expect(calls()).toContain('POST /api/books/b1/annotations');
    expect(await o.pendingMarkChanges()).toEqual([]);
    expect(kept.size).toBe(0);

    // Signing out leaves nothing of the account behind there either.
    await o.recordMarkChange({ type: 'delete', id: m.id, bookId: 'b1' });
    await o.pendingMarkChanges();
    expect(kept.size).toBe(1);
    await o.purgeMarkChanges();
    expect(kept.size).toBe(0);
  });
});

describe('a downloaded book’s own copy of its marks', () => {
  // The test before these leaves a delivery hanging, and with it the lock
  // deliveries take turns by: here they go without one.
  beforeEach(() => vi.stubGlobal('navigator', {}));

  /** The cache a download is kept in, holding one book's list. */
  function stubCaches(list: Annotation[] | null) {
    const kept = new Map<string, string>();
    if (list) kept.set('/api/books/b1/annotations', JSON.stringify({ annotations: list }));
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (url: string) => {
          const body = kept.get(url);
          return body === undefined ? undefined : { json: async () => JSON.parse(body) as unknown };
        },
        put: async (url: string, res: Response) => void kept.set(url, await res.text()),
      }),
    });
    return {
      marks: () =>
        (
          JSON.parse(kept.get('/api/books/b1/annotations') ?? '{}') as {
            annotations?: Annotation[];
          }
        ).annotations,
      size: () => kept.size,
    };
  }

  it('has a mark the moment the server takes it, whether or not the list is fetched after', async () => {
    const onServer = mark({ id: 'ann_onTheServer01' });
    const copy = stubCaches([onServer]);
    const m = mark({ id: 'ann_madeOnTheTrain', color: 'sky' });
    // The change gets through; the list fetched after it does not.
    h.api.mockImplementation(async (_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') return { annotation: m };
      if (opts?.method) return { ok: true };
      throw new h.ApiError(0, 'network');
    });
    await o.recordMarkChange({ type: 'create', mark: m });
    await o.deliverMarkChanges();
    expect(copy.marks()).toEqual([onServer, m]);

    await o.recordMarkChange({ type: 'patch', id: m.id, bookId: 'b1', patch: { color: 'rose' } });
    await o.recordMarkChange({ type: 'delete', id: onServer.id, bookId: 'b1' });
    await o.deliverMarkChanges();
    expect(copy.marks()).toEqual([{ ...m, color: 'rose' }]);
    expect(await o.pendingMarkChanges()).toEqual([]);
  });

  it('is kept under the name the server gave the mark', async () => {
    const copy = stubCaches([]);
    const m = mark({ id: 'ann_nameAlreadyTaken' });
    const renamed = { ...m, id: 'ann_theServersOwnName' };
    h.api.mockResolvedValue({ annotation: renamed });
    await o.recordMarkChange({ type: 'create', mark: m });
    await o.deliverMarkChanges();
    expect(copy.marks()).toEqual([renamed]);
  });

  it('is not made for a book that was never downloaded', async () => {
    const copy = stubCaches(null);
    h.api.mockResolvedValue({ annotation: mark({ id: 'ann_notDownloaded' }) });
    await o.recordMarkChange({ type: 'create', mark: mark({ id: 'ann_notDownloaded' }) });
    await o.deliverMarkChanges();
    expect(copy.size()).toBe(0);
  });
});
