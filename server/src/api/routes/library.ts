import fs from 'node:fs';
import posix from 'node:path/posix';
import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  RECENTLY_ADDED_DAYS,
  RECENTLY_ADDED_LIMIT,
  type BookSummary,
  parseFacet,
} from '@readport/shared';
import { bookIdsWithFacet, facetGroups, foldFacet } from '../../library/facets.js';
import { libraryRoots } from '../../domain/settings.js';
import { type AppContext } from '../../context.js';
import { enqueueJob } from '../../jobs/queue.js';
import { handoffStatus, latestAlignment, isSwitchable } from '../../alignment/service.js';
import { getProgressState } from '../../progress/service.js';
import { requireExport } from '../../auth/roles.js';
import { realResolveWithin } from '../../util/paths.js';

export function bookRowToSummary(
  ctx: AppContext,
  userId: string,
  row: Record<string, unknown>,
): BookSummary {
  const { db } = ctx;
  const id = String(row.id);
  const pairRow = db
    .prepare(
      `SELECT * FROM pairs WHERE (ebook_id = ? OR audio_id = ?) AND status IN ('auto','confirmed','candidate')
       ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'auto' THEN 1 ELSE 2 END, score DESC LIMIT 1`,
    )
    .get(id, id) as Record<string, unknown> | undefined;
  let pair: BookSummary['pair'] = null;
  if (pairRow) {
    const handle = ['auto', 'confirmed'].includes(String(pairRow.status))
      ? latestAlignment(db, String(pairRow.id))
      : null;
    const otherBookId =
      String(pairRow.ebook_id) === id ? String(pairRow.audio_id) : String(pairRow.ebook_id);
    // The counterpart's kind and format, so one card can name both. A pair
    // can outlive one of its books (a file goes missing before the row is
    // cleaned up), so this must tolerate finding nothing.
    const other = db.prepare('SELECT kind, format FROM books WHERE id = ?').get(otherBookId) as
      { kind: string; format: string } | undefined;
    pair = {
      pairId: String(pairRow.id),
      otherBookId,
      otherKind: (other?.kind ??
        (String(row.kind) === 'ebook' ? 'audio' : 'ebook')) as BookSummary['kind'],
      otherFormat: other?.format ?? '',
      status: String(pairRow.status) as NonNullable<BookSummary['pair']>['status'],
      switchable: isSwitchable(handle),
      handoff: handoffStatus(handle),
    };
  }
  const state = getProgressState(db, userId, id);
  return {
    id,
    kind: String(row.kind) as BookSummary['kind'],
    title: String(row.title),
    author: (row.author as string) ?? null,
    series: (row.series as string) ?? null,
    seriesIdx: (row.series_idx as number) ?? null,
    language: (row.language as string) ?? null,
    format: String(row.format),
    scanState: String(row.scan_state) as BookSummary['scanState'],
    scanError: (row.scan_error as string) ?? null,
    durationMs: (row.duration_ms as number) ?? null,
    sizeBytes: Number(row.size_bytes ?? 0),
    hasCover: Boolean(row.cover_path) && fs.existsSync(String(row.cover_path)),
    addedAt: String(row.added_at),
    pair,
    progress: state
      ? {
          pct: state.locator.pct,
          locator: state.locator,
          updatedAt: state.updatedAt,
          finished: state.finished,
        }
      : null,
  };
}

/**
 * Collapse both halves of a matched pair down to a single entry.
 *
 * The ebook side is kept because that is the side with the cover, the fuller
 * title and the page count; the audio side stands in when there is no ebook
 * row to keep. Order is preserved - the survivor sits where it already was,
 * so an alphabetical shelf stays alphabetical.
 *
 * Only settled pairs collapse. A `candidate` is a guess the user has not
 * confirmed, and hiding a book behind a guess would lose it.
 *
 * @param pairedOnly drop everything that is not half of a settled pair.
 */
export function onePerPair(
  books: BookSummary[],
  { pairedOnly = false }: { pairedOnly?: boolean } = {},
): BookSummary[] {
  const settled = (b: BookSummary) => b.pair && b.pair.status !== 'candidate';
  const winner = new Map<string, string>();
  for (const b of books) {
    if (!settled(b)) continue;
    const pairId = b.pair!.pairId;
    const kept = winner.get(pairId);
    if (kept === undefined || b.kind === 'ebook') winner.set(pairId, b.id);
  }
  return books.filter((b) => {
    if (!settled(b)) return !pairedOnly;
    return winner.get(b.pair!.pairId) === b.id;
  });
}

