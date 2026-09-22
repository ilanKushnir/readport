import { describe, expect, it } from 'vitest';
import {
  bestWindow,
  bookInsights,
  dailyTotals,
  focusByHour,
  focusByWeekday,
  focusIndex,
  focusModel,
  heatmap,
  hourBuckets,
  inLastDays,
  localDay,
  readiness,
  sliceByHour,
  streak,
  summarise,
  weekdayIndex,
  type StatsBook,
  type StatsResponse,
  type StatsSession,
} from './insights';

let nextId = 1;
/** A sitting at a LOCAL wall-clock time, so the tests mean what they say in any zone. */
function sitting(
  localStart: string,
  minutes: number,
  extra: Partial<StatsSession> = {},
): StatsSession {
  const start = new Date(localStart);
  const end = new Date(start.getTime() + minutes * 60_000);
  return {
    id: nextId++,
    bookId: 'b1',
    medium: 'ebook',
    deviceId: 'd',
    startedAt: start.toISOString(),
    endedAt: end.toISOString(),
    seconds: minutes * 60,
    pctStart: 0,
    pctEnd: 0.01 * minutes,
    pctAdvanced: 0.01 * minutes,
    ...extra,
  };
}

describe('sliceByHour', () => {
  it('cuts a sitting at every local hour boundary and shares time and distance by proportion', () => {
    const slices = sliceByHour(sitting('2026-09-21T22:40:00', 90));
    expect(slices.map((s) => [s.hour, Math.round(s.seconds / 60)])).toEqual([
      [22, 20],
      [23, 60],
      [0, 10],
    ]);
    expect(slices[2]!.day).toBe('2026-09-22');
    const pct = slices.reduce((a, s) => a + s.pctAdvanced, 0);
    expect(pct).toBeCloseTo(0.9, 6);
  });

  it('credits a zero-length sitting to the hour it happened in', () => {
    const s = sitting('2026-09-21T09:15:00', 0, { seconds: 30 });
    const slices = sliceByHour(s);
    expect(slices).toHaveLength(1);
    expect(slices[0]!.hour).toBe(9);
    expect(slices[0]!.seconds).toBe(30);
  });
});

describe('weekdayIndex', () => {
  it('is Monday-first', () => {
    expect(weekdayIndex(new Date('2026-09-21T12:00:00'))).toBe(0); // a Monday
    expect(weekdayIndex(new Date('2026-09-27T12:00:00'))).toBe(6); // the Sunday after
  });
});

describe('dailyTotals', () => {
  it('lists every day in the window, oldest first, with zeroes where nothing happened', () => {
    const rows = dailyTotals(
      [sitting('2026-09-20T08:00:00', 30), sitting('2026-09-22T21:00:00', 45, { medium: 'audio' })],
      new Date('2026-09-19T12:00:00'),
      new Date('2026-09-22T12:00:00'),
    );
    expect(rows.map((r) => [r.day, r.seconds / 60, r.sittings])).toEqual([
      ['2026-09-19', 0, 0],
      ['2026-09-20', 30, 1],
      ['2026-09-21', 0, 0],
      ['2026-09-22', 45, 1],
    ]);
    expect(rows[3]!.listenSeconds).toBe(45 * 60);
    expect(rows[3]!.readSeconds).toBe(0);
  });
});

describe('heatmap', () => {
  it('lands the minutes on the right weekday and hour', () => {
    const grid = heatmap([sitting('2026-09-21T22:40:00', 90)]); // Monday night
    expect(Math.round(grid[0]![22]! / 60)).toBe(20);
    expect(Math.round(grid[0]![23]! / 60)).toBe(60);
    expect(Math.round(grid[1]![0]! / 60)).toBe(10); // spills into Tuesday
  });
});

