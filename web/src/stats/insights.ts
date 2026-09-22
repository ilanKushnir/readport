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
  /**
   * Steps back of a page or two inside the sitting - the thread lost and
   * gone back for - and the ground they went back over. Absent from a
   * server from before they were kept, which reads as zero of them.
   */
  rereads?: number;
  rereadPct?: number;
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
    /** Absent from a server from before re-reads were kept. */
    rereads?: number;
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
 * time, which is the only honest split without a position per minute; the
 * slice's `share` of the sitting is there so anything else a sitting counts
 * once - its re-reads - can be shared out the same way.
 */
export interface HourSlice {
  day: string;
  weekday: number;
  hour: number;
  seconds: number;
  pctAdvanced: number;
  /** The fraction of the sitting this slice is, by time; the slices of one sitting sum to 1. */
  share: number;
}

export function sliceByHour(s: StatsSession): HourSlice[] {
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
        share: 1,
      },
    ];
  }
  const total = end - start;
  const out: HourSlice[] = [];
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
      share,
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
  /**
   * Re-reads per hour of reading inside the window, relative to the reader's
   * own rate (1 = as usual, below it is fewer). Null when focus was not
   * offered to the scoring, or the window holds too little reading to judge.
   */
  focusIndex: number | null;
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
 *
 * Given the reader's focus by hour (`focusModel`, once it is ready), fewer
 * re-reads inside a window is a point in its favour - a gentle one. The term
 * runs from half to one and a half around the reader's own rate and carries
 * a fifth of the weight, under pace at two fifths and sitting length at
 * three: it can settle a near tie between two evenings, and it cannot lift
 * a window that is shorter, slower or thinner over one that is not.
 */
export const WINDOW_MIN_SHARE = 0.05;
export const WINDOW_MIN_SITTINGS = 3;
export const WINDOW_MAX_HOURS = 3;
export const WINDOW_FOCUS_WEIGHT = 0.2;

