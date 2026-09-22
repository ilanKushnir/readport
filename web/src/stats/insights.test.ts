import { describe, expect, it } from 'vitest';
import {
  bestWindow,
  bookInsights,
  dailyTotals,
  heatmap,
  hourBuckets,
  inLastDays,
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
