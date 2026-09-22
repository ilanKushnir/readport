import { describe, expect, it } from 'vitest';
import { type ProgressEvent } from '@readport/shared';
import { openMemoryDatabase, type DB } from '../db/index.js';
import { applyProgressEvents } from '../progress/service.js';
import { backfillReadingSessions } from './backfill.js';

/**
 * Deriving the diary for the reading that happened before the diary existed.
 */

const T0 = Date.parse('2026-01-10T20:00:00.000Z');
const MIN = 60_000;
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const quiet = { info: () => {} };

interface Row {
  userId: string;
  bookId: string;
  medium: string;
  deviceId: string;
  startedAt: string;
  endedAt: string;
  pctStart: number;
  pctEnd: number;
  pctAdvanced: number;
  events: number;
}
const sessions = (db: DB): Row[] =>
  db
    .prepare(
      `SELECT user_id AS userId, book_id AS bookId, medium, device_id AS deviceId,
              started_at AS startedAt, ended_at AS endedAt, pct_start AS pctStart,
              pct_end AS pctEnd, pct_advanced AS pctAdvanced, events
         FROM reading_sessions ORDER BY user_id, book_id, device_id, medium, started_at`,
    )
    .all() as unknown as Row[];
const count = (db: DB): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM reading_sessions').get() as { c: number }).c;

function fresh(): DB {
  const db = openMemoryDatabase();
  const user = db.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'h', 'reader', ?)`,
  );
  user.run('ann', 'ann', at(0));
  user.run('ben', 'ben', at(0));
  return db;
}

let n = 0;
/** One row of history, as the pipeline would have left it. */
function history(
  db: DB,
  row: {
    user: string;
    book?: string;
    device?: string;
    medium?: 'ebook' | 'audio';
    pct: number;
    at: number;
    intent?: string;
    rejected?: boolean;
    /** From before effective_at existed: only the raw client time is there. */
    legacy?: boolean;
  },
): void {
  n += 1;
  const medium = row.medium ?? 'audio';
  const occurred = at(row.at);
  db.prepare(
    `INSERT INTO progress_events
       (user_id, book_id, event_id, device_id, session_uuid, seq, intent, medium, locator_json,
        occurred_at, effective_at, received_at, applied, reject_reason)
     VALUES (?, ?, ?, ?, 'sess', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.user,
    row.book ?? 'book',
    `fixture-${n}`,
    row.device ?? 'phone',
    n,
    row.intent ?? 'heartbeat',
    medium,
    JSON.stringify({ medium, trackIdx: 0, positionMs: 0, pct: row.pct }),
    occurred,
    row.legacy ? null : occurred,
    at(row.at + 1000),
    row.rejected ? 0 : 1,
    row.rejected ? 'stale-heartbeat' : null,
  );
}

/**
 * Two people's history. Ann listened to `book` on her phone in two sittings
 * half an hour apart (one row of the first rejected, one of the second from
 * before effective_at existed), touched it once from a laptop, and read
 * `other` on the phone; Ben opened `book` once. A row for a user who no
 * longer exists sits among them. Rows are written out of time order on
 * purpose.
 */
function seed(db: DB): void {
  history(db, { user: 'ann', pct: 0.12, at: 2 * MIN });
  history(db, { user: 'ann', pct: 0.1, at: 0, intent: 'open' });
  history(db, { user: 'ann', pct: 0.11, at: 1 * MIN });
  history(db, { user: 'ann', pct: 0.99, at: 3 * MIN, rejected: true });
  history(db, { user: 'ann', pct: 0.5, at: 30 * MIN, intent: 'seek', legacy: true });
  history(db, { user: 'ann', pct: 0.51, at: 31 * MIN });
  history(db, { user: 'ann', pct: 0.51, at: 31 * MIN, device: 'laptop', intent: 'open' });
  history(db, { user: 'ann', book: 'other', medium: 'ebook', pct: 0.2, at: 0, intent: 'open' });
  history(db, { user: 'ann', book: 'other', medium: 'ebook', pct: 0.3, at: 4 * MIN });
  history(db, { user: 'ben', pct: 0.05, at: 0, intent: 'open' });
  history(db, { user: 'ghost', pct: 0.4, at: 0, intent: 'open' });
}

