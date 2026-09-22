import { beforeEach, describe, expect, it } from 'vitest';
import { type ProgressEvent } from '@readport/shared';
import { openMemoryDatabase, type DB } from '../db/index.js';
import { applyProgressEvents, resetProgress } from '../progress/service.js';
import { prepareSessionFolder, SESSION_GAP_MS } from './sessions.js';

/**
 * The diary behind the stats page. Every accepted progress event is one more
 * moment of a sitting; these tests are about where one sitting ends and the
 * next begins, and about what a sitting remembers.
 */

let db: DB;
let seq = 0;
const uid = 'reader';
/** A fixed evening in the past: clamping only bites on times in the future. */
const T0 = Date.parse('2026-01-10T20:00:00.000Z');
const MIN = 60_000;
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

interface Row {
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
const sessions = (): Row[] =>
  db
    .prepare(
      `SELECT book_id AS bookId, medium, device_id AS deviceId, started_at AS startedAt,
              ended_at AS endedAt, pct_start AS pctStart, pct_end AS pctEnd,
              pct_advanced AS pctAdvanced, events
         FROM reading_sessions WHERE user_id = ? ORDER BY started_at, id`,
    )
    .all(uid) as unknown as Row[];

function ev(offsetMs: number, pct: number, over: Partial<ProgressEvent> = {}): ProgressEvent {
  seq += 1;
  return {
    eventId: crypto.randomUUID(),
    bookId: 'book',
    deviceId: 'phone',
    sessionId: 'tab',
    seq,
    occurredAt: at(offsetMs),
    intent: 'heartbeat',
    locator: { medium: 'ebook', spineIdx: 0, charOffset: 0, pct },
    ...over,
  };
}
const apply = (events: ProgressEvent[], skewMs?: number) =>
  applyProgressEvents(db, uid, events, { skewMs });

beforeEach(() => {
  db = openMemoryDatabase();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'h', 'reader', ?)`,
  ).run(uid, uid, at(0));
  seq = 0;
});

describe('folding accepted events into sittings', () => {
  it('two events within the gap are one sitting', () => {
    apply([ev(0, 0.1, { intent: 'open' }), ev(5 * MIN, 0.12)]);
    const [s, ...rest] = sessions();
    expect(rest).toEqual([]);
    expect(s).toMatchObject({
      bookId: 'book',
      medium: 'ebook',
      deviceId: 'phone',
      startedAt: at(0),
      endedAt: at(5 * MIN),
      pctStart: 0.1,
      pctEnd: 0.12,
      events: 2,
    });
    expect(s!.pctAdvanced).toBeCloseTo(0.02, 10);
  });

  it('an event past the gap begins a new sitting; one exactly at the gap does not', () => {
    apply([ev(0, 0.1, { intent: 'open' }), ev(SESSION_GAP_MS, 0.11)]);
    expect(sessions()).toHaveLength(1);
    apply([ev(2 * SESSION_GAP_MS + 1, 0.12)]);
    const rows = sessions();
    expect(rows.map((r) => [r.startedAt, r.endedAt, r.events])).toEqual([
      [at(0), at(SESSION_GAP_MS), 2],
      [at(2 * SESSION_GAP_MS + 1), at(2 * SESSION_GAP_MS + 1), 1],
    ]);
    expect(rows[1]).toMatchObject({ pctStart: 0.12, pctEnd: 0.12, pctAdvanced: 0 });
  });

  it('going back adds time but not distance', () => {
    apply([ev(0, 0.5, { intent: 'open' }), ev(1 * MIN, 0.3, { intent: 'seek' }), ev(3 * MIN, 0.4)]);
    const [s, ...rest] = sessions();
    expect(rest).toEqual([]);
    expect(s).toMatchObject({
      startedAt: at(0),
      endedAt: at(3 * MIN),
      pctStart: 0.5,
      pctEnd: 0.4,
      events: 3,
    });
    expect(s!.pctAdvanced).toBeCloseTo(0.1, 10);
  });

  it('jumping ahead moves the position but is not ground covered', () => {
    // Half a book in a minute is the contents page, not reading; the page
    // and a half after it is.
    apply([
      ev(0, 0.1, { intent: 'open' }),
      ev(1 * MIN, 0.6, { intent: 'seek' }),
      ev(2 * MIN, 0.61),
    ]);
    const [s, ...rest] = sessions();
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ pctStart: 0.1, pctEnd: 0.61, events: 3 });
    expect(s!.pctAdvanced).toBeCloseTo(0.01, 10);
  });

  it('a page turned a moment after the last event still counts', () => {
    apply([ev(0, 0.1, { intent: 'open' }), ev(500, 0.115, { intent: 'page' })]);
    expect(sessions()[0]!.pctAdvanced).toBeCloseTo(0.015, 10);
  });

  it('an event the pipeline does not apply leaves the diary alone', () => {
    apply([ev(0, 0.1, { intent: 'open' })]);
    // Another tab takes the claim; the first tab's later heartbeat is
    // recorded, not applied - and so never folded.
    apply([ev(1 * MIN, 0.2, { intent: 'seek', sessionId: 'other-tab' })]);
    const ack = apply([ev(2 * MIN, 0.3)]);
    expect(ack.results[0]).toMatchObject({ status: 'recorded', reason: 'unclaimed-session' });
    const [s, ...rest] = sessions();
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ endedAt: at(1 * MIN), pctEnd: 0.2, events: 2 });
  });

  it('a sitting is timed by the corrected clock, not the raw client one', () => {
    const hour = 60 * MIN;
    apply([ev(0, 0.1, { intent: 'open' }), ev(5 * MIN, 0.2)], hour);
    expect(sessions()[0]).toMatchObject({ startedAt: at(hour), endedAt: at(hour + 5 * MIN) });
  });

  it('finishing closes the sitting like any other event', () => {
    apply([ev(0, 0.9, { intent: 'open' }), ev(3 * MIN, 1, { intent: 'finish' })]);
    const [s, ...rest] = sessions();
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ endedAt: at(3 * MIN), pctEnd: 1, events: 2 });
    expect(s!.pctAdvanced).toBeCloseTo(0.1, 10);
  });

  it('another device is another sitting, and so is another medium', () => {
    apply([
      ev(0, 0.1, { intent: 'open' }),
      ev(1 * MIN, 0.1, { intent: 'open', deviceId: 'laptop', sessionId: 'laptop-tab' }),
      ev(2 * MIN, 0.1, {
        intent: 'open',
        locator: { medium: 'audio', trackIdx: 0, positionMs: 0, pct: 0.1 },
      }),
    ]);
    expect(sessions().map((s) => [s.deviceId, s.medium, s.events])).toEqual([
      ['phone', 'ebook', 1],
      ['laptop', 'ebook', 1],
      ['phone', 'audio', 1],
    ]);
  });

  it('a reset erases the position, not the history of having read', () => {
    apply([ev(0, 0.1, { intent: 'open' }), ev(5 * MIN, 0.2)]);
    const generation = resetProgress(db, uid, 'book');
    expect(sessions()).toHaveLength(1);
    // Reading again afterwards is a new sitting in the same diary.
    apply([ev(60 * MIN, 0, { intent: 'open', generation })]);
    expect(sessions().map((s) => s.events)).toEqual([2, 1]);
  });

  it('an older event the pipeline still accepts extends the sitting backwards', () => {
    // A device that read the current revision acts causally later even when
    // its clock says otherwise; that is what lets an older event through.
    const first = apply([ev(30 * MIN, 0.3, { intent: 'seek' })]);
    apply([ev(25 * MIN, 0.25, { intent: 'seek', baseRevision: first.state!.revision })]);
    const [s, ...rest] = sessions();
    expect(rest).toEqual([]);
    expect(s).toMatchObject({
      startedAt: at(25 * MIN),
      endedAt: at(30 * MIN),
      pctStart: 0.25,
      pctEnd: 0.3,
      events: 2,
    });
    expect(s!.pctAdvanced).toBeCloseTo(0.05, 10);
  });
});

describe('replay order', () => {
  const fold = (offsetMs: number, pct: number) =>
    prepareSessionFolder(db).fold(uid, 'book', 'ebook', 'phone', at(offsetMs), pct);

  it('a backlog replayed behind the position that ended it stays one sitting', () => {
    // The unload beacon delivered the sitting's last position first...
    expect(fold(30 * MIN, 0.3)).toBe('new');
    // ...and its earlier events follow in order, one a minute.
    const outcomes = Array.from({ length: 30 }, (_, minute) => fold(minute * MIN, minute / 100));
    // Half an hour before the only sitting known: too far to join it.
    expect(outcomes[0]).toBe('new');
    expect(outcomes.slice(1, 20).every((o) => o === 'extended')).toBe(true);
    // Minute twenty is within the gap of both halves: they were one sitting.
    expect(outcomes[20]).toBe('merged');
    expect(outcomes.slice(21).every((o) => o === 'inside')).toBe(true);
    const [s, ...rest] = sessions();
    expect(rest).toEqual([]);
    expect(s).toMatchObject({
      startedAt: at(0),
      endedAt: at(30 * MIN),
      pctStart: 0,
      pctEnd: 0.3,
      events: 31,
    });
    expect(s!.pctAdvanced).toBeCloseTo(0.3, 10);
  });

  it("an event inside a sitting's span is one more event and nothing else", () => {
    fold(0, 0.1);
    fold(5 * MIN, 0.2);
    expect(fold(2 * MIN, 0.9)).toBe('inside');
    const [s] = sessions();
    expect(s).toMatchObject({ startedAt: at(0), endedAt: at(5 * MIN), pctEnd: 0.2, events: 3 });
    expect(s!.pctAdvanced).toBeCloseTo(0.1, 10);
  });

  it("an older event within the gap of a sitting's start moves the start back", () => {
    fold(20 * MIN, 0.2);
    expect(fold(15 * MIN, 0.15)).toBe('extended-back');
    // Beyond the gap of that start it is its own sitting, even though the
    // sitting it precedes is the only one there is.
    expect(fold(4 * MIN, 0.05)).toBe('new');
    expect(sessions().map((s) => [s.startedAt, s.endedAt, s.events])).toEqual([
      [at(4 * MIN), at(4 * MIN), 1],
      [at(15 * MIN), at(20 * MIN), 2],
    ]);
    expect(sessions()[1]!.pctAdvanced).toBeCloseTo(0.05, 10);
  });
});
