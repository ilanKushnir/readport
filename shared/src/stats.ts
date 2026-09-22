import { z } from 'zod';
import { bookKindSchema } from './api.js';

/**
 * `GET /api/stats`: the reading diary, as the stats page reads it.
 *
 * A session is one sitting with one book on one device in one medium. Its
 * time is wall-clock from the first event of the sitting to the last; its
 * distance is forward movement only, so re-reading a page is time spent and
 * not ground covered. Everything is in UTC and there are no hour-of-day or
 * weekday fields on purpose: only the browser knows the reader's timezone,
 * so streaks and the hour a person reads at are the client's arithmetic.
 */

export const readingMediumSchema = z.enum(['ebook', 'audio']);
export type ReadingMedium = z.infer<typeof readingMediumSchema>;

export const readingSessionSchema = z.object({
  id: z.number().int(),
  bookId: z.string(),
  medium: readingMediumSchema,
  deviceId: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  /** Wall-clock seconds from the sitting's first event to its last. */
  seconds: z.number().int().nonnegative(),
  pctStart: z.number(),
  pctEnd: z.number(),
  /** Sum of the forward moves inside the sitting; going back adds nothing. */
  pctAdvanced: z.number(),
});
export type ReadingSession = z.infer<typeof readingSessionSchema>;

/**
 * A book the sessions name, joined from the library and from the caller's
 * own progress. A book that has since left the library still gets an entry:
 * `title` is then null and `kind` is the medium it was read in.
 */
export const statsBookSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  kind: bookKindSchema,
  /** The ebook's indexed text length; null for audio, or until indexed. */
  totalChars: z.number().nullable(),
  /** The audiobook's length; null for ebooks. */
  durationMs: z.number().nullable(),
  /** Current position, 0 when there is none (never opened, or reset). */
  pct: z.number(),
  finished: z.boolean(),
  finishedAt: z.string().nullable(),
  /** The end of the latest session with this book, in any window. */
  lastReadAt: z.string(),
});
export type StatsBook = z.infer<typeof statsBookSchema>;

export const statsResponseSchema = z.object({
  generatedAt: z.string(),
  /** 00:00 UTC on the day `days` days before `generatedAt`. */
  since: z.string(),
  /** Every session that ended at or after `since`, newest first, at most 3000. */
  sessions: z.array(readingSessionSchema),
  /** Present only when the window held more sessions than were returned. */
  truncated: z.literal(true).optional(),
  books: z.record(z.string(), statsBookSchema),
  /** Over the whole diary, whatever the window. */
  allTime: z.object({
    seconds: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    firstSessionAt: z.string().nullable(),
    booksFinished: z.number().int().nonnegative(),
  }),
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;
