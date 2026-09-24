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
import {
  type FacetScope,
  bookIdsWithFacet,
  facetGroups,
  wholeLibrary,
  foldFacet,
  languageListWhere,
  matchesLanguage,
  parseLanguageList,
} from '../../library/facets.js';
import { setBookLanguageOverride } from '../../library/language.js';
import { requestLanguageBackfill } from '../../library/redetect.js';
import { BOOK_LANGUAGES, normaliseLanguage } from '@readport/shared';
import { requireRole } from '../../auth/roles.js';
import { libraryRoots } from '../../domain/settings.js';
import { type AppContext } from '../../context.js';
import { enqueueJob } from '../../jobs/queue.js';
import { handoffStatus, latestAlignment, isSwitchable } from '../../alignment/service.js';
import {
  FINISHED_WHERE,
  READING_NOW_WHERE,
  getProgressState,
  isReadingNow,
} from '../../progress/service.js';
import { requireExport } from '../../auth/roles.js';
import { seesHidden, setHidden, visiblePairSql, visibleSql } from '../../library/visibility.js';
import { realResolveWithin } from '../../util/paths.js';
import { zipStream, type ZipEntry } from '../../util/zip.js';
import { translationTitles } from '../../translations/editions.js';
import { richDescription } from '../../library/rich-text.js';

/**
 * @param sees whether the person asking may see hidden books (see
 *   library/visibility.ts). Off unless a caller says otherwise: a pair with a
 *   hidden edition is then no pair at all, and the book stands on its own -
 *   the safe way round, since forgetting to pass it costs an admin a card
 *   label and never shows a reader the hidden half.
 */
