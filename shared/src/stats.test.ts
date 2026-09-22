import { describe, expect, it } from 'vitest';
import { statsResponseSchema } from './stats';

/** The documented answer parses; a mangled one does not. */

const answer = {
  generatedAt: '2026-09-22T10:00:00.000Z',
  since: '2026-06-24T00:00:00.000Z',
  sessions: [
    {
      id: 123,
      bookId: 'abc',
      medium: 'ebook',
      deviceId: 'd1',
      startedAt: '2026-09-21T20:00:00.000Z',
      endedAt: '2026-09-21T20:30:30.000Z',
      seconds: 1830,
      pctStart: 0.12,
      pctEnd: 0.19,
      pctAdvanced: 0.07,
      rereads: 2,
      rereadPct: 0.013,
    },
  ],
  books: {
    abc: {
      id: 'abc',
      title: 'A Book',
      author: null,
      kind: 'ebook',
      totalChars: 412000,
      durationMs: null,
      pct: 0.19,
      finished: false,
      finishedAt: null,
      lastReadAt: '2026-09-21T20:30:30.000Z',
    },
  },
  allTime: {
    seconds: 99999,
    sessions: 412,
    firstSessionAt: '2025-01-01T00:00:00.000Z',
    booksFinished: 7,
    rereads: 318,
  },
};

describe('statsResponseSchema', () => {
  it('accepts the documented answer, with and without the truncation flag', () => {
    expect(statsResponseSchema.safeParse(answer).success).toBe(true);
    expect(statsResponseSchema.safeParse({ ...answer, truncated: true }).success).toBe(true);
    // A book the library no longer has is still an entry, with what is known.
    const gone = { ...answer.books.abc, id: 'gone', title: null, totalChars: null };
    expect(statsResponseSchema.safeParse({ ...answer, books: { gone } }).success).toBe(true);
  });

  it('refuses what the page could not draw', () => {
    const session = answer.sessions[0]!;
    expect(
      statsResponseSchema.safeParse({ ...answer, sessions: [{ ...session, medium: 'paper' }] })
        .success,
    ).toBe(false);
    expect(statsResponseSchema.safeParse({ ...answer, truncated: false }).success).toBe(false);
    // Steps back are counted whole, and nobody went back minus once.
    expect(
      statsResponseSchema.safeParse({ ...answer, sessions: [{ ...session, rereads: 1.5 }] })
        .success,
    ).toBe(false);
    expect(
      statsResponseSchema.safeParse({ ...answer, sessions: [{ ...session, rereadPct: -0.01 }] })
        .success,
    ).toBe(false);
    expect(
      statsResponseSchema.safeParse({ ...answer, allTime: { ...answer.allTime, rereads: -1 } })
        .success,
    ).toBe(false);
    expect(
      statsResponseSchema.safeParse({ ...answer, allTime: { ...answer.allTime, seconds: -1 } })
        .success,
    ).toBe(false);
  });
});
