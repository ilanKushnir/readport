import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../../context.js';
import { seesHidden, visibleSql } from '../../library/visibility.js';

/**
 * Reading statistics: the caller's own sittings and the books they name.
 *
 * The client does every piece of arithmetic that needs a timezone - the hour
 * of the day, the day of the week, streaks - because only the browser knows
 * which timezone the reader lives in. The server hands over the sessions, in
 * UTC, and the few whole-history numbers it can add up cheaply.
 *
 * The wire shape is `statsResponseSchema` (shared/src/stats.ts); the types
 * below mirror it field for field.
 */

/** Sessions per answer. Past this the newest win and `truncated` says so. */
const MAX_SESSIONS = 3000;
const DEFAULT_DAYS = 90;
const daysSchema = z.coerce.number().int().min(1).max(365);

type Medium = 'ebook' | 'audio';

interface SessionDto {
  id: number;
  bookId: string;
  medium: Medium;
  deviceId: string;
  startedAt: string;
  endedAt: string;
  seconds: number;
  pctStart: number;
  pctEnd: number;
  pctAdvanced: number;
  /** Steps back of a page or two inside the sitting, and the ground they went back over. */
  rereads: number;
  rereadPct: number;
}

interface BookDto {
  id: string;
  title: string | null;
  author: string | null;
  kind: Medium;
  totalChars: number | null;
  durationMs: number | null;
  pct: number;
  finished: boolean;
  finishedAt: string | null;
  lastReadAt: string;
}

export interface StatsResponse {
  generatedAt: string;
  since: string;
  sessions: SessionDto[];
  truncated?: true;
  books: Record<string, BookDto>;
  allTime: {
    seconds: number;
    sessions: number;
    firstSessionAt: string | null;
    booksFinished: number;
    rereads: number;
  };
}

interface SessionRow {
  id: number;
  book_id: string;
  medium: string;
  device_id: string;
  started_at: string;
  ended_at: string;
  pct_start: number;
  pct_end: number;
  pct_advanced: number;
  active_ms: number | null;
  rereads: number;
  reread_pct: number;
}

interface BookRow {
  title: string | null;
  author: string | null;
  kind: string | null;
  duration_ms: number | null;
  total_chars: number | null;
  locator_json: string | null;
  finished: number | null;
  updated_at: string | null;
}

/** 00:00 UTC on the day `days` days before `now`: where the window starts. */
export function statsWindowStart(now: Date, days: number): Date {
  const since = new Date(now);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - days);
  return since;
}

function pctOf(locatorJson: string | null): number {
  if (locatorJson === null) return 0;
  try {
    const pct = (JSON.parse(locatorJson) as { pct?: unknown }).pct;
    return typeof pct === 'number' && Number.isFinite(pct) ? pct : 0;
  } catch {
    return 0;
  }
}