export function bookRowToSummary(
  ctx: AppContext,
  userId: string,
  row: Record<string, unknown>,
  sees = false,
): BookSummary {
  const { db } = ctx;
  const id = String(row.id);
  const pairRow = db
    .prepare(
      `SELECT p.* FROM pairs p
        WHERE (p.ebook_id = ? OR p.audio_id = ?) AND p.status IN ('auto','confirmed','candidate')
          AND ${visiblePairSql(sees, 'p')}
        ORDER BY CASE p.status WHEN 'confirmed' THEN 0 WHEN 'auto' THEN 1 ELSE 2 END, p.score DESC
        LIMIT 1`,
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
    // And where this reader stands in it. A collapsed row speaks for both
    // editions, so it has to be able to name the one it is not showing -
    // otherwise collapsing would hide half the progress it collapsed.
    const otherState = getProgressState(db, userId, otherBookId);
    pair = {
      pairId: String(pairRow.id),
      otherBookId,
      otherKind: (other?.kind ??
        (String(row.kind) === 'ebook' ? 'audio' : 'ebook')) as BookSummary['kind'],
      otherFormat: other?.format ?? '',
      otherProgress: otherState
        ? {
            pct: otherState.locator.pct,
            updatedAt: otherState.updatedAt,
            finished: otherState.finished,
          }
        : null,
      status: String(pairRow.status) as NonNullable<BookSummary['pair']>['status'],
      switchable: isSwitchable(handle),
      handoff: handoffStatus(handle),
    };
  }
  const state = getProgressState(db, userId, id);
  // Who hid it, by the name they go by now. Only an admin is ever handed a
  // hidden book, so only an admin ever reads this.
  const hidden = row.hidden_at
    ? {
        at: String(row.hidden_at),
        by: row.hidden_by
          ? ((
              db
                .prepare('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?')
                .get(String(row.hidden_by)) as { name: string } | undefined
            )?.name ?? null)
          : null,
      }
    : null;
  const cover = row.cover_path
    ? fs.statSync(String(row.cover_path), { throwIfNoEntry: false })
    : undefined;
  return {
    id,
    kind: String(row.kind) as BookSummary['kind'],
    title: String(row.title),
    author: (row.author as string) ?? null,
    series: (row.series as string) ?? null,
    seriesIdx: (row.series_idx as number) ?? null,
    language: (row.language as string) ?? null,
    languageSource: (row.language_source as BookSummary['languageSource']) ?? null,
    format: String(row.format),
    scanState: String(row.scan_state) as BookSummary['scanState'],
    scanError: (row.scan_error as string) ?? null,
    durationMs: (row.duration_ms as number) ?? null,
    sizeBytes: Number(row.size_bytes ?? 0),
    hasCover: Boolean(cover),
    // Changes whenever the cover file does, so a new cover is not hidden
    // behind the old one's cached copy.
    coverV: cover ? Math.round(cover.mtimeMs).toString(36) : undefined,
    coverFound:
      row.found_cover_path && row.cover_path === row.found_cover_path
        ? ((row.found_cover_source as BookSummary['coverFound']) ?? 'edition')
        : undefined,
    addedAt: String(row.added_at),
    hidden,
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
 * By default the ebook side is kept because that is the side with the cover,
 * the fuller title and the page count; the audio side stands in when there is
 * no ebook row to keep. Order is preserved - the survivor sits where it
 * already was, so an alphabetical shelf stays alphabetical.
 *
 * Only settled pairs collapse. A `candidate` is a guess the user has not
 * confirmed, and hiding a book behind a guess would lose it.
 *
 * @param pairedOnly drop everything that is not half of a settled pair.
 * @param prefer which half survives. `touched` keeps the edition this reader
 *   moved in most recently, which is the only sensible answer on a shelf
 *   built out of progress: the row has to open where they actually are, and
 *   an untouched ebook standing in for the audiobook they are half way
 *   through would be a row that resumes at page one. Ties - two editions
 *   written in the same millisecond, which one queue drain routinely does -
 *   fall back to the ebook rule so the shelf is stable between requests.
 */
export function onePerPair(
  books: BookSummary[],
  {
    pairedOnly = false,
    prefer = 'ebook',
  }: { pairedOnly?: boolean; prefer?: 'ebook' | 'touched' } = {},
): BookSummary[] {
  const settled = (b: BookSummary) => b.pair && b.pair.status !== 'candidate';
  const touchedAt = (b: BookSummary) =>
    b.progress ? Date.parse(b.progress.updatedAt) : Number.NEGATIVE_INFINITY;
  const winner = new Map<string, BookSummary>();
  for (const b of books) {
    if (!settled(b)) continue;
    const pairId = b.pair!.pairId;
    const kept = winner.get(pairId);
    if (kept === undefined) {
      winner.set(pairId, b);
      continue;
    }
    if (prefer === 'touched' && touchedAt(b) !== touchedAt(kept)) {
      if (touchedAt(b) > touchedAt(kept)) winner.set(pairId, b);
      continue;
    }
    if (b.kind === 'ebook') winner.set(pairId, b);
  }
  return books.filter((b) => {
    if (!settled(b)) return !pairedOnly;
    return winner.get(b.pair!.pairId)?.id === b.id;
  });
}

/** How many books the home page's Continue band carries. */
const CONTINUE_RAIL = 8;

const libraryQuerySchema = z.object({
  query: z.string().max(200).optional(),
  kind: z.enum(['ebook', 'audio']).optional(),
  /**
   * The automatic shelves are values here rather than endpoints of their
   * own, so one code path still owns filtering, sorting, the missing-book
   * exclusion and the continue rail.
   */
  filter: z
    .enum([
      'paired',
      'unpaired',
      'reading-now',
      'in-progress',
      'finished',
      'both-formats',
      'recently-added',
      // What an admin has hidden from everybody else. Nobody else has any.
      'hidden',
    ])
    .optional(),
  sort: z.enum(['title', 'author', 'recent', 'added']).optional(),
  /**
   * One of the library's own groupings, as `kind:value` - see shared/facets.
   * A value here, not an endpoint of its own, for the same reason the
   * automatic shelves are: one code path owns filtering, sorting, the
   * missing-book exclusion and the continue rail.
   */
  facet: z.string().max(240).optional(),
  /**
   * Whether both halves of a pair collapse to one card. The default does on
   * the open shelf; `none` is for the one shelf whose members are chosen
   * elsewhere - what this browser has downloaded - where a downloaded
   * audiobook must not vanish behind its undownloaded ebook.
   */
  collapse: z.enum(['pair', 'none']).optional(),
  /**
   * The languages to keep, as codes joined with commas - `he,en` - and
   * `unknown` for the books with none. What the toolbar's language chips
   * send. Several at once, by a book's effective language, and it composes
   * with everything else here: a search, a shelf, a facet. Spellings a tag
   * might use ("eng", "pt-BR") are accepted; anything else is ignored.
   */
  lang: z.string().max(200).optional(),
});

/**
 * The shelves made of progress rather than of the library: the filters whose
 * rows come from `progress_state`, and which therefore collapse a pair by
 * what the reader touched last rather than by which format it is.
 * `in-progress` is the older name for `reading-now` and answers the same.
 */
function progressShelf(
  filter: string | undefined,
): filter is 'reading-now' | 'in-progress' | 'finished' {
  return filter === 'reading-now' || filter === 'in-progress' || filter === 'finished';
}

/**
 * The SQL that narrows the library for one request, shared by the grid and
 * by the facet counts beside it, so the two cannot disagree.
 */
function narrowing(
  q: z.infer<typeof libraryQuerySchema>,
  userId: string,
  sees: boolean,
): { from: string; where: string[]; args: unknown[]; progressWhere: string | null } {
  const progressWhere =
    q.filter === 'in-progress' || q.filter === 'reading-now'
      ? READING_NOW_WHERE
      : q.filter === 'finished'
        ? FINISHED_WHERE
        : null;
  const from = progressWhere ? 'books b JOIN progress_state p ON p.book_id = b.id' : 'books b';
  const where: string[] = [];
  const args: unknown[] = [];
  if (progressWhere) {
    where.push(progressWhere);
    args.push(userId);
  } else {
    where.push("b.scan_state != 'missing'");
  }
  // Hidden books, for everyone who may not see them: gone from every view,
  // count and shelf that is built from here.
  where.push(visibleSql(sees));
  if (q.filter === 'hidden') where.push(sees ? 'b.hidden_at IS NOT NULL' : '0');
  // Books that are not already half of a settled pair: what the manual
  // linker is allowed to offer. In SQL, with the rest of the narrowing,
  // because a library where most titles are owned twice would otherwise
  // build a summary for every book on the server only to throw half of
  // them away - and the pickers are two <select>s, not a paged grid.
  //
  // A `candidate` does NOT count as linked. It is a guess nobody has
  // answered yet, and the manual linker is exactly where a reader goes when
  // the guess is wrong, so hiding the book behind it would remove the cure
  // along with the symptom.
  if (q.filter === 'unpaired') {
    where.push(
      `NOT EXISTS (SELECT 1 FROM pairs pr WHERE pr.status IN ('auto','confirmed')
         AND (pr.ebook_id = b.id OR pr.audio_id = b.id) AND ${visiblePairSql(sees, 'pr')})`,
    );
  }
  if (q.kind === 'ebook' || q.kind === 'audio') {
    where.push('b.kind = ?');
    args.push(q.kind);
  }
  const languages = parseLanguageList(q.lang);
  if (languages) {
    const { clause, args: langArgs } = languageListWhere(languages);
    where.push(clause);
    args.push(...langArgs);
  }
  if (q.query) {
    where.push(
      "(b.title LIKE ? COLLATE NOCASE OR COALESCE(b.author, '') LIKE ? COLLATE NOCASE" +
        " OR COALESCE(b.series, '') LIKE ? COLLATE NOCASE)",
    );
    const like = `%${q.query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    args.push(like, like, like);
  }
  return { from, where, args, progressWhere };
}

export function registerLibraryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  // The library's one duty at startup: books indexed before the current
  // language detector are read again by a job that waits behind everything
  // else, a batch at a time, and finds nothing to do on a settled library.
  // Queued here because this is where the library comes up, and a queue
  // entry costs nothing until a worker - inline or the dedicated container -
  // picks it up.
  try {
    requestLanguageBackfill(db);
  } catch (err) {
    ctx.log.warn(`Could not queue the language backfill: ${(err as Error).message}`);
  }

  app.get('/api/library', async (req, reply) => {
    const parsedQuery = libraryQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) return reply.code(400).send({ error: 'bad-query' });
    const q = parsedQuery.data;
    const userId = req.user!.id;
    const sees = seesHidden(req);
    // Narrowed in SQL, not afterwards. Building a summary costs several
    // queries and a stat() per book, so a search that matches three titles in
    // a library of a thousand used to pay for all thousand before discarding
    // 997 of them. Everything below this point works on a short list.
    //
    // The progress shelves narrow the same way, through the one predicate the
    // sidebar counts with: Reading Now used to materialise the whole library
    // and keep three rows of it, every 2.5 seconds while a scan ran.
    const { from, where, args } = narrowing(q, userId, sees);
    const rows = db
      .prepare(
        `SELECT b.* FROM ${from} WHERE ${where.join(' AND ')} ORDER BY b.title COLLATE NOCASE`,
      )
      .all(...(args as never[])) as Record<string, unknown>[];
    let books = rows.map((r) => bookRowToSummary(ctx, userId, r, sees));
    if (q.filter === 'paired') books = books.filter((b) => b.pair && b.pair.status !== 'candidate');
    // The SQL already narrowed these; this only drops a row whose stored
    // state could not be parsed, which the summary reports as no progress.
    if (q.filter === 'in-progress' || q.filter === 'reading-now')
      books = books.filter((b) => isReadingNow(b.progress));
    if (q.filter === 'finished') books = books.filter((b) => b.progress?.finished);
    // A facet narrows EDITIONS, before a pair collapses to one card: a French
    // audiobook paired with an English ebook is a French audiobook, and
    // filtering after the collapse - which keeps the ebook - made it
    // unreachable from "Languages > French" while the sidebar still counted it.
    if (q.facet) {
      const parsed = parseFacet(q.facet);
      if (!parsed) return reply.code(400).send({ error: 'bad-facet' });
      const { kind, value } = parsed;
      // Author, series and language are columns on the book; everything else
      // is in the facet table. One place knows which is which.
      const ids = bookIdsWithFacet(db, kind, value);
      if (ids) books = books.filter((b) => ids.has(b.id));
      else if (kind === 'language') books = books.filter((b) => matchesLanguage(b.language, value));
      else {
        const want = foldFacet(value);
        const column = (b: BookSummary) => (kind === 'author' ? b.author : b.series);
        books = books.filter((b) => foldFacet(column(b) ?? '') === want);
      }
    }
    if (q.filter === 'both-formats') books = onePerPair(books, { pairedOnly: true });
    else if (progressShelf(q.filter) && q.kind === undefined && q.collapse !== 'none') {
      // A title owned twice is ONE title here too.
      //
      // This used NOT to happen, deliberately: progress is stored per book id
      // (`progress_state` is keyed on user_id + book_id), so finishing the
      // audiobook is not finishing the ebook, and a naive merge would hide
      // one of the two positions. That reasoning was right about the data and
      // wrong about the shelf - a reader who owns both formats saw the same
      // title twice in Reading Now and had to remember which row was which.
      //
      // What the old comment was protecting is kept instead of dropped:
      //  - the SURVIVOR is the edition this reader touched last, so the row
      //    resumes where they actually are;
      //  - the survivor is chosen from the editions that QUALIFY for this
      //    shelf, because the SQL above already returned only those. So a
      //    reader who finished the ebook and is half way through the
      //    audiobook gets the audiobook on Reading Now and the ebook on
      //    Finished: once on each shelf, never twice on either, and neither
      //    fact is hidden;
      //  - the row still carries the other edition's position
      //    (`pair.otherProgress`), so the client can name it and offer it;
      //  - resetting is still per edition, which is the granularity the
      //    store has;
      //  - and asking for one format (`kind=audio`) is still answered in that
      //    format. A question about editions deserves an answer about
      //    editions, so no collapse there, same as the open shelf.
      books = onePerPair(books, { prefer: 'touched' });
    } else if (
      q.kind === undefined &&
      (q.filter === undefined || q.filter === 'hidden') &&
      q.collapse !== 'none'
    ) {
      // The open shelf (and the facet views, which are the same shelf
      // narrowed by author or series). Here the ebook is the better survivor:
      // it has the cover, the fuller title and the page count, and nothing on
      // this shelf depends on where the reader is.
      //
      // `paired` still keeps both halves - it is about pairs, and a pair with
      // one half shown is not reviewable.
      books = onePerPair(books);
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

    // The Continue band: what this person most recently touched and has not
    // finished, whichever edition that is. Its own query rather than a pass
    // over the list above, because the list has been narrowed (a search, a
    // shelf) and collapsed to one card per pair - and a paired audiobook at
    // 40% was vanishing behind its untouched ebook, so the sidebar said
    // "Reading now 1" while the home page showed nothing to continue. Only
    // the open library shows the band, so only the open library pays for it.
    const home =
      q.filter === undefined &&
      q.facet === undefined &&
      !q.query &&
      q.kind === undefined &&
      q.lang === undefined;
    const continueRail = home
      ? onePerPair(
          (
            db
              .prepare(
                // Twice the band's width, because a pair read in both formats
                // takes two rows here and leaves one - so the band still fills
                // for a reader who owns most of their library twice.
                `SELECT b.* FROM progress_state p JOIN books b ON b.id = p.book_id
                 WHERE ${READING_NOW_WHERE} AND ${visibleSql(sees)}
                 ORDER BY p.updated_at DESC LIMIT ${CONTINUE_RAIL * 2}`,
              )
              .all(userId) as Record<string, unknown>[]
          ).map((r) => bookRowToSummary(ctx, userId, r, sees)),
          // Already in most-recent-first order, so the survivor of a pair is
          // the edition in front - the one being read now, not the one that
          // was read last month.
          { prefer: 'touched' },
        ).slice(0, CONTINUE_RAIL)
      : [];

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
  /**
   * Counted for the view in front of the reader when asked: the same
   * narrowing as `/api/library` - search, format, progress shelf - and
   * optionally a list of ids, which is how the one shelf the server cannot
   * see (what this browser downloaded) gets honest counts too. Without
   * parameters, the whole library, as before.
   */
  const facetQuerySchema = libraryQuerySchema
    .pick({ query: true, kind: true, filter: true, lang: true })
    .extend({
      ids: z.string().max(8192).optional(),
    });
  app.get('/api/facets', async (req, reply) => {
    const parsed = facetQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad-query' });
    const q = parsed.data;
    const sees = seesHidden(req);
    // Nothing to narrow by is the whole library, and the whole library keeps
    // its rule that a grouping with one value is not a way to browse.
    if (q.ids === undefined && !q.query && !q.kind && !q.filter && !q.lang) {
      return { groups: facetGroups(db, wholeLibrary(sees)) };
    }
    // Two scopes: the view as narrowed, and the same view before the
    // language chips narrowed it, which is what the languages are counted
    // over - a chip's count says what tapping it would show, not zero
    // because it is not tapped yet.
    const scopeOf = (query: typeof q): FacetScope => {
      const { from, where, args } = narrowing(query, req.user!.id, sees);
      if (q.ids !== undefined) {
        const ids = q.ids
          .split(',')
          .filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id))
          .slice(0, 400);
        where.push(ids.length ? `b.id IN (${ids.map(() => '?').join(',')})` : '0');
        args.push(...ids);
      }
      return { from, where: where.join(' AND '), args };
    };
    const scope = scopeOf(q);
    const languageScope = q.lang ? scopeOf({ ...q, lang: undefined }) : scope;
    return { groups: facetGroups(db, scope, languageScope) };
  });

  /**
   * A curator's word on what language a book is in. Null lets the evidence -
   * the file's own tag, a verified paired edition, the text - speak again.
   * Survives every rescan, which the tag in the file could not promise.
   */
  app.post('/api/books/:id/language', async (req, reply) => {
    if (!requireRole(req, reply, 'curator')) return reply;
    const { id } = req.params as { id: string };
    const parsed = z.object({ language: z.string().max(16).nullable() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const code = parsed.data.language === null ? null : normaliseLanguage(parsed.data.language);
    if (parsed.data.language !== null && (!code || !BOOK_LANGUAGES.some((l) => l.code === code)))
      return reply.code(400).send({ error: 'unsupported-language' });
    const row = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: 'not-found' });
    setBookLanguageOverride(db, id, code);
    const after = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as Record<string, unknown>;
    return { book: bookRowToSummary(ctx, req.user!.id, after, seesHidden(req)) };
  });

  /**
   * Hide a book from everyone but the admins, or show it again. Both
   * editions of a title owned twice go together (see library/visibility.ts),
   * and the answer names every book that changed so the client can update
   * the cards it holds without asking again.
   */
  app.post('/api/books/:id/hidden', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return reply;
    const { id } = req.params as { id: string };
    const parsed = z.object({ hidden: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    if (!db.prepare('SELECT 1 FROM books WHERE id = ?').get(id)) {
      return reply.code(404).send({ error: 'not-found' });
    }
    const ids = setHidden(db, id, parsed.data.hidden, req.user!.id);
    const after = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as Record<string, unknown>;
    return { book: bookRowToSummary(ctx, req.user!.id, after, true), ids };
  });

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
    const summary = bookRowToSummary(ctx, req.user!.id, row, seesHidden(req));
    const chapters = db
      .prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx')
      .all(id) as Record<string, unknown>[];
    const tracks = db
      .prepare('SELECT * FROM audio_tracks WHERE book_id = ? ORDER BY idx')
      .all(id) as Record<string, unknown>[];
    const meta = JSON.parse(String(row.meta_json ?? '{}'));
    return {
      book: summary,
      // The same book in other languages, as this reader may see them.
      translations: translationTitles(ctx, req.user!.id, id, seesHidden(req)),
      description: meta.description ?? null,
      // The same description, as blocks to lay out: its HTML or Markdown
      // read, and nothing that could run kept (library/rich-text.ts).
      about: richDescription(meta.description ?? null),
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

  /**
   * An audiobook's files, all of them, as one ZIP: what a reader who keeps
   * their books wants when the book is forty files. Under the same
   * permission as the export above, and built the same way it is sent -
   * stored, streamed, one pass over each file (util/zip.ts) - so a
   * gigabyte audiobook costs the server a read buffer, not a gigabyte, and
   * the browser is told the exact size up front and can show the progress.
   *
   * The files keep their own names, in a folder named for the book, in the
   * order they play.
   */
  app.get('/api/books/:id/archive', async (req, reply) => {
    if (!requireExport(db, req, reply)) return reply;
    const { id } = req.params as { id: string };
    const book = db
      .prepare("SELECT * FROM books WHERE id = ? AND kind = 'audio' AND scan_state != 'missing'")
      .get(id) as Record<string, unknown> | undefined;
    if (!book) return reply.code(404).send({ error: 'not-found' });
    const tracks = db
      .prepare('SELECT idx, rel_path FROM audio_tracks WHERE book_id = ? ORDER BY idx')
      .all(id) as { idx: number; rel_path: string }[];
    if (tracks.length === 0) return reply.code(404).send({ error: 'no-track' });

    const folder = archiveName(
      book.author ? `${String(book.title)} - ${String(book.author)}` : String(book.title),
    );
    const entries: ZipEntry[] = [];
    const taken = new Set<string>();
    for (const t of tracks) {
      let abs: string;
      let stat: fs.Stats;
      try {
        abs = realResolveWithin(String(book.root_dir), t.rel_path);
        stat = fs.statSync(abs);
      } catch {
        return reply.code(404).send({ error: 'file-missing' });
      }
      // Two parts called "track.mp3" in two folders are two files; the
      // number they play at tells them apart.
      let name = archiveName(posix.basename(t.rel_path));
      if (taken.has(name.toLowerCase())) name = `${String(t.idx + 1).padStart(3, '0')} ${name}`;
      taken.add(name.toLowerCase());
      entries.push({ name: `${folder}/${name}`, path: abs, size: stat.size, mtime: stat.mtime });
    }

    const zip = zipStream(entries);
    reply.header('content-type', 'application/zip');
    reply.header('content-length', zip.length);
    reply.header('content-disposition', contentDisposition(`${folder}.zip`));
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(zip.stream);
  });
}

/**
 * A name any unzip on any system will write as given: no path separators,
 * no characters Windows refuses, no control characters, no trailing dots
 * or spaces, and not so long that a folder plus a file name passes what a
 * file system allows.
 */
export function archiveName(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const chars = [...cleaned];
  return (chars.length > 120 ? chars.slice(0, 120).join('').trim() : cleaned) || 'Audiobook';
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