describe('streak', () => {
  const now = new Date('2026-09-22T10:00:00');
  it('counts consecutive days with at least five minutes, ending today', () => {
    const s = streak(
      [
        sitting('2026-09-20T20:00:00', 12),
        sitting('2026-09-21T20:00:00', 12),
        sitting('2026-09-22T07:00:00', 6),
      ],
      now,
    );
    expect(s).toEqual({ current: 3, longest: 3, today: true });
  });
  it('does not break at breakfast: a run through yesterday is still alive this morning', () => {
    const s = streak([sitting('2026-09-20T20:00:00', 12), sitting('2026-09-21T20:00:00', 12)], now);
    expect(s.current).toBe(2);
    expect(s.today).toBe(false);
  });
  it('ignores a day with only a stray tap', () => {
    const s = streak([sitting('2026-09-21T20:00:00', 2), sitting('2026-09-22T07:00:00', 20)], now);
    expect(s.current).toBe(1);
  });
  it('remembers the longest run even when the current one is over', () => {
    const s = streak(
      [
        sitting('2026-09-01T20:00:00', 10),
        sitting('2026-09-02T20:00:00', 10),
        sitting('2026-09-03T20:00:00', 10),
        sitting('2026-09-03T21:00:00', 10),
        sitting('2026-09-10T20:00:00', 10),
      ],
      now,
    );
    expect(s).toEqual({ current: 0, longest: 3, today: false });
  });
});

describe('hourBuckets and bestWindow', () => {
  it('prefers the hours where sittings are long and pace is high, not just where the minutes are', () => {
    const sessions: StatsSession[] = [];
    // Mornings: many short, slow sittings.
    for (let d = 1; d <= 14; d++) {
      sessions.push(
        sitting(`2026-09-${String(d).padStart(2, '0')}T07:30:00`, 8, { pctAdvanced: 0.02 }),
      );
    }
    // Evenings: fewer, long, fast sittings.
    for (let d = 1; d <= 10; d++) {
      sessions.push(
        sitting(`2026-09-${String(d).padStart(2, '0')}T21:15:00`, 45, { pctAdvanced: 0.3 }),
      );
    }
    const buckets = hourBuckets(sessions);
    expect(buckets[7]!.sittings).toBe(14);
    expect(buckets[21]!.meanSitting).toBeGreaterThan(buckets[7]!.meanSitting);
    expect(buckets[21]!.paceIndex!).toBeGreaterThan(buckets[7]!.paceIndex!);
    const w = bestWindow(buckets)!;
    // Tight: the one hour the evenings actually fall in, not a three-hour
    // window padded with empty ones either side.
    expect([w.from, w.to]).toEqual([21, 22]);
    expect(w.paceIndex!).toBeGreaterThan(1);
  });

  it('returns nothing when there is nothing', () => {
    expect(bestWindow(hourBuckets([]))).toBeNull();
  });

  it('will not call a single long Sunday a habit', () => {
    const sessions = [
      sitting('2026-09-06T15:00:00', 240, { pctAdvanced: 0.5 }),
      ...Array.from({ length: 12 }, (_, i) =>
        sitting(`2026-09-${String(8 + i).padStart(2, '0')}T21:00:00`, 30, { pctAdvanced: 0.1 }),
      ),
    ];
    const w = bestWindow(hourBuckets(sessions))!;
    // The afternoon block holds 40% of all the minutes, but it is ONE
    // sitting; twelve real evenings are the habit.
    expect([w.from, w.to]).toEqual([21, 22]);
  });
});

describe('readiness', () => {
  it('needs fourteen active days and ten sittings before it will recommend anything', () => {
    const few = Array.from({ length: 5 }, (_, i) =>
      sitting(`2026-09-${String(1 + i).padStart(2, '0')}T20:00:00`, 20),
    );
    expect(readiness(few)).toMatchObject({ activeDays: 5, sittings: 5, daysToGo: 9, ready: false });
    const enough = Array.from({ length: 14 }, (_, i) =>
      sitting(`2026-09-${String(1 + i).padStart(2, '0')}T20:00:00`, 20),
    );
    expect(readiness(enough).ready).toBe(true);
    expect(readiness(enough).daysToGo).toBe(0);
  });
});

