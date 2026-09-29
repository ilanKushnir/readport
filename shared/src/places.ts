import { z } from 'zod';
import { ebookLocatorSchema, type EbookLocator } from './locator.js';

/**
 * Reading places: where a person actually reads a book, kept apart from
 * wherever they happened to look.
 *
 * A reader's position moves for two reasons. They read on - a page, the
 * next, the next chapter - or they jump: a quotation someone sent, a note
 * from last month, a search, the contents. The position alone cannot tell
 * the two apart, so a jump used to take the reader's place with it, and a
 * glance at one line on the far side of the book left "Continue reading"
 * there.
 *
 * So progress is folded, as it arrives, into threads. A thread is a stretch
 * read on from one point: each step that stays near where it got to (a few
 * pages on, a little way back, the next chapter) continues it, and anything
 * else starts another - or picks one up again, landing where it stopped. A
 * thread read for long enough is a place. The place with the most reading
 * is the reader's own; the others are kept for a while, in case the reader
 * wants to carry on there, and let go once the reader has gone back to
 * their own place and kept reading. Reading on through the point where
 * another thread stopped joins the two.
 *
 * Positions are fractions of the book, and every distance here is a count
 * of characters turned into one with the book's length: "a few pages" is
 * the same few pages in a novella and in a doorstop.
 */

/** Reading on this far past where a thread got to still continues it: a few pages, the next chapter. */
export const PLACE_AHEAD_CHARS = 12_000;
/** And this far back: turning back to read something again. */
export const PLACE_BACK_CHARS = 6_000;
/** Landing this near where another thread stopped picks that thread up again. */
export const PLACE_REJOIN_CHARS = 3_000;
/** A thread read this long is a place. Less is a glance, and a glance is not kept. */
export const PLACE_SETTLED_MS = 45_000;
/** The most one step between two checkpoints counts as reading (as the stats count it). */
export const PLACE_STEP_CAP_MS = 5 * 60_000;
/** A place is let go once the reader has read this long at their own place since. */
export const PLACE_LEFT_MS = 15 * 60_000;
/** A place not read for this long is let go. */
export const PLACE_STALE_MS = 90 * 86_400_000;
/** The most threads kept for one book. */
export const PLACE_MAX = 6;
/** The length assumed for a book whose length is not known. */
const UNKNOWN_BOOK_CHARS = 400_000;

export const placeThreadSchema = z.object({
  id: z.string().min(1).max(64),
  /** Where the thread began and how far it has got, as fractions of the book. */
  from: z.number().min(0).max(1),
  to: z.number().min(0).max(1),
  /** How far it has got, as a place to go back to. */
  locator: ebookLocatorSchema,
  readMs: z.number().min(0),
  /** Reading done at the reader's own place since this one was last read. */
  leftMs: z.number().min(0),
  startedAt: z.string(),
  lastAt: z.string(),
});
export type PlaceThread = z.infer<typeof placeThreadSchema>;

/** What is stored per person and book. */
export const placesDocSchema = z.object({
  threads: z.array(placeThreadSchema),
  /** The thread the last checkpoint belonged to. */
  current: z.string().nullable(),
});
export type PlacesDoc = z.infer<typeof placesDocSchema>;

export const EMPTY_PLACES_DOC: PlacesDoc = { threads: [], current: null };

/** A place, as the reader is shown it. */
export const readingPlaceSchema = z.object({
  id: z.string(),
  /** The reader's own place: the one read most. */
  main: z.boolean(),
  /** Where the reader last was. */
  current: z.boolean(),
  locator: ebookLocatorSchema,
  /** Where the reading that led here began, as a fraction of the book. */
  fromPct: z.number().min(0).max(1),
  readMs: z.number().min(0),
  startedAt: z.string(),
  lastReadAt: z.string(),
  /** The chapter the place is in, by its title in the contents. */
  chapter: z.string().nullable(),
  /** The words at the place, to know it by. */
  excerpt: z.string().nullable(),
});
export type ReadingPlace = z.infer<typeof readingPlaceSchema>;

export function isSettled(thread: PlaceThread): boolean {
  return thread.readMs >= PLACE_SETTLED_MS;
}

/** The reader's own place: of the threads read long enough, the one read most. */
export function mainThread(threads: readonly PlaceThread[]): PlaceThread | null {
  let best: PlaceThread | null = null;
  for (const thread of threads) {
    if (!isSettled(thread)) continue;
    if (
      !best ||
      thread.readMs > best.readMs ||
      (thread.readMs === best.readMs && thread.startedAt < best.startedAt)
    )
      best = thread;
  }
  return best;
}

