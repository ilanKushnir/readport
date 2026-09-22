/**
 * Everything the stats page shows, derived from reading sessions.
 *
 * The server hands over sittings with UTC timestamps and nothing else; every
 * question about WHEN somebody reads is answered here, in the timezone of
 * the browser asking, because that is the only place the timezone is known.
 *
 * Pure functions over plain data, so the page is a renderer and this is what
 * the tests exercise.
 */

export interface StatsSession {
  id: number;
  bookId: string;
  medium: 'ebook' | 'audio';
  deviceId: string;
  startedAt: string;
  endedAt: string;
  seconds: number;
  pctStart: number;
  pctEnd: number;
  pctAdvanced: number;
}

export interface StatsBook {
  id: string;
  title: string | null;
  author: string | null;
  kind: 'ebook' | 'audio';
  totalChars: number | null;
  durationMs: number | null;
  pct: number;
  finished: boolean;
  finishedAt: string | null;
  lastReadAt: string | null;
}

export interface StatsResponse {
  generatedAt: string;
  since: string;
  sessions: StatsSession[];
  books: Record<string, StatsBook>;
  allTime: {
    seconds: number;
    sessions: number;
    firstSessionAt: string | null;
    booksFinished: number;
  };
  truncated?: boolean;
}

/** Local calendar day, `YYYY-MM-DD`, in the browser's zone. */
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Monday-first weekday index, 0..6, so a week reads the way a diary does. */
export function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/**
 * One sitting, cut at every local hour boundary it crosses.
 *
 * A sitting that runs from 22:40 to 00:10 is twenty minutes of the 22nd
 * hour, an hour of the 23rd, and ten minutes of the next day's first, not
 * ninety minutes credited to 22:40. Distance is shared out in proportion to
 * time, which is the only honest split without a position per minute.
 */
export function sliceByHour(
  s: StatsSession,
): { day: string; weekday: number; hour: number; seconds: number; pctAdvanced: number }[] {
  const start = new Date(s.startedAt).getTime();
  const end = new Date(s.endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    const at = new Date(Number.isFinite(start) ? start : Date.now());
    return [
      {
        day: localDay(at),
        weekday: weekdayIndex(at),
        hour: at.getHours(),
        seconds: Math.max(0, s.seconds),
        pctAdvanced: Math.max(0, s.pctAdvanced),
      },
    ];
  }
  const total = end - start;
  const out: {
    day: string;
    weekday: number;
    hour: number;
    seconds: number;
    pctAdvanced: number;
  }[] = [];
  let cursor = start;
  while (cursor < end) {
    const at = new Date(cursor);
    const boundary = new Date(at);
    boundary.setMinutes(60, 0, 0); // the next local hour
    const sliceEnd = Math.min(end, boundary.getTime());
    const share = (sliceEnd - cursor) / total;
    out.push({
      day: localDay(at),
      weekday: weekdayIndex(at),
      hour: at.getHours(),
      seconds: s.seconds * share,
      pctAdvanced: s.pctAdvanced * share,
    });
    cursor = sliceEnd;
  }
  return out;
}

export interface DayTotal {
  day: string;
  seconds: number;
  readSeconds: number;
  listenSeconds: number;
  sittings: number;
}

/** Seconds per local day across the window, oldest first, every day present. */
export function dailyTotals(sessions: StatsSession[], from: Date, to: Date): DayTotal[] {
  const map = new Map<string, DayTotal>();
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  while (d <= to) {
    const day = localDay(d);
    map.set(day, { day, seconds: 0, readSeconds: 0, listenSeconds: 0, sittings: 0 });
    d.setDate(d.getDate() + 1);
  }
  const counted = new Set<string>();
  for (const s of sessions) {
    for (const slice of sliceByHour(s)) {
      const row = map.get(slice.day);
      if (!row) continue;
      row.seconds += slice.seconds;
      if (s.medium === 'audio') row.listenSeconds += slice.seconds;
      else row.readSeconds += slice.seconds;
      const key = `${s.id}:${slice.day}`;
      if (!counted.has(key)) {
        counted.add(key);
        row.sittings += 1;
      }
    }
  }
  return [...map.values()];
}