describe('summarise and bookInsights', () => {
  const books: Record<string, StatsBook> = {
    b1: {
      id: 'b1',
      title: 'A',
      author: null,
      kind: 'ebook',
      totalChars: 600_000,
      durationMs: null,
      pct: 0.5,
      finished: false,
      finishedAt: null,
      lastReadAt: null,
    },
    b2: {
      id: 'b2',
      title: 'B',
      author: null,
      kind: 'audio',
      totalChars: null,
      durationMs: 3_600_000,
      pct: 0.2,
      finished: false,
      finishedAt: null,
      lastReadAt: null,
    },
  };

  it('turns pct into words where the book length is known, and only there', () => {
    const s = summarise(
      [
        sitting('2026-09-20T20:00:00', 30, { pctAdvanced: 0.1 }), // 60,000 chars
        sitting('2026-09-21T20:00:00', 30, { bookId: 'b2', medium: 'audio', pctAdvanced: 0.1 }),
      ],
      books,
    );
    expect(s.readSeconds).toBe(1800);
    expect(s.listenSeconds).toBe(1800);
    expect(s.words).toBe(Math.round(60_000 / 5.7));
    expect(s.wordsPerMinute).toBe(Math.round(60_000 / 5.7 / 30));
    expect(s.activeDays).toBe(2);
  });

  it('estimates time to finish from the pace of recent sittings on that book', () => {
    const data: StatsResponse = {
      generatedAt: '',
      since: '',
      sessions: [
        sitting('2026-09-20T20:00:00', 30, { pctAdvanced: 0.1 }),
        sitting('2026-09-21T20:00:00', 30, { pctAdvanced: 0.1 }),
      ],
      books,
      allTime: { seconds: 0, sessions: 0, firstSessionAt: null, booksFinished: 0 },
    };
    const [b1] = bookInsights(data);
    // Half the book left, at 0.2 per hour -> 2.5 hours.
    expect(b1!.book.id).toBe('b1');
    expect(Math.round(b1!.secondsToFinish! / 60)).toBe(150);
  });

  it('leaves out a book that was only opened and closed again', () => {
    const glanced: Record<string, StatsBook> = {
      ...books,
      b3: { ...books.b1!, id: 'b3', title: 'Glanced at', pct: 0 },
    };
    const data: StatsResponse = {
      generatedAt: '',
      since: '',
      sessions: [
        sitting('2026-09-21T20:00:00', 30, { pctAdvanced: 0.1 }),
        // Twenty seconds at the first page: a tap on the wrong cover.
        sitting('2026-09-22T09:00:00', 0, { bookId: 'b3', seconds: 20, pctAdvanced: 0 }),
      ],
      books: glanced,
      allTime: { seconds: 0, sessions: 0, firstSessionAt: null, booksFinished: 0 },
    };
    expect(bookInsights(data).map((b) => b.book.id)).toEqual(['b1']);
  });

  it('refuses to estimate from too little', () => {
    const data: StatsResponse = {
      generatedAt: '',
      since: '',
      sessions: [sitting('2026-09-20T20:00:00', 3, { pctAdvanced: 0.001 })],
      books,
      allTime: { seconds: 0, sessions: 0, firstSessionAt: null, booksFinished: 0 },
    };
    expect(bookInsights(data)[0]!.secondsToFinish).toBeNull();
  });
});