describe('backfillReadingSessions', () => {
  it('derives one sitting per gap, book, device and person, from applied rows only', () => {
    const db = fresh();
    seed(db);
    const lines: string[] = [];
    expect(backfillReadingSessions(db, { info: (m) => lines.push(m) })).toBe(5);
    expect(lines).toEqual(['Derived 5 reading sessions from 9 progress events of 2 people']);
    const rows = sessions(db);
    expect(
      rows.map((r) => [r.userId, r.bookId, r.deviceId, r.medium, r.startedAt, r.endedAt, r.events]),
    ).toEqual([
      ['ann', 'book', 'laptop', 'audio', at(31 * MIN), at(31 * MIN), 1],
      ['ann', 'book', 'phone', 'audio', at(0), at(2 * MIN), 3],
      ['ann', 'book', 'phone', 'audio', at(30 * MIN), at(31 * MIN), 2],
      ['ann', 'other', 'phone', 'ebook', at(0), at(4 * MIN), 2],
      ['ben', 'book', 'phone', 'audio', at(0), at(0), 1],
    ]);
    // Rows written out of order were still folded in time order: the first
    // sitting runs 0.10 -> 0.12 rather than starting at minute two.
    expect(rows[1]).toMatchObject({ pctStart: 0.1, pctEnd: 0.12 });
    expect(rows[1]!.pctAdvanced).toBeCloseTo(0.02, 10);
    expect(rows[2]!.pctAdvanced).toBeCloseTo(0.01, 10);
  });

  it('runs once: a second start derives nothing and duplicates nothing', () => {
    const db = fresh();
    seed(db);
    backfillReadingSessions(db, quiet);
    expect(backfillReadingSessions(db, quiet)).toBe(0);
    expect(count(db)).toBe(5);
  });

  it('leaves a diary that already has entries alone', () => {
    const db = fresh();
    seed(db);
    db.prepare(
      `INSERT INTO reading_sessions (user_id, book_id, medium, device_id, started_at, ended_at, pct_start, pct_end)
       VALUES ('ann', 'book', 'audio', 'phone', ?, ?, 0, 0)`,
    ).run(at(0), at(0));
    expect(backfillReadingSessions(db, quiet)).toBe(0);
    expect(count(db)).toBe(1);
  });

  it('says nothing on a library with no history', () => {
    const db = fresh();
    const lines: string[] = [];
    expect(backfillReadingSessions(db, { info: (m) => lines.push(m) })).toBe(0);
    expect(lines).toEqual([]);
    expect(count(db)).toBe(0);
  });

  it('derives exactly what the ingest hook wrote', () => {
    // The same stream through the live pipeline, then through the backfill
    // from the history that pipeline left: the diary must come out the same.
    const db = fresh();
    let seq = 0;
    const ev = (
      offsetMs: number,
      pct: number,
      intent: ProgressEvent['intent'],
      over: Partial<ProgressEvent> = {},
    ): ProgressEvent => ({
      eventId: crypto.randomUUID(),
      bookId: 'book',
      deviceId: 'phone',
      sessionId: 'tab',
      seq: ++seq,
      occurredAt: at(offsetMs),
      intent,
      locator: { medium: 'audio', trackIdx: 0, positionMs: 0, pct },
      ...over,
    });
    applyProgressEvents(db, 'ann', [
      ev(0, 0.1, 'open'),
      ev(1 * MIN, 0.12, 'heartbeat'),
      ev(2 * MIN, 0.14, 'heartbeat'),
      ev(3 * MIN, 0.05, 'seek'),
      ev(4 * MIN, 0.07, 'heartbeat'),
      ev(30 * MIN, 0.07, 'open'),
      ev(31 * MIN, 0.09, 'heartbeat'),
      ev(32 * MIN, 0.09, 'open', { deviceId: 'laptop', sessionId: 'laptop-tab' }),
      // The phone's tab lost the claim to the laptop: recorded, never applied.
      ev(33 * MIN, 0.2, 'heartbeat'),
      ev(40 * MIN, 0.5, 'open', {
        bookId: 'other',
        locator: { medium: 'ebook', spineIdx: 3, charOffset: 10, pct: 0.5 },
      }),
      ev(45 * MIN, 1, 'finish', {
        bookId: 'other',
        locator: { medium: 'ebook', spineIdx: 9, charOffset: 0, pct: 1 },
      }),
    ]);
    const live = sessions(db);
    expect(live).toHaveLength(4);
    db.exec('DELETE FROM reading_sessions');
    expect(backfillReadingSessions(db, quiet)).toBe(4);
    expect(sessions(db)).toEqual(live);
  });
});
