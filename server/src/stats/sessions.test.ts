import { beforeEach, describe, expect, it } from 'vitest';
import { type ProgressEvent } from '@readport/shared';
import { openMemoryDatabase, type DB } from '../db/index.js';
import { applyProgressEvents, resetProgress } from '../progress/service.js';
import {
  ACTIVE_STEP_CAP_MS,
  prepareSessionFolder,
  REREAD_JITTER_PCT,
  REREAD_MAX_PCT,
  SESSION_GAP_MS,
} from './sessions.js';

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
  activeMs: number | null;
  rereads: number;
  rereadPct: number;
}
const sessions = (): Row[] =>
  db
    .prepare(
      `SELECT book_id AS bookId, medium, device_id AS deviceId, started_at AS startedAt,
              ended_at AS endedAt, pct_start AS pctStart, pct_end AS pctEnd,
              pct_advanced AS pctAdvanced, events, active_ms AS activeMs,
              rereads, reread_pct AS rereadPct
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
      // A fifth of the book back is a chapter picked, not a page re-read.
      rereads: 0,
      rereadPct: 0,
    });
    expect(s!.pctAdvanced).toBeCloseTo(0.1, 10);
  });

  it('a page left open counts what a page can hold, not the clock', () => {
    // A page turned, nine minutes away from the device, the next page: the
    // sitting is still one sitting - nine minutes is inside the gap - and
    // it ran nine minutes by the clock, but only five of them were reading.
    apply([ev(0, 0.1, { intent: 'open' }), ev(9 * MIN, 0.115, { intent: 'page' })]);
    const [s] = sessions();
    expect(s).toMatchObject({ startedAt: at(0), endedAt: at(9 * MIN), events: 2 });
    expect(s!.activeMs).toBe(ACTIVE_STEP_CAP_MS.ebook);
    // Three pages in three minutes: every step counts in full.
    apply([ev(10 * MIN, 0.12, { intent: 'page' }), ev(11 * MIN, 0.125, { intent: 'page' })]);
    expect(sessions()[0]!.activeMs).toBe(ACTIVE_STEP_CAP_MS.ebook + 2 * MIN);
  });

  it('a pause in the narration is not listening', () => {
    const audio = (offsetMs: number, pct: number) =>
      ev(offsetMs, pct, {
        bookId: 'tape',
        locator: { medium: 'audio', trackIdx: 0, positionMs: 0, pct },
      });
    // Heartbeats every fifteen seconds while it plays, then four minutes of
    // silence, then it plays on: the silence counts as one heartbeat's worth.
    apply([
      { ...audio(0, 0.1), intent: 'open' },
      audio(15_000, 0.101),
      audio(30_000, 0.102),
      audio(4 * MIN + 30_000, 0.103),
    ]);
    const [s] = sessions();
    expect(s).toMatchObject({ bookId: 'tape', medium: 'audio', events: 4 });
    expect(s!.activeMs).toBe(15_000 + 15_000 + ACTIVE_STEP_CAP_MS.audio);
  });

  it('a sitting from before active time was kept stays measured by the clock', () => {
    db.prepare(
      `INSERT INTO reading_sessions
         (user_id, book_id, medium, device_id, started_at, ended_at, pct_start, pct_end, pct_advanced, events, active_ms)
       VALUES (?, 'book', 'ebook', 'phone', ?, ?, 0.1, 0.2, 0.1, 3, NULL)`,
    ).run(uid, at(0), at(5 * MIN));
    apply([ev(7 * MIN, 0.21)]);
    const [s] = sessions();
    expect(s).toMatchObject({ endedAt: at(7 * MIN), events: 4, activeMs: null });
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

describe('going back a little', () => {
  const audio = (offsetMs: number, pct: number, over: Partial<ProgressEvent> = {}) =>
    ev(offsetMs, pct, {
      bookId: 'tape',
      locator: { medium: 'audio', trackIdx: 0, positionMs: 0, pct },
      ...over,
    });

  it('a page back is a re-read: counted and measured, and still not ground covered', () => {
    apply([
      ev(0, 0.3, { intent: 'open' }),
      ev(1 * MIN, 0.31, { intent: 'page' }),
      // A page and a half back, for the thread; then on again.
      ev(2 * MIN, 0.295, { intent: 'seek' }),
      ev(3 * MIN, 0.305, { intent: 'page' }),
    ]);
    const [s, ...rest] = sessions();
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ events: 4, rereads: 1 });
    expect(s!.rereadPct).toBeCloseTo(0.015, 10);
    // Distance is what it always was: the two forward steps, nothing for the one back.
    expect(s!.pctAdvanced).toBeCloseTo(0.02, 10);
  });

  it('further back than a page or two is navigation, not a re-read', () => {
    // Three percent of the book is where the chapter began, picked from the
    // contents; the rule does not know why, only that no page is that long.
    apply([ev(0, 0.5, { intent: 'open' }), ev(1 * MIN, 0.47, { intent: 'seek' })]);
    expect(sessions()[0]).toMatchObject({ events: 2, rereads: 0, rereadPct: 0 });
    expect(0.5 - 0.47).toBeGreaterThan(REREAD_MAX_PCT.ebook);
  });

  it('a few lines of jitter are not a step back', () => {
    // A scroll settling a paragraph up, twice: a fiftieth of a percent each.
    apply([ev(0, 0.3, { intent: 'open' }), ev(1 * MIN, 0.2998), ev(2 * MIN, 0.2996)]);
    expect(sessions()[0]).toMatchObject({ events: 3, rereads: 0, rereadPct: 0 });
    expect(0.3 - 0.2998).toBeLessThan(REREAD_JITTER_PCT);
  });

  it('skip-backs in a narration are re-reads; a chapter back is not', () => {
    apply([
      audio(0, 0.5, { intent: 'open' }),
      audio(15_000, 0.501),
      // The fifteen-second button, twice in a row: a third of a percent each.
      audio(30_000, 0.498, { intent: 'seek' }),
      audio(32_000, 0.495, { intent: 'seek' }),
      audio(47_000, 0.496),
      // Then a tenth of the book back: the chapter list, not the thread.
      audio(60_000, 0.4, { intent: 'seek' }),
    ]);
    const [s, ...rest] = sessions();
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ bookId: 'tape', medium: 'audio', events: 6, rereads: 2 });
    expect(s!.rereadPct).toBeCloseTo(0.006, 10);
  });

  it('a page or two is measured in the medium', () => {
    // The same step back - under two percent, over one and a half - is a
    // page of an ebook and a chapter's worth of narration.
    apply([ev(0, 0.5, { intent: 'open' }), ev(1 * MIN, 0.482, { intent: 'seek' })]);
    apply([audio(0, 0.5, { intent: 'open' }), audio(1 * MIN, 0.482, { intent: 'seek' })]);
    expect(sessions().map((s) => [s.medium, s.rereads])).toEqual([
      ['ebook', 1],
      ['audio', 0],
    ]);
  });

  it('a sitting from before re-reads were kept reads zero, and counts from there', () => {
    db.prepare(
      `INSERT INTO reading_sessions
         (user_id, book_id, medium, device_id, started_at, ended_at, pct_start, pct_end, pct_advanced, events, active_ms)
       VALUES (?, 'book', 'ebook', 'phone', ?, ?, 0.1, 0.2, 0.1, 3, 120000)`,
    ).run(uid, at(0), at(5 * MIN));
    expect(sessions()[0]).toMatchObject({ events: 3, rereads: 0, rereadPct: 0 });
    apply([ev(7 * MIN, 0.19)]);
    const [s] = sessions();
    expect(s).toMatchObject({ endedAt: at(7 * MIN), events: 4, rereads: 1 });
    expect(s!.rereadPct).toBeCloseTo(0.01, 10);
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
      // One event a minute counts in full up to the merge; the merge itself
      // bridges minute twenty to minute thirty in one step, and a step is
      // capped like any other. The events that then land inside the span
      // add nothing - the fold keeps no memory of what came between - so a
      // backlog delivered last-first can leave a sitting short by at most
      // one cap. That is the price of never counting a pause as reading.
      activeMs: 19 * MIN + MIN + ACTIVE_STEP_CAP_MS.ebook,
    });
    expect(s!.pctAdvanced).toBeCloseTo(0.3, 10);
  });

  it("an event inside a sitting's span is one more event and nothing else", () => {
    fold(0, 0.1);
    fold(5 * MIN, 0.2);
    expect(fold(2 * MIN, 0.9)).toBe('inside');
    const [s] = sessions();
    expect(s).toMatchObject({
      startedAt: at(0),
      endedAt: at(5 * MIN),
      pctEnd: 0.2,
      events: 3,
      rereads: 0,
    });
    expect(s!.pctAdvanced).toBeCloseTo(0.1, 10);
  });

  it('the counters survive a merge, and the bridging event can be a step back itself', () => {
    // The unload beacon delivered the sitting's end first, a page back in it...
    expect(fold(30 * MIN, 0.2)).toBe('new');
    expect(fold(35 * MIN, 0.19)).toBe('extended');
    // ...then its start arrived, with a page back of its own...
    expect(fold(0, 0.1)).toBe('new');
    expect(fold(5 * MIN, 0.12)).toBe('extended');
    expect(fold(10 * MIN, 0.11)).toBe('extended');
    // ...and the event that joins the halves steps half a page back into the later one.
    expect(fold(20 * MIN, 0.205)).toBe('merged');
    const [s, ...rest] = sessions();
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ startedAt: at(0), endedAt: at(35 * MIN), events: 6, rereads: 3 });
    expect(s!.rereadPct).toBeCloseTo(0.025, 10);
    expect(s!.pctAdvanced).toBeCloseTo(0.115, 10);
  });

  it('a step back replayed behind its sitting is still a step back', () => {
    fold(20 * MIN, 0.2);
    expect(fold(15 * MIN, 0.21)).toBe('extended-back');
    const [s] = sessions();
    expect(s).toMatchObject({ startedAt: at(15 * MIN), pctStart: 0.21, pctEnd: 0.2, rereads: 1 });
    expect(s!.rereadPct).toBeCloseTo(0.01, 10);
    expect(s!.pctAdvanced).toBe(0);
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