function later(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function earlier(a: string, b: string): string {
  return Date.parse(b) < Date.parse(a) ? b : a;
}

/**
 * Fold one checkpoint into a book's threads.
 *
 * `at` is the checkpoint's time as the progress pipeline judged it, and
 * `bookChars` the book's length in characters, when known. Checkpoints
 * arrive in the order they were applied; each is one step of reading or
 * one jump, and nothing here looks further back than the threads.
 */
export function foldReadingPlace(
  doc: PlacesDoc,
  checkpoint: { at: string; locator: EbookLocator },
  bookChars: number | null,
  newId: () => string,
): PlacesDoc {
  const chars = bookChars && bookChars > 0 ? bookChars : UNKNOWN_BOOK_CHARS;
  const ahead = PLACE_AHEAD_CHARS / chars;
  const back = PLACE_BACK_CHARS / chars;
  const rejoin = PLACE_REJOIN_CHARS / chars;
  const pos = Math.min(1, Math.max(0, checkpoint.locator.pct));
  const at = checkpoint.at;
  const time = Date.parse(at);

  let threads = doc.threads.map((thread) => ({ ...thread }));
  let current = threads.find((thread) => thread.id === doc.current) ?? null;
  const moveTo = (thread: PlaceThread) => {
    thread.to = pos;
    thread.locator = checkpoint.locator;
    thread.lastAt = later(thread.lastAt, at);
  };

  if (current && pos >= current.to - back && pos <= current.to + ahead) {
    // Reading on, or back a little: the same thread.
    const step = Math.min(PLACE_STEP_CAP_MS, Math.max(0, time - Date.parse(current.lastAt)));
    current.readMs += step;
    moveTo(current);
    // Reading at one's own place is what lets the other places go.
    if (mainThread(threads)?.id === current.id) {
      for (const thread of threads) if (thread !== current) thread.leftMs += step;
    }
  } else {
    // A jump. What was only looked at is not kept.
    if (current && !isSettled(current)) threads = threads.filter((thread) => thread !== current);
    const again = threads
      .filter((thread) => Math.abs(pos - thread.to) <= rejoin)
      .sort((a, b) => Math.abs(pos - a.to) - Math.abs(pos - b.to))[0];
    if (again) {
      again.leftMs = 0;
      moveTo(again);
      current = again;
    } else {
      current = {
        id: newId(),
        from: pos,
        to: pos,
        locator: checkpoint.locator,
        readMs: 0,
        leftMs: 0,
        startedAt: at,
        lastAt: at,
      };
      threads.push(current);
    }
  }

  // Reading on through where another thread stopped: the two are one.
  for (const other of [...threads]) {
    const live: PlaceThread = current!;
    if (other === live || !threads.includes(other)) continue;
    if (other.to < live.from || other.to > live.to) continue;
    const [keep, drop]: [PlaceThread, PlaceThread] =
      other.readMs > live.readMs ? [other, live] : [live, other];
    keep.readMs = live.readMs + other.readMs;
    keep.from = Math.min(live.from, other.from);
    keep.to = live.to;
    keep.locator = live.locator;
    keep.startedAt = earlier(live.startedAt, other.startedAt);
    keep.lastAt = later(live.lastAt, other.lastAt);
    keep.leftMs = 0;
    threads = threads.filter((thread) => thread !== drop);
    current = keep;
  }

  // Letting go: a place left for the reader's own, one not read for months,
  // and past the most kept, the least recently read.
  const live = current!;
  const main = mainThread(threads);
  threads = threads.filter(
    (thread) =>
      thread === live ||
      thread === main ||
      (thread.leftMs < PLACE_LEFT_MS && time - Date.parse(thread.lastAt) < PLACE_STALE_MS),
  );
  if (threads.length > PLACE_MAX) {
    const kept = new Set<PlaceThread>(main ? [live, main] : [live]);
    const spare = threads
      .filter((thread) => !kept.has(thread))
      .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
    for (const thread of spare.slice(0, PLACE_MAX - kept.size)) kept.add(thread);
    threads = threads.filter((thread) => kept.has(thread));
  }
  return { threads, current: live.id };
}

/**
 * The places to show: the threads read long enough, the reader's own first
 * and the rest by when they were last read.
 */
export function readingPlaces(
  doc: PlacesDoc,
): { thread: PlaceThread; main: boolean; current: boolean }[] {
  const main = mainThread(doc.threads);
  return doc.threads
    .filter(isSettled)
    .map((thread) => ({
      thread,
      main: thread === main,
      current: thread.id === doc.current,
    }))
    .sort((a, b) =>
      a.main !== b.main
        ? a.main
          ? -1
          : 1
        : Date.parse(b.thread.lastAt) - Date.parse(a.thread.lastAt),
    );
}

/** Forget one place, as the reader asked. */
export function forgetReadingPlace(doc: PlacesDoc, id: string): PlacesDoc {
  const threads = doc.threads.filter((thread) => thread.id !== id);
  return { threads, current: doc.current === id ? null : doc.current };
}