const libraryQuerySchema = z.object({
  query: z.string().max(200).optional(),
  kind: z.enum(['ebook', 'audio']).optional(),
  /**
   * The automatic shelves are values here rather than endpoints of their
   * own, so one code path still owns filtering, sorting, the missing-book
   * exclusion and the continue rail.
   */
  filter: z
    .enum(['paired', 'in-progress', 'finished', 'both-formats', 'recently-added'])
    .optional(),
  sort: z.enum(['title', 'author', 'recent', 'added']).optional(),
  /**
   * One of the library's own groupings, as `kind:value` - see shared/facets.
   * A value here, not an endpoint of its own, for the same reason the
   * automatic shelves are: one code path owns filtering, sorting, the
   * missing-book exclusion and the continue rail.
   */
  facet: z.string().max(120).optional(),
});

export function registerLibraryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/library', async (req, reply) => {
    const parsedQuery = libraryQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) return reply.code(400).send({ error: 'bad-query' });
    const q = parsedQuery.data;
    // Narrowed in SQL, not afterwards. Building a summary costs several
    // queries and a stat() per book, so a search that matches three titles in
    // a library of a thousand used to pay for all thousand before discarding
    // 997 of them. Everything below this point works on a short list.
    const where: string[] = ["scan_state != 'missing'"];
    const args: string[] = [];
    if (q.kind === 'ebook' || q.kind === 'audio') {
      where.push('kind = ?');
      args.push(q.kind);
    }
    if (q.query) {
      where.push(
        "(title LIKE ? COLLATE NOCASE OR COALESCE(author, '') LIKE ? COLLATE NOCASE" +
          " OR COALESCE(series, '') LIKE ? COLLATE NOCASE)",
      );
      const like = `%${q.query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      args.push(like, like, like);
    }
    const rows = db
      .prepare(`SELECT * FROM books WHERE ${where.join(' AND ')} ORDER BY title COLLATE NOCASE`)
      .all(...args) as Record<string, unknown>[];
    let books = rows.map((r) => bookRowToSummary(ctx, req.user!.id, r));
    if (q.filter === 'paired') books = books.filter((b) => b.pair && b.pair.status !== 'candidate');
    if (q.filter === 'in-progress')
      books = books.filter((b) => b.progress && !b.progress.finished && b.progress.pct > 0.001);
    if (q.filter === 'finished') books = books.filter((b) => b.progress?.finished);
    if (q.filter === 'both-formats') books = onePerPair(books, { pairedOnly: true });
    else if (q.kind === undefined && q.filter === undefined) {
      // A title owned twice is ONE title. Without this the shelf shows the
      // same book beside itself, once per format, which is how it read on a
      // library where most books are owned both ways.
      //
      // Only the open shelf (and the facet views, which are the same shelf
      // narrowed by author or series) collapses. Every named filter keeps its
      // own meaning: `paired` is about pairs and wants both halves, and
      // `in-progress` / `finished` are per-book - finishing the audiobook is
      // not finishing the ebook, and merging them would hide one of the two.
      books = onePerPair(books);
    }
    if (q.facet) {
      const parsed = parseFacet(q.facet);
      if (!parsed) return reply.code(400).send({ error: 'bad-facet' });
      const { kind, value } = parsed;
      // Author, series and language are columns on the book; everything else
      // is in the facet table. One place knows which is which.
      const ids = bookIdsWithFacet(db, kind, value);
      if (ids) books = books.filter((b) => ids.has(b.id));
      else {
        const want = foldFacet(value);
        const column = (b: BookSummary) =>
          kind === 'author' ? b.author : kind === 'series' ? b.series : b.language;
        books = books.filter((b) => foldFacet(column(b) ?? '') === want);
      }
    }
    if (q.filter === 'recently-added') {
      // What the last scan turned up. Distinct from sort=added, which
      // reorders the whole library instead of isolating the new arrivals.
      const cutoff = Date.now() - RECENTLY_ADDED_DAYS * 86400000;
      books = books
        .filter((b) => Date.parse(b.addedAt) >= cutoff)
        .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))
        .slice(0, RECENTLY_ADDED_LIMIT);
    }

    switch (q.sort) {
      case 'recent':
        books.sort(
          (a, b) =>
            Date.parse(b.progress?.updatedAt ?? b.addedAt) -
            Date.parse(a.progress?.updatedAt ?? a.addedAt),
        );
        break;
      case 'author':
        books.sort((a, b) => (a.author ?? '￿').localeCompare(b.author ?? '￿'));
        break;
      case 'added':
        books.sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
        break;
      default:
        break; // title order from SQL
    }

    // Continue-listening/reading rail: most recently touched, unfinished.
    const continueRail = books
      .filter((b) => b.progress && !b.progress.finished)
      .sort((a, b) => Date.parse(b.progress!.updatedAt) - Date.parse(a.progress!.updatedAt))
      .slice(0, 8)
      .map((b) => b.id);

    const scanning = db
      .prepare(
        `SELECT COUNT(*) AS c FROM jobs WHERE state IN ('queued','running') AND type IN ('scan','index-ebook','index-audio')`,
      )
      .get() as { c: number };

    return { books, continueRail, scanActive: scanning.c > 0 };
  });

  /**
   * Every way this particular library can be browsed, with counts.
   *
   * Computed rather than configured: a library with one publisher is not
   * offered a Publishers group, and one with three hundred authors is. The
   * client decides which of these to show, but not which exist.
   */
  app.get('/api/facets', async () => ({ groups: facetGroups(db) }));

  app.post('/api/library/rescan', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const id = enqueueJob(db, 'scan', {}, { dedupeKey: 'scan' });
    return { jobId: id, queued: id !== null };
  });

  app.get('/api/library/roots', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const roots = libraryRoots(db, ctx.config);
    return { ...roots, readOnly: true };
  });
  app.get('/api/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: 'not-found' });
    const summary = bookRowToSummary(ctx, req.user!.id, row);
    const chapters = db
      .prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx')
      .all(id) as Record<string, unknown>[];
    const tracks = db
      .prepare('SELECT * FROM audio_tracks WHERE book_id = ? ORDER BY idx')
      .all(id) as Record<string, unknown>[];
    const meta = JSON.parse(String(row.meta_json ?? '{}'));
    return {
      book: summary,
      description: meta.description ?? null,
      direction: meta.direction ?? 'ltr',
      totalChars: meta.totalChars ?? null,
      chapters: chapters.map((c) => ({
        idx: Number(c.idx),
        title: String(c.title),
        spineIdx: c.spine_idx === null ? null : Number(c.spine_idx),
        href: (c.href as string) ?? null,
        startMs: c.start_ms === null ? null : Number(c.start_ms),
        endMs: c.end_ms === null ? null : Number(c.end_ms),
      })),
      tracks: tracks.map((t) => ({
        idx: Number(t.idx),
        durationMs: Number(t.duration_ms),
        startMsAbsolute: Number(t.start_ms_absolute),
        sizeBytes: Number(t.size_bytes),
        format: String(t.format),
        title: (t.title as string) ?? null,
      })),
    };
  });

  app.get('/api/books/:id/cover', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT cover_path FROM books WHERE id = ?').get(id) as
      { cover_path: string | null } | undefined;
    if (!row?.cover_path || !fs.existsSync(row.cover_path)) {
      return reply.code(404).send({ error: 'no-cover' });
    }
    const ext = row.cover_path.split('.').pop()?.toLowerCase();
    const type =
      ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'svg'
            ? 'image/svg+xml'
            : 'image/jpeg';
    reply.header('content-type', type);
    if (ext === 'svg') {
      reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    }
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(fs.createReadStream(row.cover_path));
  });

  /**
   * The book itself, as a file, for keeping.
   *
   * Distinct from "download for offline", which caches the same bytes inside
   * the app so they can be read on a plane and removed again. This hands over
   * a copy that leaves with the reader, so it is gated on a capability an
   * admin grants a person rather than on the role they read with.
   *
   * An audiobook is usually many files; `?track=N` picks one, because a
   * server that streams books should not also be building zip archives of
   * them in memory.
   */
  app.get('/api/books/:id/export', async (req, reply) => {
    if (!requireExport(db, req, reply)) return reply;
    const { id } = req.params as { id: string };
    const q = z.object({ track: z.coerce.number().int().min(0).max(10_000).optional() });
    const parsed = q.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad-query' });

    const book = db
      .prepare("SELECT * FROM books WHERE id = ? AND scan_state != 'missing'")
      .get(id) as Record<string, unknown> | undefined;
    if (!book) return reply.code(404).send({ error: 'not-found' });

    let relPath = String(book.rel_path);
    if (String(book.kind) === 'audio') {
      const idx = parsed.data.track ?? 0;
      const track = db
        .prepare('SELECT rel_path FROM audio_tracks WHERE book_id = ? AND idx = ?')
        .get(id, idx) as { rel_path: string } | undefined;
      if (!track) return reply.code(404).send({ error: 'no-track' });
      relPath = track.rel_path;
    }

    let abs: string;
    try {
      // Resolves symlinks and refuses anything that lands outside the mount.
      abs = realResolveWithin(String(book.root_dir), relPath);
    } catch {
      return reply.code(404).send({ error: 'not-found' });
    }
    if (!fs.existsSync(abs)) return reply.code(404).send({ error: 'file-missing' });

    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', contentDisposition(posix.basename(relPath)));
    // Never cached by a shared proxy: this is one person's entitlement.
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(fs.createReadStream(abs));
  });
}

/**
 * A `content-disposition` a browser will accept for any filename.
 *
 * Book filenames carry quotes, commas, semicolons and non-ASCII - all of
 * which break a bare `filename="..."`. The ASCII fallback is sanitised and
 * the real name goes in `filename*` (RFC 5987), which every current browser
 * prefers.
 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
