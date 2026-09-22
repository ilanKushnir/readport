import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ProgressEvent } from '@readport/shared';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { statsWindowStart } from './stats.js';

/**
 * The stats endpoint's contract with the page that draws it: sessions in a
 * window, newest first and capped; the books they name, in the library or
 * not; and the whole-history numbers a window cannot add up.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-stats-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: tmp,
    cacheDir: tmp,
    sessionSecret: 'stats-test-secret-0123456789abcdef',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});

const request = (
  url: string,
  user: string | null = 'alice',
  method: 'GET' | 'POST' = 'GET',
  payload?: unknown,
) =>
  app.inject({
    url,
    method,
    remoteAddress: '10.0.0.5',
    headers: { ...(user ? { 'x-rp-test-user': user } : {}), 'x-rp-csrf': '1' },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

interface Session {
  id: number;
  bookId: string;
  medium: string;
  deviceId: string;
  startedAt: string;
  endedAt: string;
  seconds: number;
  pctStart: number;
  pctEnd: number;
  pctAdvanced: number;
}
interface Body {
  generatedAt: string;
  since: string;
  sessions: Session[];
  truncated?: true;
  books: Record<
    string,
    {
      id: string;
      title: string | null;
      author: string | null;
      kind: string;
      totalChars: number | null;
      durationMs: number | null;
      pct: number;
      finished: boolean;
      finishedAt: string | null;
      lastReadAt: string;
    }
  >;
  allTime: {
    seconds: number;
    sessions: number;
    firstSessionAt: string | null;
    booksFinished: number;
  };
}
const stats = async (query = '', user = 'alice'): Promise<Body> => {
  const res = await request(`/api/stats${query}`, user);
  expect(res.statusCode).toBe(200);
  return res.json() as Body;
};
const whoami = async (user: string) =>
  ((await request('/api/auth/me', user)).json() as { user: { id: string } }).user.id;

const NOW = Date.now();
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let seq = 0;
const event = (
  bookId: string,
  pct: number,
  intent: ProgressEvent['intent'],
  occurredAt: string,
  medium: 'ebook' | 'audio',
): ProgressEvent => ({
  eventId: crypto.randomUUID(),
  bookId,
  deviceId: 'phone',
  sessionId: 'phone-tab',
  seq: ++seq,
  occurredAt,
  intent,
  locator:
    medium === 'audio'
      ? { medium, trackIdx: 0, positionMs: 0, pct }
      : { medium, spineIdx: 1, charOffset: 7, pct },
});
const insertSession = db.prepare(
  `INSERT INTO reading_sessions
     (user_id, book_id, medium, device_id, started_at, ended_at, pct_start, pct_end, pct_advanced, events)
   VALUES (?, ?, ?, 'kindle', ?, ?, 0.1, 0.2, 0.1, 4)`,
);

let alice = '';
const finishAt = ago(1 * HOUR);
const goneStart = ago(200 * DAY);
const goneEnd = ago(200 * DAY - 30 * 60_000);
const blankEnd = ago(10 * DAY - 10 * 60_000);

beforeAll(async () => {
  await app.ready();
  alice = await whoami('alice');
  const bob = await whoami('bob');
  const book = db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, author, duration_ms, meta_json, scan_state, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
  );
  book.run(
    'novel',
    'ebook',
    tmp,
    'novel.epub',
    'epub',
    'The Novel',
    'A. Writer',
    null,
    JSON.stringify({ totalChars: 412000, spineCount: 12 }),
    ago(30 * DAY),
  );
  book.run(
    'tape',
    'audio',
    tmp,
    'tape',
    'm4b',
    'The Tape',
    'A. Narrator',
    36_000_000,
    '{}',
    ago(30 * DAY),
  );
  book.run(
    'blank',
    'ebook',
    tmp,
    'blank.epub',
    'epub',
    'Not Yet Indexed',
    null,
    null,
    '{}',
    ago(30 * DAY),
  );
  // Through the real pipeline, so these sessions are the ingest hook's own.
  const res = await request('/api/progress/events', 'alice', 'POST', {
    events: [
      event('novel', 0.12, 'open', ago(2 * HOUR), 'ebook'),
      event('novel', 0.19, 'heartbeat', ago(2 * HOUR - 5 * 60_000), 'ebook'),
      // A half-hour listen, heartbeats inside the gap all the way to the end.
      event('tape', 0.8, 'open', ago(90 * 60_000), 'audio'),
      event('tape', 0.85, 'heartbeat', ago(82 * 60_000), 'audio'),
      event('tape', 0.9, 'heartbeat', ago(74 * 60_000), 'audio'),
      event('tape', 0.95, 'heartbeat', ago(66 * 60_000), 'audio'),
      event('tape', 1, 'finish', finishAt, 'audio'),
    ],
  });
  expect(res.statusCode).toBe(200);
  // Older history, written directly: a book that has since left the library,
  // and one the reader opened ten days ago that has not been indexed.
  insertSession.run(alice, 'gone', 'ebook', goneStart, goneEnd);
  insertSession.run(alice, 'blank', 'ebook', ago(10 * DAY), blankEnd);
  // More sittings than one answer carries, for bob, all inside the window.
  db.exec('BEGIN');
  for (let i = 0; i < 3001; i++) {
    insertSession.run(
      bob,
      'novel',
      'ebook',
      ago((i + 1) * 5 * 60_000 + 60_000),
      ago((i + 1) * 5 * 60_000),
    );
  }
  db.exec('COMMIT');
});

afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/stats', () => {
  it('answers the documented shape: sessions newest first, their books, all-time totals', async () => {
    const body = await stats();
    expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
    expect(body.since).toBe(statsWindowStart(new Date(body.generatedAt), 90).toISOString());
    expect(body.since.endsWith('T00:00:00.000Z')).toBe(true);
    expect('truncated' in body).toBe(false);

    expect(body.sessions.map((s) => s.bookId)).toEqual(['tape', 'novel', 'blank']);
    const novel = body.sessions[1]!;
    expect(novel).toEqual({
      id: expect.any(Number),
      bookId: 'novel',
      medium: 'ebook',
      deviceId: 'phone',
      startedAt: ago(2 * HOUR),
      endedAt: ago(2 * HOUR - 5 * 60_000),
      seconds: 300,
      pctStart: 0.12,
      pctEnd: 0.19,
      pctAdvanced: expect.closeTo(0.07, 10),
    });
    expect(body.sessions[0]).toMatchObject({
      bookId: 'tape',
      medium: 'audio',
      seconds: 1800,
      pctEnd: 1,
    });

    expect(Object.keys(body.books).sort()).toEqual(['blank', 'novel', 'tape']);
    expect(body.books.novel).toEqual({
      id: 'novel',
      title: 'The Novel',
      author: 'A. Writer',
      kind: 'ebook',
      totalChars: 412000,
      durationMs: null,
      pct: 0.19,
      finished: false,
      finishedAt: null,
      lastReadAt: novel.endedAt,
    });
    expect(body.books.tape).toEqual({
      id: 'tape',
      title: 'The Tape',
      author: 'A. Narrator',
      kind: 'audio',
      totalChars: null,
      durationMs: 36_000_000,
      pct: 1,
      finished: true,
      finishedAt: finishAt,
      lastReadAt: finishAt,
    });
    // Never indexed, never had a position saved: known to be an ebook, nothing more.
    expect(body.books.blank).toMatchObject({
      title: 'Not Yet Indexed',
      author: null,
      totalChars: null,
      pct: 0,
      finished: false,
      finishedAt: null,
      lastReadAt: blankEnd,
    });

    expect(body.allTime).toEqual({
      seconds: 300 + 1800 + 1800 + 600,
      sessions: 4,
      firstSessionAt: goneStart,
      booksFinished: 1,
    });
  });

  it('a wider window reaches a book that has since left the library', async () => {
    const body = await stats('?days=365');
    expect(body.sessions.map((s) => s.bookId)).toEqual(['tape', 'novel', 'blank', 'gone']);
    expect(body.books.gone).toEqual({
      id: 'gone',
      title: null,
      author: null,
      kind: 'ebook',
      totalChars: null,
      durationMs: null,
      pct: 0,
      finished: false,
      finishedAt: null,
      lastReadAt: goneEnd,
    });
    // All-time numbers do not move with the window.
    expect(body.allTime.sessions).toBe(4);
  });

  it('a narrow window keeps only what ended inside it', async () => {
    const body = await stats('?days=1');
    expect(body.sessions.map((s) => s.bookId)).toEqual(['tape', 'novel']);
    expect(Object.keys(body.books).sort()).toEqual(['novel', 'tape']);
    expect(body.allTime.sessions).toBe(4);
  });

  it('refuses a window it cannot honour', async () => {
    for (const days of ['0', '366', 'abc', '1.5', '']) {
      const res = await request(`/api/stats?days=${days}`);
      expect(res.statusCode, `days=${days}`).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid' });
    }
  });

  it('caps the sessions at 3000, keeps the newest and says so', async () => {
    const body = await stats('', 'bob');
    expect(body.truncated).toBe(true);
    expect(body.sessions).toHaveLength(3000);
    expect(body.sessions[0]!.startedAt).toBe(ago(6 * 60_000));
    expect(body.sessions[2999]!.startedAt).toBe(ago(3000 * 5 * 60_000 + 60_000));
    // Only the caller's own diary, and a book they never saved a position in.
    expect(Object.keys(body.books)).toEqual(['novel']);
    expect(body.books.novel).toMatchObject({ title: 'The Novel', pct: 0, finished: false });
    expect(body.allTime).toEqual({
      seconds: 3001 * 60,
      sessions: 3001,
      firstSessionAt: ago(3001 * 5 * 60_000 + 60_000),
      booksFinished: 0,
    });
  });

  it("is nobody's business but the caller's", async () => {
    expect((await request('/api/stats', null)).statusCode).toBe(401);
    const body = await stats('?days=365', 'carol');
    expect(body.sessions).toEqual([]);
    expect(body.books).toEqual({});
    expect(body.allTime).toEqual({
      seconds: 0,
      sessions: 0,
      firstSessionAt: null,
      booksFinished: 0,
    });
  });
});