export function bestWindow(buckets: HourBucket[], focus?: FocusBucket[] | null): Window | null {
  const total = buckets.reduce((a, b) => a + b.seconds, 0);
  if (total <= 0) return null;
  const all = new Map<number, number>();
  for (const b of buckets) for (const t of b.touched) all.set(t.id, t.seconds);
  const meanSittingAll = all.size ? [...all.values()].reduce((a, b) => a + b, 0) / all.size : 0;
  const eligible = (h: number) => buckets[h]!.seconds >= total * WINDOW_MIN_SHARE;
  const ownRate = focus ? rateOf(focus) : null;

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
      let focusIndex: number | null = null;
      if (focus && ownRate !== null && ownRate > 0) {
        const inWindow = rateOf(hours.map((h) => focus[h]!));
        if (inWindow !== null) focusIndex = inWindow / ownRate;
      }
      const focusTerm =
        focusIndex === null ? 1 : Math.min(1.5, Math.max(0.5, 1.5 - focusIndex / 2));
      const score =
        sec / total + 0.6 * lengthTerm + 0.4 * (paceIndex ?? 1) + WINDOW_FOCUS_WEIGHT * focusTerm;
      if (!best || score > best.score) {
        best = { from, to: from + width, seconds: sec, meanSitting, paceIndex, focusIndex, score };
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

/* ---- focus: going back for the thread -------------------------------- */

/** The re-reads a sitting carries; none on a server from before they were kept. */
export function rereadsOf(s: StatsSession): number {
  return typeof s.rereads === 'number' && s.rereads > 0 ? s.rereads : 0;
}

/**
 * The floor under a sitting's length when its re-reads are rated against
 * it: five minutes. Two steps back in a thirty-second glance are not two
 * hundred and forty an hour; they are two in a sitting too short to judge,
 * and the floor keeps such a glance from outweighing an evening.
 */
export const FOCUS_MIN_SECONDS = 5 * 60;
/**
 * Sittings with any re-reads at all before the focus section claims
 * anything. Under this the section says it is still collecting - which is
 * also what it says to a reader who never goes back, and to a page served
 * by a server from before re-reads were kept: in neither case is there
 * anything honest to say yet.
 */
export const FOCUS_MIN_SITTINGS = 5;
/** What an hour of the day, or a weekday, must hold before its rate is judged. */
export const FOCUS_MIN_BUCKET_SECONDS = 30 * 60;
export const FOCUS_MIN_BUCKET_SITTINGS = 3;
/** This week is "less" or "more" than usual only past these ratios of the reader's own rate. */
export const FOCUS_LESS_RATIO = 0.75;
export const FOCUS_MORE_RATIO = 4 / 3;
/** The steadiest hours are named only when they are this far under the reader's own rate. */
export const FOCUS_STEADIEST_RATIO = 0.75;

/**
 * One sitting's focus index: re-reads per hour of reading, the sitting's
 * length floored at FOCUS_MIN_SECONDS. Fair across lengths - two re-reads
 * in ten minutes is twelve an hour, two in an hour is two - and lower is
 * steadier. It is a rate of going back, not a verdict on the reader: careful
 * readers go back too.
 */
export function focusIndex(s: StatsSession): number {
  return (rereadsOf(s) / Math.max(s.seconds, FOCUS_MIN_SECONDS)) * 3600;
}

export interface FocusBucket {
  /** Reading that reached this bucket, in seconds - the heatmap's own slices. */
  seconds: number;
  /** Sittings that touched it. */
  sittings: number;
  /** Re-reads that fell in it, shared out across a sitting's hours the way its time is. */
  rereads: number;
  /** The floored reading seconds the rate divides by (see FOCUS_MIN_SECONDS), shared out the same way. */
  weight: number;
  /** Re-reads per hour of reading, or null under FOCUS_MIN_BUCKET_* of evidence. */
  rate: number | null;
  /**
   * Where this bucket's rate stands among the reader's judged buckets: 1 at
   * the lowest rate, 0 at the highest, in between for the rest, and 1 for
   * all of them when they are all the same. Null where the rate is.
   */
  steadiness: number | null;
}

/** Re-reads per hour of reading across some buckets; null when they hold no reading. */
function rateOf(buckets: FocusBucket[]): number | null {
  let seconds = 0;
  let rereads = 0;
  let weight = 0;
  for (const b of buckets) {
    seconds += b.seconds;
    rereads += b.rereads;
    weight += b.weight;
  }
  return seconds >= FOCUS_MIN_BUCKET_SECONDS && weight > 0 ? (rereads / weight) * 3600 : null;
}

function focusBuckets(
  sessions: StatsSession[],
  size: number,
  keyOf: (slice: HourSlice) => number,
): FocusBucket[] {
  const seconds = Array<number>(size).fill(0);
  const rereads = Array<number>(size).fill(0);
  const weight = Array<number>(size).fill(0);
  const touched: Set<number>[] = Array.from({ length: size }, () => new Set());
  for (const s of sessions) {
    const floored = Math.max(s.seconds, FOCUS_MIN_SECONDS);
    const back = rereadsOf(s);
    for (const slice of sliceByHour(s)) {
      const k = keyOf(slice);
      seconds[k]! += slice.seconds;
      rereads[k]! += back * slice.share;
      weight[k]! += floored * slice.share;
      touched[k]!.add(s.id);
    }
  }
  const rates = seconds.map((sec, k) =>
    sec >= FOCUS_MIN_BUCKET_SECONDS &&
    touched[k]!.size >= FOCUS_MIN_BUCKET_SITTINGS &&
    weight[k]! > 0
      ? (rereads[k]! / weight[k]!) * 3600
      : null,
  );
  const judged = rates.filter((r): r is number => r !== null);
  const lo = Math.min(...judged);
  const hi = Math.max(...judged);
  return rates.map((rate, k) => ({
    seconds: seconds[k]!,
    sittings: touched[k]!.size,
    rereads: rereads[k]!,
    weight: weight[k]!,
    rate,
    steadiness: rate === null ? null : hi > lo ? (hi - rate) / (hi - lo) : 1,
  }));
}

/** Focus by hour of the day, 0..23, bucketed exactly as the heatmap's columns are. */
export function focusByHour(sessions: StatsSession[]): FocusBucket[] {
  return focusBuckets(sessions, 24, (slice) => slice.hour);
}

/** Focus by weekday, Monday first, bucketed exactly as the heatmap's rows are. */
export function focusByWeekday(sessions: StatsSession[]): FocusBucket[] {
  return focusBuckets(sessions, 7, (slice) => slice.weekday);
}

export interface FocusWeek {
  rereads: number;
  seconds: number;
  /** This week's re-reads per hour of reading; null under ten minutes of it. */
  rate: number | null;
  /** Against the reader's own rate over the window; null when either side is missing. */
  verdict: 'less' | 'usual' | 'more' | null;
}

export interface FocusModel {
  /** Sittings in the window with any re-reads at all. */
  sittingsWithRereads: number;
  /** Whether the section may say anything yet: FOCUS_MIN_SITTINGS such sittings. */
  ready: boolean;
  /** The reader's own re-reads per hour of reading over the whole window; null with no reading. */
  rate: number | null;
  /** Re-reads and reading over the whole window, for the sentence when the week is empty. */
  rereads: number;
  seconds: number;
  hours: FocusBucket[];
  weekdays: FocusBucket[];
  /** How many hours of the day have a rate; under two there is nothing to compare. */
  judgedHours: number;
  /**
   * The run of up to three judged hours side by side with the fewest
   * re-reads per hour of reading, when that is at least a quarter under the
   * reader's own rate. Null when no hours stand out, or too few are judged.
   */
  steadiest: { from: number; to: number; rate: number } | null;
  week: FocusWeek;
}

/**
 * How well the reader holds the thread, and when.
 *
 * Everything here is relative to the reader's own rate of going back over
 * the window - the 90-day baseline - never to other people. The week is
 * this week against that baseline; the hours and weekdays are the same
 * slices the heatmap is drawn from, so the two can be read side by side;
 * and nothing is claimed under FOCUS_MIN_SITTINGS sittings with re-reads.
 */
export function focusModel(sessions: StatsSession[], now: Date): FocusModel {
  let rereads = 0;
  let seconds = 0;
  let weight = 0;
  let sittingsWithRereads = 0;
  for (const s of sessions) {
    const back = rereadsOf(s);
    rereads += back;
    seconds += s.seconds;
    weight += Math.max(s.seconds, FOCUS_MIN_SECONDS);
    if (back > 0) sittingsWithRereads += 1;
  }
  const rate = seconds > 0 ? (rereads / weight) * 3600 : null;
  const ready = sittingsWithRereads >= FOCUS_MIN_SITTINGS;
  const hours = focusByHour(sessions);
  const weekdays = focusByWeekday(sessions);
  const judgedHours = hours.filter((h) => h.rate !== null).length;

  let steadiest: FocusModel['steadiest'] = null;
  if (ready && rate !== null && rate > 0 && judgedHours >= 2) {
    let best: { from: number; to: number; rate: number } | null = null;
    for (let from = 0; from < 24; from++) {
      for (let width = 1; width <= WINDOW_MAX_HOURS && from + width <= 24; width++) {
        const run = hours.slice(from, from + width);
        if (run.some((h) => h.rate === null)) break;
        const r = rateOf(run);
        if (r === null) continue;
        // Lower wins; the same rate over more hours is the same claim on more evidence.
        if (!best || r < best.rate || (r === best.rate && width > best.to - best.from)) {
          best = { from, to: from + width, rate: r };
        }
      }
    }
    if (best && best.rate <= rate * FOCUS_STEADIEST_RATIO) steadiest = best;
  }

  const thisWeek = inLastDays(sessions, 7, now);
  let weekRereads = 0;
  let weekSeconds = 0;
  let weekWeight = 0;
  for (const s of thisWeek) {
    weekRereads += rereadsOf(s);
    weekSeconds += s.seconds;
    weekWeight += Math.max(s.seconds, FOCUS_MIN_SECONDS);
  }
  const weekRate = weekSeconds >= 10 * 60 ? (weekRereads / weekWeight) * 3600 : null;
  let verdict: FocusWeek['verdict'] = null;
  if (ready && weekRate !== null && rate !== null) {
    if (rate === 0) verdict = weekRate > 0 ? 'more' : 'usual';
    else if (weekRate <= rate * FOCUS_LESS_RATIO) verdict = 'less';
    else if (weekRate >= rate * FOCUS_MORE_RATIO) verdict = 'more';
    else verdict = 'usual';
  }

  return {
    sittingsWithRereads,
    ready,
    rate,
    rereads,
    seconds,
    hours,
    weekdays,
    judgedHours,
    steadiest,
    week: { rereads: weekRereads, seconds: weekSeconds, rate: weekRate, verdict },
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
/**
 * The least a book must have had to be "on the go": a minute with it, or
 * some ground covered. Opening a book and closing it again leaves a sitting
 * of a few seconds at 0%, and a row saying "0:00 in" for it is not a book
 * anybody is reading.
 */
export const ON_THE_GO_MIN_SECONDS = 60;

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
    if (seconds < ON_THE_GO_MIN_SECONDS && pctAdvanced < 0.005 && book.pct < 0.005) continue;
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