export function registerStatsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/stats', async (req, reply) => {
    const userId = req.user!.id;
    const { days: rawDays } = (req.query ?? {}) as { days?: unknown };
    let days = DEFAULT_DAYS;
    if (rawDays !== undefined) {
      const parsed = daysSchema.safeParse(rawDays);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'invalid', detail: 'days must be a whole number from 1 to 365' });
      }
      days = parsed.data;
    }
    const now = new Date();
    const since = statsWindowStart(now, days).toISOString();

    // Every sitting still going on at `since` or begun after it, newest
    // first. One more than the cap, so truncation is a fact, not a guess.
    const rows = db
      .prepare(
        `SELECT id, book_id, medium, device_id, started_at, ended_at, pct_start, pct_end,
                pct_advanced, active_ms, rereads, reread_pct
           FROM reading_sessions WHERE user_id = ? AND ended_at >= ?
          ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(userId, since, MAX_SESSIONS + 1) as unknown as SessionRow[];
    const truncated = rows.length > MAX_SESSIONS;
    if (truncated) rows.length = MAX_SESSIONS;
    const sessions: SessionDto[] = rows.map((r) => ({
      id: Number(r.id),
      bookId: String(r.book_id),
      medium: r.medium === 'audio' ? 'audio' : 'ebook',
      deviceId: String(r.device_id),
      startedAt: String(r.started_at),
      endedAt: String(r.ended_at),
      // Reading time, not clock time: the sum of the sitting's steps, each
      // capped at what a page or a stretch of narration can hold. A sitting
      // from before that was kept is measured by the clock, as it always was.
      seconds: Math.max(
        0,
        Math.round(
          (r.active_ms ?? Date.parse(String(r.ended_at)) - Date.parse(String(r.started_at))) / 1000,
        ),
      ),
      pctStart: Number(r.pct_start),
      pctEnd: Number(r.pct_end),
      pctAdvanced: Number(r.pct_advanced),
      // Going back a page or two for the thread (stats/sessions.ts); a
      // sitting from before that was kept reads zero, as it should.
      rereads: Number(r.rereads),
      rereadPct: Number(r.reread_pct),
    }));

    // One entry per book the sessions name. Anchored on the id rather than
    // on the books table, so a book that has left the library still gets an
    // entry with whatever is known: a session is a record of having read,
    // and the file going away takes nothing from it. `totalChars` is what
    // indexing wrote beside the book - the same figure the reader's manifest
    // is built on - and null until the book has been indexed. A hidden book
    // is looked up the same way as one that left: the time spent in it is
    // the reader's own and stays in their totals, but its name is not
    // theirs to be shown while it is hidden.
    const bookStmt = db.prepare(
      `SELECT b.title, b.author, b.kind, b.duration_ms,
              CASE WHEN json_valid(b.meta_json) THEN json_extract(b.meta_json, '$.totalChars') END
                AS total_chars,
              p.locator_json, p.finished, p.updated_at
         FROM (SELECT ? AS id) x
         LEFT JOIN books b ON b.id = x.id AND ${visibleSql(seesHidden(req))}
         LEFT JOIN progress_state p ON p.book_id = x.id AND p.user_id = ?`,
    );
    const lastReadStmt = db.prepare(
      'SELECT MAX(ended_at) AS last FROM reading_sessions WHERE user_id = ? AND book_id = ?',
    );
    // Explicit events are kept for ever, so the finishing one is still there
    // to date the finish by - unless a reset erased it, when the state row's
    // own timestamp is the best that is left.
    const finishedAtStmt = db.prepare(
      `SELECT COALESCE(effective_at, occurred_at) AS at FROM progress_events
        WHERE user_id = ? AND book_id = ? AND intent = 'finish' AND applied = 1
        ORDER BY id DESC LIMIT 1`,
    );
    const books: Record<string, BookDto> = {};
    for (const s of sessions) {
      if (books[s.bookId]) continue;
      const b = bookStmt.get(s.bookId, userId) as unknown as BookRow;
      const kind: Medium = b.kind === 'ebook' || b.kind === 'audio' ? b.kind : s.medium;
      const finished = Number(b.finished) === 1;
      const finishedAt = finished
        ? ((finishedAtStmt.get(userId, s.bookId) as { at: string } | undefined)?.at ?? b.updated_at)
        : null;
      books[s.bookId] = {
        id: s.bookId,
        title: b.title === null ? null : String(b.title),
        author: b.author === null ? null : String(b.author),
        kind,
        totalChars:
          kind === 'ebook' && typeof b.total_chars === 'number' && Number.isFinite(b.total_chars)
            ? b.total_chars
            : null,
        durationMs: b.duration_ms === null ? null : Number(b.duration_ms),
        pct: pctOf(b.locator_json),
        finished,
        finishedAt: finishedAt === null ? null : String(finishedAt),
        lastReadAt: String((lastReadStmt.get(userId, s.bookId) as { last: string }).last),
      };
    }

    // The whole diary, whatever the window: what the page cannot add up
    // from a slice of it.
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS sessions,
                COALESCE(SUM(COALESCE(active_ms / 1000.0,
                                      (julianday(ended_at) - julianday(started_at)) * 86400.0)), 0) AS seconds,
                MIN(started_at) AS first,
                COALESCE(SUM(rereads), 0) AS rereads
           FROM reading_sessions WHERE user_id = ?`,
      )
      .get(userId) as { sessions: number; seconds: number; first: string | null; rereads: number };
    const finishedBooks = db
      .prepare('SELECT COUNT(*) AS c FROM progress_state WHERE user_id = ? AND finished = 1')
      .get(userId) as { c: number };

    const body: StatsResponse = {
      generatedAt: now.toISOString(),
      since,
      sessions,
      ...(truncated ? { truncated: true as const } : {}),
      books,
      allTime: {
        seconds: Math.round(Number(totals.seconds)),
        sessions: Number(totals.sessions),
        firstSessionAt: totals.first ?? null,
        booksFinished: Number(finishedBooks.c),
        rereads: Number(totals.rereads),
      },
    };
    return body;
  });
}
