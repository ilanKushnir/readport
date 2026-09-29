import { type ReadingPoint } from './continuity';

/**
 * A look, until it is reading.
 *
 * A jump - a quotation somebody sent, a note from the Notes page, a search,
 * the contents, the slider, a footnote - lands the reader somewhere they may
 * only be looking at. While they only look, nothing is recorded: the book
 * reopens where they were reading, their percentage in the library and what
 * friends see stay where they were, and "Back to your place" is one tap.
 * Reading on from where they landed, for a while, settles it: from then on
 * it is where they are, and it is recorded as a move they made.
 */
export interface Visit {
  /** Where the reader was reading before the first jump of the look. */
  from: (ReadingPoint & { label: string }) | null;
  /** Where the look landed, and how far on from there the reader has read, in the book's characters. */
  landed: number;
  furthest: number;
  /** When it landed (performance.now()). */
  since: number;
}

/** Reading on this many characters... */
export const SETTLE_CHARS = 900;
/** ...over at least this long settles a look: a couple of pages, read. */
export const SETTLE_MS = 30_000;
/** So does one dense page, read slowly. */
export const SETTLE_SLOW_CHARS = 150;
export const SETTLE_SLOW_MS = 90_000;

/** A look begun at `at`, after reading at `from` - or carried on, if the reader was already looking. */
export function beginVisit(
  current: Visit | null,
  from: Visit['from'],
  at: number,
  now: number,
): Visit {
  return { from: current ? current.from : from, landed: at, furthest: at, since: now };
}

/** The reader is at `at` now: whether that has made the look reading. */
export function settles(visit: Visit, at: number, now: number): boolean {
  visit.furthest = Math.max(visit.furthest, at);
  const read = visit.furthest - visit.landed;
  const spent = now - visit.since;
  return (
    (read >= SETTLE_CHARS && spent >= SETTLE_MS) ||
    (read >= SETTLE_SLOW_CHARS && spent >= SETTLE_SLOW_MS)
  );
}