describe('focus: going back for the thread', () => {
  const now = new Date('2026-09-22T10:00:00'); // a Tuesday
  /** A local wall-clock start on a day of 2026, month and day as numbers. */
  const on = (month: number, day: number, time: string) =>
    `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${time}`;

  it('rates a sitting by re-reads per hour of reading, with a floor under short sittings', () => {
    expect(focusIndex(sitting(on(9, 1, '20:00:00'), 60, { rereads: 2 }))).toBeCloseTo(2, 6);
    expect(focusIndex(sitting(on(9, 1, '20:00:00'), 10, { rereads: 2 }))).toBeCloseTo(12, 6);
    // Two steps back in a thirty-second glance are rated as if it had been
    // five minutes: twenty-four an hour, not two hundred and forty.
    expect(focusIndex(sitting(on(9, 1, '20:00:00'), 0, { seconds: 30, rereads: 2 }))).toBeCloseTo(
      24,
      6,
    );
    // A server from before re-reads were kept sends none: zero, not undefined.
    expect(focusIndex(sitting(on(9, 1, '20:00:00'), 60))).toBe(0);
  });

  it("shares a sitting's re-reads across the hours it spans, the way its time is shared", () => {
    const slices = sliceByHour(sitting(on(9, 21, '22:40:00'), 90, { rereads: 9 }));
    expect(slices.map((s) => Math.round(s.share * 90))).toEqual([20, 60, 10]);
    expect(slices.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 10);
    const hours = focusByHour([sitting(on(9, 21, '22:40:00'), 90, { rereads: 9 })]);
    expect(hours[22]!.rereads).toBeCloseTo(2, 6);
    expect(hours[23]!.rereads).toBeCloseTo(6, 6);
    expect(hours[0]!.rereads).toBeCloseTo(1, 6);
  });

  it('buckets by hour and by weekday exactly as the heatmap does', () => {
    const sessions = [
      sitting(on(9, 21, '22:40:00'), 90, { rereads: 3 }), // Monday night into Tuesday
      sitting(on(9, 19, '09:00:00'), 30, { rereads: 1 }), // Saturday morning
    ];
    const grid = heatmap(sessions);
    const hours = focusByHour(sessions);
    for (let h = 0; h < 24; h++) {
      expect(hours[h]!.seconds).toBeCloseTo(
        grid.reduce((a, row) => a + row[h]!, 0),
        6,
      );
    }
    const weekdays = focusByWeekday(sessions);
    for (let d = 0; d < 7; d++) {
      expect(weekdays[d]!.seconds).toBeCloseTo(
        grid[d]!.reduce((a, b) => a + b, 0),
        6,
      );
    }
    expect(weekdays[1]!.rereads).toBeCloseTo(1 / 3, 6); // Tuesday's ten minutes
    expect(weekdays[5]!.rereads).toBeCloseTo(1, 6);
    // Nowhere near enough to judge: the rates stay null rather than shout.
    expect(hours.every((h) => h.rate === null)).toBe(true);
  });

  it('judges an hour once it holds three sittings and half an hour of reading', () => {
    const two = [
      sitting(on(9, 1, '21:00:00'), 40, { rereads: 1 }),
      sitting(on(9, 2, '21:00:00'), 40, { rereads: 1 }),
    ];
    expect(focusByHour(two)[21]!.rate).toBeNull();
    const three = [...two, sitting(on(9, 3, '21:00:00'), 40, { rereads: 1 })];
    expect(focusByHour(three)[21]!.rate).toBeCloseTo(1.5, 6);
    // Three sittings that add up to nine minutes are still not evidence.
    const brief = Array.from({ length: 3 }, (_, i) =>
      sitting(on(9, 1 + i, '08:00:00'), 3, { rereads: 1 }),
    );
    expect(focusByHour(brief)[8]!.rate).toBeNull();
  });

  it('tells the steady hours from the rest, relative to the reader alone', () => {
    const sessions: StatsSession[] = [];
    // Mornings: twenty minutes, three steps back each - nine an hour.
    for (let d = 1; d <= 14; d++) sessions.push(sitting(on(9, d, '07:30:00'), 20, { rereads: 3 }));
    // Evenings: forty minutes, one step back each - one and a half an hour.
    for (let d = 1; d <= 14; d++) sessions.push(sitting(on(9, d, '21:10:00'), 40, { rereads: 1 }));
    const m = focusModel(sessions, now);
    expect(m.ready).toBe(true);
    expect(m.sittingsWithRereads).toBe(28);
    expect(m.rereads).toBe(56);
    // Fifty-six steps back in fourteen hours of reading.
    expect(m.rate).toBeCloseTo(4, 6);
    expect(m.hours[7]!.rate).toBeCloseTo(9, 6);
    expect(m.hours[21]!.rate).toBeCloseTo(1.5, 6);
    expect(m.hours[7]!.steadiness).toBe(0);
    expect(m.hours[21]!.steadiness).toBe(1);
    expect(m.hours[12]!.rate).toBeNull();
    expect(m.hours[12]!.steadiness).toBeNull();
    expect(m.judgedHours).toBe(2);
    expect(m.steadiest).toMatchObject({ from: 21, to: 22 });
    expect(m.steadiest!.rate).toBeCloseTo(1.5, 6);
    // Every one of those days was a weekday or a weekend day alike; the
    // weekday buckets carry the same slices, so Monday is judged too.
    expect(m.weekdays[0]!.rate).not.toBeNull();
  });

  it('names no steadiest hours when none stand out', () => {
    const sessions: StatsSession[] = [];
    for (let d = 1; d <= 14; d++) {
      sessions.push(sitting(on(9, d, '07:30:00'), 30, { rereads: 2 }));
      sessions.push(sitting(on(9, d, '21:10:00'), 30, { rereads: 2 }));
    }
    const m = focusModel(sessions, now);
    expect(m.ready).toBe(true);
    expect(m.judgedHours).toBe(2);
    expect(m.hours[7]!.steadiness).toBe(1);
    expect(m.hours[21]!.steadiness).toBe(1);
    expect(m.steadiest).toBeNull();
  });

  it('claims nothing under five sittings with re-reads, nor from a server that keeps none', () => {
    const few: StatsSession[] = [];
    for (let d = 1; d <= 14; d++) sessions(few, d);
    function sessions(list: StatsSession[], d: number) {
      list.push(sitting(on(9, d, '21:00:00'), 40, { rereads: d <= 4 ? 2 : 0 }));
    }
    const m = focusModel(few, now);
    expect(m.sittingsWithRereads).toBe(4);
    expect(m.ready).toBe(false);
    expect(m.steadiest).toBeNull();
    expect(m.week.verdict).toBeNull();
    // The same fortnight from a server that does not count re-reads at all.
    const older = Array.from({ length: 14 }, (_, i) => sitting(on(9, 1 + i, '21:00:00'), 40));
    expect(focusModel(older, now)).toMatchObject({ sittingsWithRereads: 0, ready: false });
  });

  it("compares this week with the reader's own rate over the window", () => {
    // Forty evenings of forty minutes with two steps back each, August into
    // September: three an hour.
    const baseline = Array.from({ length: 40 }, (_, i) =>
      sitting(`${localDay(new Date(2026, 7, 1 + i))}T21:00:00`, 40, { rereads: 2 }),
    );
    const week = (rereads: number) =>
      Array.from({ length: 7 }, (_, i) => sitting(on(9, 16 + i, '21:00:00'), 40, { rereads }));
    const more = focusModel([...baseline, ...week(6)], now);
    expect(more.week).toMatchObject({ rereads: 42, seconds: 7 * 40 * 60, verdict: 'more' });
    expect(more.week.rate).toBeCloseTo(9, 6);
    expect(focusModel([...baseline, ...week(0)], now).week.verdict).toBe('less');
    expect(focusModel([...baseline, ...week(2)], now).week.verdict).toBe('usual');
    // A week with five minutes in it is not compared with anything.
    const thin = focusModel([...baseline, sitting(on(9, 22, '08:00:00'), 5, { rereads: 1 })], now);
    expect(thin.week).toEqual({ rereads: 1, seconds: 300, rate: null, verdict: null });
    // An empty week has its numbers, and no verdict.
    expect(focusModel(baseline, now).week).toEqual({
      rereads: 0,
      seconds: 0,
      rate: null,
      verdict: null,
    });
  });

  it('gives the best window a gentle push towards fewer re-reads, and no more than that', () => {
    // Two evenings alike in minutes, sitting length and pace; the earlier
    // one carries three steps back a sitting, the later one none.
    const alike: StatsSession[] = [];
    for (let d = 1; d <= 12; d++) {
      alike.push(sitting(on(9, d, '20:00:00'), 30, { pctAdvanced: 0.1, rereads: 3 }));
      alike.push(sitting(on(9, d, '22:00:00'), 30, { pctAdvanced: 0.1, rereads: 0 }));
    }
    const buckets = hourBuckets(alike);
    // Without focus the tie goes to the earlier hour; with it, to the steadier one.
    expect(bestWindow(buckets)).toMatchObject({ from: 20, to: 21, focusIndex: null });
    const focus = focusModel(alike, now);
    expect(focus.ready).toBe(true);
    const w = bestWindow(buckets, focus.hours)!;
    expect([w.from, w.to]).toEqual([22, 23]);
    expect(w.focusIndex).toBe(0);

    // Longer sittings and more of them at eight, four steps back in each;
    // none at ten. Eight still wins: focus alone is never enough.
    const unalike: StatsSession[] = [];
    for (let d = 1; d <= 12; d++) {
      unalike.push(sitting(on(9, d, '20:00:00'), 45, { pctAdvanced: 0.15, rereads: 4 }));
      unalike.push(sitting(on(9, d, '22:00:00'), 30, { pctAdvanced: 0.1, rereads: 0 }));
    }
    const u = bestWindow(hourBuckets(unalike), focusModel(unalike, now).hours)!;
    expect([u.from, u.to]).toEqual([20, 21]);
    expect(u.focusIndex!).toBeGreaterThan(1);
  });
});

describe('inLastDays', () => {
  it('keeps today and the six days before it for a seven-day window', () => {
    const now = new Date('2026-09-22T15:00:00');
    const kept = inLastDays(
      [
        sitting('2026-09-15T23:50:00', 5),
        sitting('2026-09-16T00:10:00', 5),
        sitting('2026-09-22T09:00:00', 5),
      ],
      7,
      now,
    );
    expect(kept.map((s) => s.startedAt.slice(0, 10)).length).toBe(2);
  });
});