/** A 7 (Mon..Sun) × 24 grid of seconds. */
export function heatmap(sessions: StatsSession[]): number[][] {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const s of sessions) {
    for (const slice of sliceByHour(s)) grid[slice.weekday]![slice.hour]! += slice.seconds;
  }
  return grid;
}

export interface Streak {
  current: number;
  longest: number;
  /** Whether today already counts, so "keep it going" can be phrased right. */
  today: boolean;
}

/** A day counts once it has this much reading on it; a stray tap does not. */
export const STREAK_MIN_SECONDS = 5 * 60;

export function streak(sessions: StatsSession[], now: Date): Streak {
  const perDay = new Map<string, number>();
  for (const s of sessions) {
    for (const slice of sliceByHour(s)) {
      perDay.set(slice.day, (perDay.get(slice.day) ?? 0) + slice.seconds);
    }
  }
  const active = new Set(
    [...perDay].filter(([, sec]) => sec >= STREAK_MIN_SECONDS).map(([d]) => d),
  );
  const todayKey = localDay(now);
  // Walk back from today, or from yesterday if today has not started yet:
  // an unbroken run should not read as broken at 8 a.m.
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  const today = active.has(todayKey);
  if (!today) cursor.setDate(cursor.getDate() - 1);
  let current = 0;
  while (active.has(localDay(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  // Longest run anywhere in the data.
  const days = [...active].sort();
  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const day of days) {
    const d = new Date(`${day}T00:00:00`);
    if (prev && d.getTime() - prev.getTime() === 86_400_000) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest, today };
}

export interface HourBucket {
  hour: number;
  seconds: number;
  /** How many sittings touched this hour. */
  sittings: number;
  /** The sittings themselves, so a window spanning hours can count each ONCE. */
  touched: { id: number; seconds: number }[];
  /** Mean length of a sitting that touched this hour, in seconds. */
  meanSitting: number;
  /** Forward movement per minute of reading, relative to the overall mean (1 = average). */
  paceIndex: number | null;
}

/**
 * What each hour of the day looks like for this reader: how much, how long
 * at a stretch, and how fast. The recommendation is built from these.
 */
export function hourBuckets(sessions: StatsSession[]): HourBucket[] {
  const seconds = Array<number>(24).fill(0);
  const pct = Array<number>(24).fill(0);
  const touched: { id: number; seconds: number }[][] = Array.from({ length: 24 }, () => []);
  for (const s of sessions) {
    const hours = new Set<number>();
    for (const slice of sliceByHour(s)) {
      seconds[slice.hour]! += slice.seconds;
      pct[slice.hour]! += slice.pctAdvanced;
      hours.add(slice.hour);
    }
    for (const h of hours) touched[h]!.push({ id: s.id, seconds: s.seconds });
  }
  const totalSeconds = seconds.reduce((a, b) => a + b, 0);
  const totalPct = pct.reduce((a, b) => a + b, 0);
  const overallPace = totalSeconds > 0 ? totalPct / (totalSeconds / 60) : 0;
  return seconds.map((sec, hour) => {
    const list = touched[hour]!;
    const meanSitting = list.length ? list.reduce((a, t) => a + t.seconds, 0) / list.length : 0;
    const pace = sec > 0 ? pct[hour]! / (sec / 60) : 0;
    return {
      hour,
      seconds: sec,
      sittings: list.length,
      touched: list,
      meanSitting,
      paceIndex: overallPace > 0 && sec >= 10 * 60 ? pace / overallPace : null,
    };
  });
}

export interface Window {
  /** Inclusive start hour and exclusive end hour, local. */
  from: number;
  to: number;
  seconds: number;
  meanSitting: number;
  paceIndex: number | null;
}

/**
 * The stretch of the day this reader gets the most out of.
 *
 * Only hours that carry a real share of the reading are candidates, and a
 * window is a run of up to three of them side by side - so an evening habit
 * is reported as 21:00-23:00, never as 19:00-22:00 with two empty hours
 * bolted on for width. Each window is scored on the share of all reading it
 * holds, the length of the sittings that reach it, and the pace inside it,
 * each relative to the reader's own average: the answer is "when YOU read
 * best", not "when people read".
 *
 * Two guards keep one big Sunday from becoming advice. A window needs at
 * least three sittings before it can be recommended at all, and the
 * sitting-length term is capped so a single four-hour afternoon cannot
 * outrank twelve real evenings.
 */
export const WINDOW_MIN_SHARE = 0.05;
export const WINDOW_MIN_SITTINGS = 3;
export const WINDOW_MAX_HOURS = 3;

export function bestWindow(buckets: HourBucket[]): Window | null {
  const total = buckets.reduce((a, b) => a + b.seconds, 0);
  if (total <= 0) return null;
  const all = new Map<number, number>();
  for (const b of buckets) for (const t of b.touched) all.set(t.id, t.seconds);
  const meanSittingAll = all.size ? [...all.values()].reduce((a, b) => a + b, 0) / all.size : 0;
  const eligible = (h: number) => buckets[h]!.seconds >= total * WINDOW_MIN_SHARE;

  let best: (Window & { score: number }) | null = null;
  for (let from = 0; from < 24; from++) {
    if (!eligible(from)) continue;
    for (let width = 1; width <= WINDOW_MAX_HOURS && from + width <= 24; width++) {
      const hours = Array.from({ length: width }, (_, i) => from + i);
      if (!hours.every(eligible)) break; // the run has ended
      const sec = hours.reduce((a, h) => a + buckets[h]!.seconds, 0);
      // One sitting that runs across three hours is one sitting.
      const distinct = new Map<number, number>();
      for (const h of hours) for (const t of buckets[h]!.touched) distinct.set(t.id, t.seconds);
      const sittings = distinct.size;
      if (sittings < WINDOW_MIN_SITTINGS) continue;
      const meanSitting = [...distinct.values()].reduce((a, b) => a + b, 0) / sittings;
      const paced = hours.filter((h) => buckets[h]!.paceIndex !== null);
      const paceIndex = paced.length
        ? paced.reduce((a, h) => a + (buckets[h]!.paceIndex ?? 1) * buckets[h]!.seconds, 0) /
          paced.reduce((a, h) => a + buckets[h]!.seconds, 0)
        : null;
      const lengthTerm = meanSittingAll > 0 ? Math.min(2, meanSitting / meanSittingAll) : 0;
      const score = sec / total + 0.6 * lengthTerm + 0.4 * (paceIndex ?? 1);
      if (!best || score > best.score) {
        best = { from, to: from + width, seconds: sec, meanSitting, paceIndex, score };
      }
    }
  }
  if (!best) return null;
  const { score: _score, ...w } = best;
  void _score;
  return w;
}

export interface Readiness {
  activeDays: number;
  sittings: number;
  /** Recommendations are offered once this reaches zero. */
  daysToGo: number;
  ready: boolean;
}

export const RECOMMEND_AFTER_DAYS = 14;
export const RECOMMEND_AFTER_SITTINGS = 10;

export function readiness(sessions: StatsSession[]): Readiness {
  const days = new Set<string>();
  for (const s of sessions) for (const slice of sliceByHour(s)) days.add(slice.day);
  const activeDays = days.size;
  const sittings = sessions.length;
  const daysToGo = Math.max(0, RECOMMEND_AFTER_DAYS - activeDays);
  return {
    activeDays,
    sittings,
    daysToGo,
    ready: activeDays >= RECOMMEND_AFTER_DAYS && sittings >= RECOMMEND_AFTER_SITTINGS,
  };
}

export interface BookProgressInsight {
  book: StatsBook;
  seconds: number;
  sittings: number;
  pctAdvanced: number;
  lastReadAt: string;
  /** Seconds of reading left at this reader's recent pace on this book; null if unknown. */
  secondsToFinish: number | null;
}

/**
 * Per book: time in, distance covered, and - for the ones still open - how
 * far off the end is at the pace of the last few sittings on that book. The
 * estimate uses the book's own pace, not the reader's average: a dense
 * history book and a thriller are not read at the same speed.
 */
export function bookInsights(data: StatsResponse): BookProgressInsight[] {
  const byBook = new Map<string, StatsSession[]>();
  for (const s of data.sessions) {
    const list = byBook.get(s.bookId) ?? [];
    list.push(s);
    byBook.set(s.bookId, list);
  }
  const out: BookProgressInsight[] = [];
  for (const [bookId, sessions] of byBook) {
    const book = data.books[bookId];
    if (!book) continue;
    const seconds = sessions.reduce((a, s) => a + s.seconds, 0);
    const pctAdvanced = sessions.reduce((a, s) => a + s.pctAdvanced, 0);
    const lastReadAt = sessions
      .map((s) => s.endedAt)
      .sort()
      .at(-1)!;
    let secondsToFinish: number | null = null;
    if (!book.finished && book.pct < 1) {
      const recent = [...sessions].sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, 5);
      const rSec = recent.reduce((a, s) => a + s.seconds, 0);
      const rPct = recent.reduce((a, s) => a + s.pctAdvanced, 0);
      if (rSec >= 10 * 60 && rPct > 0.005) {
        secondsToFinish = ((1 - book.pct) / rPct) * rSec;
      }
    }
    out.push({
      book,
      seconds,
      sittings: sessions.length,
      pctAdvanced,
      lastReadAt,
      secondsToFinish,
    });
  }
  return out.sort((a, b) => b.lastReadAt.localeCompare(a.lastReadAt));
}

export interface Summary {
  seconds: number;
  readSeconds: number;
  listenSeconds: number;
  sittings: number;
  activeDays: number;
  /** Words read, from books that know their length; null when none do. */
  words: number | null;
  /** Reading pace in words per minute over ebook sittings with known length. */
  wordsPerMinute: number | null;
  meanSitting: number;
  longestSitting: number;
}

/** Roughly how many characters make a word, across the languages here. */
const CHARS_PER_WORD = 5.7;

export function summarise(sessions: StatsSession[], books: Record<string, StatsBook>): Summary {
  let seconds = 0;
  let readSeconds = 0;
  let listenSeconds = 0;
  let longest = 0;
  let chars = 0;
  let charSeconds = 0;
  let anyLength = false;
  const days = new Set<string>();
  for (const s of sessions) {
    seconds += s.seconds;
    longest = Math.max(longest, s.seconds);
    if (s.medium === 'audio') listenSeconds += s.seconds;
    else {
      readSeconds += s.seconds;
      const total = books[s.bookId]?.totalChars;
      if (total) {
        anyLength = true;
        chars += s.pctAdvanced * total;
        charSeconds += s.seconds;
      }
    }
    for (const slice of sliceByHour(s)) days.add(slice.day);
  }
  return {
    seconds,
    readSeconds,
    listenSeconds,
    sittings: sessions.length,
    activeDays: days.size,
    words: anyLength ? Math.round(chars / CHARS_PER_WORD) : null,
    wordsPerMinute:
      anyLength && charSeconds >= 10 * 60
        ? Math.round(chars / CHARS_PER_WORD / (charSeconds / 60))
        : null,
    meanSitting: sessions.length ? seconds / sessions.length : 0,
    longestSitting: longest,
  };
}

/**
 * Whether an answer has the shape the page reads. A proxy's error page, a
 * mock, or a server from before the stats API can all come back as JSON of
 * some other shape; the strip stays away and the page says "older server"
 * rather than either of them throwing on a missing array.
 */
export function isStatsResponse(value: unknown): value is StatsResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<StatsResponse>;
  return (
    Array.isArray(v.sessions) &&
    !!v.books &&
    typeof v.books === 'object' &&
    !!v.allTime &&
    typeof v.allTime === 'object'
  );
}

/** Sessions that ended within the last `days` local days, today included. */
export function inLastDays(sessions: StatsSession[], days: number, now: Date): StatsSession[] {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  return sessions.filter((s) => new Date(s.endedAt) >= from);
}
