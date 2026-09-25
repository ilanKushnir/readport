import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addToReadingListSchema,
  addToShelfSchema,
  bulkAddSchema,
  createShelfSchema,
  movePositionSchema,
  readingListNoteSchema,
  updateShelfSchema,
  RECENTLY_ADDED_DAYS,
  RECENTLY_ADDED_LIMIT,
  SHELVES_PER_USER_MAX,
  type ReadingListItem,
  type ShelfSummary,
  recommendedByIdSchema,
  type RecommendedBy,
} from '@readport/shared';
import { type AppContext } from '../../context.js';
import {
  FINISHED_WHERE,
  READING_NOW_WHERE,
  finishedWhere,
  readingNowWhere,
} from '../../progress/service.js';
import { type DB } from '../../db/index.js';
import { nowIso } from '../../db/index.js';
import { newId } from '../../util/ids.js';
import { between } from '../../util/rank.js';
import { bookRowToSummary } from './library.js';
import { bookVisible, seesHidden, visiblePairSql, visibleSql } from '../../library/visibility.js';
import { hasRole } from '../../auth/roles.js';

/**
 * Shelves and the reading list: the furniture each reader arranges for
 * themselves.
 *
 * No route here calls requireRole. Every /api/* path is already behind
 * requireUser + csrfCheck in the global onRequest hook, and these are
 * reader-level by nature - an admin's extra powers are about the library, not
 * about somebody else's shelves. The guard is OWNERSHIP, and it is
 * structural: every statement is scoped `WHERE user_id = ?`, and every shelf
 * sub-resource resolves through ownedShelf(). No route ever selects a shelf
 * by id alone. A miss answers 404 rather than 403, because a 403 would
 * confirm that another person's shelf id exists.
 */

interface ShelfRow {
  id: string;
  user_id: string;
  name: string;
  sort_key: string;
  created_at: string;
  updated_at: string;
}

/**
 * Queue a book at the end of someone's reading list, remembering who put it
 * there when it was not the reader: a friend's recommendation or a share
 * link. Idempotent - a book already queued keeps its place and its
 * provenance, because the reader's own choice is not overwritten by a
 * later nudge. Shared with the share routes, which know the sharer's id
 * when the client does not.
 */
export function queueBook(
  db: DB,
  userId: string,
  bookId: string,
  recommendedBy: string | null,
): { added: boolean } {
  const already = db
    .prepare('SELECT 1 FROM reading_list WHERE user_id = ? AND book_id = ?')
    .get(userId, bookId);
  if (already) return { added: false };
  const last = db
    .prepare('SELECT sort_key FROM reading_list WHERE user_id = ? ORDER BY sort_key DESC LIMIT 1')
    .get(userId) as { sort_key: string } | undefined;
  const now = nowIso();
  db.prepare(
    `INSERT INTO reading_list (user_id, book_id, sort_key, note, added_at, recommended_by, recommended_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    userId,
    bookId,
    between(last?.sort_key ?? null, null),
    now,
    recommendedBy,
    recommendedBy ? now : null,
  );
  return { added: true };
}

/**
 * The reading-list body, plus who recommended the book when somebody did.
 * Only the id travels; the name is looked up when the list is read, so a
 * renamed friend is shown under their current name.
 */
const queueBookSchema = addToReadingListSchema.extend({
  recommendedBy: recommendedByIdSchema.optional(),
});

function shelfRowToSummary(db: DB, row: ShelfRow, sees: boolean): ShelfSummary {
  const c = db
    .prepare(
      `SELECT COUNT(*) AS c FROM shelf_items i JOIN books b ON b.id = i.book_id
        WHERE i.shelf_id = ? AND ${visibleSql(sees)}`,
    )
    .get(row.id) as { c: number };
  return {
    id: row.id,
    name: row.name,
    count: Number(c.c),
    sortKey: row.sort_key,
    updatedAt: row.updated_at,
  };
}

export function registerShelfRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  /** The only way a shelf is ever fetched: by id AND owner, together. */
  const ownedShelf = (userId: string, shelfId: string): ShelfRow | undefined =>
    db.prepare('SELECT * FROM shelves WHERE id = ? AND user_id = ?').get(shelfId, userId) as
      ShelfRow | undefined;

  /** A book this person may put somewhere: one that exists and is not hidden from them. */
  const bookExists = (bookId: string, sees: boolean): boolean => bookVisible(db, bookId, sees);

  /**
   * Neighbour keys for a drop. Reads the key of the row the item now follows
   * and the key of whatever follows THAT, then mints one key between them.
   * `afterId` null means the item goes first.
   *
   * ORDER BY sort_key is BINARY throughout this file - the rank alphabet is
   * case-significant and a NOCASE comparison would make the order
   * non-deterministic.
   */
  function moveWithin(opts: {
    /** `SELECT <idColumn>, sort_key FROM …` for one list, ordered. */
    rows: { id: string; sort_key: string }[];
    afterId: string | null;
    /** The row being moved: it is not its own neighbour. */
    movingId: string;
  }): { ok: true; key: string } | { ok: false; error: 'stale-order' } {
    const others = opts.rows.filter((r) => r.id !== opts.movingId);
    if (opts.afterId === null) {
      return { ok: true, key: between(null, others[0]?.sort_key ?? null) };
    }
    const idx = others.findIndex((r) => r.id === opts.afterId);
    // The neighbour the client named is gone, or is the row itself: the
    // client's picture of the list is stale. It refetches and re-applies.
    if (idx < 0) return { ok: false, error: 'stale-order' };
    return { ok: true, key: between(others[idx]!.sort_key, others[idx + 1]?.sort_key ?? null) };
  }

  const shelfItemRows = (shelfId: string) =>
    db
      .prepare(
        'SELECT book_id AS id, sort_key FROM shelf_items WHERE shelf_id = ? ORDER BY sort_key',
      )
      .all(shelfId) as { id: string; sort_key: string }[];

  const readingListRows = (userId: string) =>
    db
      .prepare(
        'SELECT book_id AS id, sort_key FROM reading_list WHERE user_id = ? ORDER BY sort_key',
      )
      .all(userId) as { id: string; sort_key: string }[];

  /**
   * Ranking uses every row - a book on an unplugged drive still holds its
   * place in the queue - but a POSITION quoted back to the reader has to
   * count what the reading list page actually shows them, or the book page
   * says "3rd" above a list where the book is second.
   */
  const visibleReadingList = (userId: string, sees: boolean): string[] =>
    (
      db
        .prepare(
          `SELECT r.book_id AS id FROM reading_list r JOIN books b ON b.id = r.book_id
           WHERE r.user_id = ? AND b.scan_state != 'missing' AND ${visibleSql(sees)}
           ORDER BY r.sort_key`,
        )
        .all(userId) as { id: string }[]
    ).map((r) => r.id);

  /** 1-based place in the list the reader can see, or null if it is not in it. */
  const visiblePosition = (userId: string, bookId: string, sees: boolean): number | null => {
    const at = visibleReadingList(userId, sees).indexOf(bookId);
    return at < 0 ? null : at + 1;
  };

  /**
   * How long the reading list is, as its owner can see it: every row but the
   * hidden books. A book on an unplugged drive still counts, as it always has.
   */
  const queueLength = (userId: string, sees: boolean): number =>
    Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM reading_list r JOIN books b ON b.id = r.book_id
              WHERE r.user_id = ? AND ${visibleSql(sees)}`,
          )
          .get(userId) as { c: number }
      ).c,
    );

  const shelfCount = (shelfId: string, sees: boolean): number =>
    Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM shelf_items i JOIN books b ON b.id = i.book_id
              WHERE i.shelf_id = ? AND ${visibleSql(sees)}`,
          )
          .get(shelfId) as { c: number }
      ).c,
    );

  /* ------------------------------------------------------------ overview */

  /**
   * The whole sidebar in one request, because the sidebar is on every page.
   * Counts are COUNT(*) queries, never materialised book lists.
   */
  app.get('/api/shelves', async (req) => {
    const userId = req.user!.id;
    const sees = seesHidden(req);
    const one = (sql: string, ...params: unknown[]): number =>
      Number((db.prepare(sql).get(...(params as never[])) as { c: number }).c);

    // The same predicate the shelf itself is filtered by, so the number on
    // the rail is the number of rows behind it - and the same collapse. A
    // title owned in both formats is one row on these shelves, so it has to
    // be one in the count as well: rows, minus the settled pairs whose two
    // editions BOTH qualify and therefore arrive as a single row.
    const bothSidesQualify = (where: (p: string, b: string) => string): number =>
      one(
        `SELECT COUNT(*) AS c FROM pairs pr
           JOIN progress_state pe ON pe.book_id = pr.ebook_id
           JOIN books be ON be.id = pr.ebook_id
           JOIN progress_state pa ON pa.book_id = pr.audio_id
           JOIN books ba ON ba.id = pr.audio_id
          WHERE pr.status IN ('auto','confirmed')
            AND ${where('pe', 'be')} AND ${where('pa', 'ba')}
            AND ${visibleSql(sees, 'be')} AND ${visibleSql(sees, 'ba')}`,
        userId,
        userId,
      );
    const readingNow =
      one(
        `SELECT COUNT(*) AS c FROM progress_state p JOIN books b ON b.id = p.book_id
       WHERE ${READING_NOW_WHERE} AND ${visibleSql(sees)}`,
        userId,
      ) - bothSidesQualify(readingNowWhere);
    const finished =
      one(
        `SELECT COUNT(*) AS c FROM progress_state p JOIN books b ON b.id = p.book_id
       WHERE ${FINISHED_WHERE} AND ${visibleSql(sees)}`,
        userId,
      ) - bothSidesQualify(finishedWhere);
    // One count per PAIR, not per book: a title owned twice is one title.
    const bothFormats = one(
      `SELECT COUNT(*) AS c FROM pairs p
       JOIN books e ON e.id = p.ebook_id JOIN books a ON a.id = p.audio_id
       WHERE p.status IN ('auto','confirmed')
         AND (e.scan_state != 'missing' OR a.scan_state != 'missing')
         AND ${visibleSql(sees, 'e')} AND ${visibleSql(sees, 'a')}`,
    );
    const recentlyAdded = one(
      `SELECT COUNT(*) AS c FROM (
         SELECT id FROM books b WHERE scan_state != 'missing' AND added_at >= ?
           AND ${visibleSql(sees)}
         ORDER BY added_at DESC LIMIT ?
       )`,
      new Date(Date.now() - RECENTLY_ADDED_DAYS * 86400000).toISOString(),
      RECENTLY_ADDED_LIMIT,
    );

    const shelves = (
      db
        .prepare('SELECT * FROM shelves WHERE user_id = ? ORDER BY sort_key')
        .all(userId) as unknown as ShelfRow[]
    ).map((r) => shelfRowToSummary(db, r, sees));

    const queueCount = queueLength(userId, sees);
    const next = db
      .prepare(
        `SELECT b.id, b.title FROM reading_list r JOIN books b ON b.id = r.book_id
         WHERE r.user_id = ? AND b.scan_state != 'missing' AND ${visibleSql(sees)}
         ORDER BY r.sort_key LIMIT 1`,
      )
      .get(userId) as { id: string; title: string } | undefined;
    // What the admins have hidden, for the one shelf that shows it to them.
    // Counted per title, like the library it is a part of: a pair hidden
    // together is one book.
    const hidden = sees
      ? one(
          `SELECT COUNT(*) AS c FROM books b
            WHERE b.hidden_at IS NOT NULL AND b.scan_state != 'missing'
              AND NOT (b.kind = 'audio' AND EXISTS (
                SELECT 1 FROM pairs p JOIN books e ON e.id = p.ebook_id
                 WHERE p.audio_id = b.id AND p.status IN ('auto','confirmed')
                   AND e.hidden_at IS NOT NULL AND e.scan_state != 'missing'))`,
        )
      : 0;
    // Suggestions waiting on a decision, counted beside Pairing for the
    // people who can make one.
    const pairsToReview = hasRole(req.user?.role, 'curator')
      ? one(
          `SELECT COUNT(*) AS c FROM pairs p
            WHERE p.status = 'candidate' AND ${visiblePairSql(sees, 'p')}`,
        )
      : null;

    return {
      auto: [
        { id: 'reading-now', count: readingNow },
        { id: 'finished', count: finished },
        { id: 'both-formats', count: bothFormats },
        { id: 'recently-added', count: recentlyAdded },
      ],
      shelves,
      readingList: {
        count: queueCount,
        nextBookId: next?.id ?? null,
        nextTitle: next?.title ?? null,
      },
      ...(sees ? { hidden } : {}),
      ...(pairsToReview !== null ? { pairsToReview } : {}),
    };
  });

  /* -------------------------------------------------------------- shelves */

  app.post('/api/shelves', async (req, reply) => {
    const parsed = createShelfSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const userId = req.user!.id;
    const existing = db
      .prepare('SELECT COUNT(*) AS c FROM shelves WHERE user_id = ?')
      .get(userId) as { c: number };
    if (Number(existing.c) >= SHELVES_PER_USER_MAX) {
      return reply.code(409).send({ error: 'too-many-shelves' });
    }
    const last = db
      .prepare('SELECT sort_key FROM shelves WHERE user_id = ? ORDER BY sort_key DESC LIMIT 1')
      .get(userId) as { sort_key: string } | undefined;
    const id = newId('shelf');
    const now = nowIso();
    try {
      db.prepare(
        `INSERT INTO shelves (id, user_id, name, sort_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, parsed.data.name, between(last?.sort_key ?? null, null), now, now);
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'shelf-name-taken' });
      }
      throw err;
    }
    return reply
      .code(201)
      .send({ shelf: shelfRowToSummary(db, ownedShelf(userId, id)!, seesHidden(req)) });
  });

  app.patch('/api/shelves/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const shelf = ownedShelf(userId, id);
    if (!shelf) return reply.code(404).send({ error: 'not-found' });
    const parsed = updateShelfSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const { name, afterShelfId } = parsed.data;
    if (name !== undefined) {
      try {
        db.prepare('UPDATE shelves SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
          name,
          nowIso(),
          id,
          userId,
        );
      } catch (err) {
        if (String((err as Error).message).includes('UNIQUE')) {
          return reply.code(409).send({ error: 'shelf-name-taken' });
        }
        throw err;
      }
    }
    // An ABSENT afterShelfId means "do not move"; an explicit null means
    // "make it first". Only `!== undefined` can tell those apart.
    if (afterShelfId !== undefined) {
      const rows = db
        .prepare('SELECT id, sort_key FROM shelves WHERE user_id = ? ORDER BY sort_key')
        .all(userId) as { id: string; sort_key: string }[];
      const moved = moveWithin({ rows, afterId: afterShelfId, movingId: id });
      if (!moved.ok) return reply.code(409).send({ error: moved.error });
      db.prepare(
        'UPDATE shelves SET sort_key = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      ).run(moved.key, nowIso(), id, userId);
    }
    return { shelf: shelfRowToSummary(db, ownedShelf(userId, id)!, seesHidden(req)) };
  });

  app.delete('/api/shelves/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Membership rows go with it through the foreign key; no book and no
    // file on disk is touched.
    const res = db
      .prepare('DELETE FROM shelves WHERE id = ? AND user_id = ?')
      .run(id, req.user!.id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    return { ok: true };
  });

  const shelfBooksQuerySchema = z.object({
    sort: z.enum(['manual', 'title', 'author', 'added']).optional(),
  });

  app.get('/api/shelves/:id/books', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const shelf = ownedShelf(userId, id);
    if (!shelf) return reply.code(404).send({ error: 'not-found' });
    const parsedQuery = shelfBooksQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) return reply.code(400).send({ error: 'bad-query' });
    const sees = seesHidden(req);

    // sort_key ordering is BINARY: the rank alphabet is case-significant.
    // A hidden book is not on the shelf at all, as far as its owner can
    // tell - not even as one that is away.
    const rows = db
      .prepare(
        `SELECT b.*, s.sort_key AS shelf_sort_key FROM shelf_items s JOIN books b ON b.id = s.book_id
         WHERE s.shelf_id = ? AND ${visibleSql(sees)} ORDER BY s.sort_key`,
      )
      .all(id) as Record<string, unknown>[];
    // A book on an unmounted drive is still on the shelf. Counting it
    // separately lets the page say so instead of quietly shrinking.
    const present = rows.filter((r) => String(r.scan_state) !== 'missing');
    const books = present.map((r) => bookRowToSummary(ctx, userId, r, sees));
    switch (parsedQuery.data.sort) {
      case 'title':
        books.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'author':
        books.sort((a, b) => (a.author ?? '￿').localeCompare(b.author ?? '￿'));
        break;
      case 'added':
        books.sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
        break;
      default:
        break; // manual: the shelf's own order, from SQL
    }
    return {
      shelf: shelfRowToSummary(db, shelf, sees),
      books,
      missingCount: rows.length - present.length,
    };
  });

  /** Idempotent add. A second tap is a no-op, which is why this is a PUT. */
  app.put('/api/shelves/:id/books/:bookId', async (req, reply) => {
    const { id, bookId } = req.params as { id: string; bookId: string };
    const userId = req.user!.id;
    const shelf = ownedShelf(userId, id);
    if (!shelf) return reply.code(404).send({ error: 'not-found' });
    const sees = seesHidden(req);
    if (!bookExists(bookId, sees)) return reply.code(404).send({ error: 'not-found' });
    const parsed = addToShelfSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });

    const already = db
      .prepare('SELECT 1 FROM shelf_items WHERE shelf_id = ? AND book_id = ?')
      .get(id, bookId);
    if (already) return { added: false, count: shelfCount(id, sees) };

    const rows = shelfItemRows(id);
    let key: string;
    if (parsed.data.afterBookId === undefined) {
      key = between(rows[rows.length - 1]?.sort_key ?? null, null);
    } else {
      const moved = moveWithin({ rows, afterId: parsed.data.afterBookId, movingId: bookId });
      if (!moved.ok) return reply.code(409).send({ error: moved.error });
      key = moved.key;
    }
    db.prepare(
      'INSERT INTO shelf_items (shelf_id, book_id, sort_key, added_at) VALUES (?, ?, ?, ?)',
    ).run(id, bookId, key, nowIso());
    db.prepare('UPDATE shelves SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    return { added: true, count: shelfCount(id, sees) };
  });

  /** Bulk add, for "everything in this filtered view onto Summer". */
  app.post('/api/shelves/:id/books', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const shelf = ownedShelf(userId, id);
    if (!shelf) return reply.code(404).send({ error: 'not-found' });
    const parsed = bulkAddSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    let added = 0;
    let skipped = 0;
    const sees = seesHidden(req);
    const insert = db.prepare(
      'INSERT INTO shelf_items (shelf_id, book_id, sort_key, added_at) VALUES (?, ?, ?, ?)',
    );
    const now = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      let last =
        (
          db
            .prepare(
              'SELECT sort_key FROM shelf_items WHERE shelf_id = ? ORDER BY sort_key DESC LIMIT 1',
            )
            .get(id) as { sort_key: string } | undefined
        )?.sort_key ?? null;
      for (const bookId of parsed.data.bookIds) {
        const exists = bookExists(bookId, sees);
        const dup = db
          .prepare('SELECT 1 FROM shelf_items WHERE shelf_id = ? AND book_id = ?')
          .get(id, bookId);
        if (!exists || dup) {
          skipped++;
          continue;
        }
        last = between(last, null);
        insert.run(id, bookId, last, now);
        added++;
      }
      db.prepare('UPDATE shelves SET updated_at = ? WHERE id = ?').run(now, id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { added, skipped };
  });

  app.delete('/api/shelves/:id/books/:bookId', async (req, reply) => {
    const { id, bookId } = req.params as { id: string; bookId: string };
    const shelf = ownedShelf(req.user!.id, id);
    if (!shelf) return reply.code(404).send({ error: 'not-found' });
    const res = db
      .prepare('DELETE FROM shelf_items WHERE shelf_id = ? AND book_id = ?')
      .run(id, bookId);
    if (Number(res.changes) > 0) {
      db.prepare('UPDATE shelves SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    }
    return { removed: Number(res.changes) > 0, count: shelfCount(id, seesHidden(req)) };
  });

  app.patch('/api/shelves/:id/books/:bookId/position', async (req, reply) => {
    const { id, bookId } = req.params as { id: string; bookId: string };
    const shelf = ownedShelf(req.user!.id, id);
    if (!shelf) return reply.code(404).send({ error: 'not-found' });
    const parsed = movePositionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const rows = shelfItemRows(id);
    if (!rows.some((r) => r.id === bookId)) return reply.code(404).send({ error: 'not-found' });
    const moved = moveWithin({ rows, afterId: parsed.data.afterBookId, movingId: bookId });
    if (!moved.ok) return reply.code(409).send({ error: moved.error });
    db.prepare('UPDATE shelf_items SET sort_key = ? WHERE shelf_id = ? AND book_id = ?').run(
      moved.key,
      id,
      bookId,
    );
    db.prepare('UPDATE shelves SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    return { ok: true, sortKey: moved.key };
  });

  /* --------------------------------------------------------- reading list */

  app.get('/api/reading-list', async (req) => {
    const userId = req.user!.id;
    const sees = seesHidden(req);
    const rows = db
      .prepare(
        `SELECT b.*, r.note AS rl_note, r.added_at AS rl_added_at, r.sort_key AS rl_sort_key,
                r.recommended_by AS rl_recommended_by, r.recommended_at AS rl_recommended_at,
                ru.display_name AS rl_rec_display_name, ru.username AS rl_rec_username
         FROM reading_list r JOIN books b ON b.id = r.book_id
         LEFT JOIN users ru ON ru.id = r.recommended_by
         WHERE r.user_id = ? AND ${visibleSql(sees)} ORDER BY r.sort_key`,
      )
      .all(userId) as Record<string, unknown>[];
    const present = rows.filter((r) => String(r.scan_state) !== 'missing');
    const items: (ReadingListItem & { recommendedBy: RecommendedBy | null })[] = present.map(
      (r) => ({
        book: bookRowToSummary(ctx, userId, r, sees),
        note: (r.rl_note as string) ?? null,
        addedAt: String(r.rl_added_at),
        sortKey: String(r.rl_sort_key),
        // Who put it here, while their account exists: the column is set
        // null when the recommender is deleted, and the join then finds nobody.
        recommendedBy:
          r.rl_recommended_by && r.rl_rec_username
            ? {
                userId: String(r.rl_recommended_by),
                displayName: String(r.rl_rec_display_name ?? r.rl_rec_username),
                at: String(r.rl_recommended_at ?? r.rl_added_at),
              }
            : null,
      }),
    );
    return { items, missingCount: rows.length - present.length };
  });

  app.put('/api/reading-list/:bookId', async (req, reply) => {
    const { bookId } = req.params as { bookId: string };
    const userId = req.user!.id;
    const sees = seesHidden(req);
    if (!bookExists(bookId, sees)) return reply.code(404).send({ error: 'not-found' });
    const parsed = queueBookSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    // A recommender is another account that exists; anything else is a
    // malformed request, not a mystery to store.
    const recommendedBy = parsed.data.recommendedBy ?? null;
    if (
      recommendedBy !== null &&
      (recommendedBy === userId ||
        db.prepare('SELECT 1 FROM users WHERE id = ?').get(recommendedBy) === undefined)
    ) {
      return reply.code(400).send({ error: 'invalid', detail: 'Unknown recommender' });
    }
    const rows = readingListRows(userId);
    const existing = rows.findIndex((r) => r.id === bookId);
    // A placement was ASKED FOR: `position` or `afterBookId` was sent. An
    // empty body means "just queue it", and for a book already queued that is
    // rightly a no-op.
    const placement = parsed.data.afterBookId !== undefined || parsed.data.position !== undefined;

    if (existing >= 0 && !placement) {
      if (parsed.data.note !== undefined) {
        db.prepare('UPDATE reading_list SET note = ? WHERE user_id = ? AND book_id = ?').run(
          parsed.data.note,
          userId,
          bookId,
        );
      }
      return {
        added: false,
        moved: false,
        position: visiblePosition(userId, bookId, sees),
        count: queueLength(userId, sees),
      };
    }

    // Read next on a book that is already 7th has to MOVE it to the front.
    // Reporting "it is 7th" while the button said "front of the queue" is the
    // button lying, and the reader has no way to see which one is true
    // without opening the list.
    let key: string;
    if (parsed.data.afterBookId !== undefined) {
      const moved = moveWithin({ rows, afterId: parsed.data.afterBookId, movingId: bookId });
      if (!moved.ok) return reply.code(409).send({ error: moved.error });
      key = moved.key;
    } else {
      const others = rows.filter((r) => r.id !== bookId);
      key =
        parsed.data.position === 'top'
          ? between(null, others[0]?.sort_key ?? null)
          : between(others[others.length - 1]?.sort_key ?? null, null);
    }
    if (existing >= 0) {
      db.prepare('UPDATE reading_list SET sort_key = ? WHERE user_id = ? AND book_id = ?').run(
        key,
        userId,
        bookId,
      );
      if (parsed.data.note !== undefined) {
        db.prepare('UPDATE reading_list SET note = ? WHERE user_id = ? AND book_id = ?').run(
          parsed.data.note,
          userId,
          bookId,
        );
      }
    } else {
      const now = nowIso();
      db.prepare(
        `INSERT INTO reading_list (user_id, book_id, sort_key, note, added_at, recommended_by, recommended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        userId,
        bookId,
        key,
        parsed.data.note ?? null,
        now,
        recommendedBy,
        recommendedBy ? now : null,
      );
    }
    return {
      added: existing < 0,
      moved: existing >= 0,
      position: visiblePosition(userId, bookId, sees),
      count: queueLength(userId, sees),
    };
  });

  app.delete('/api/reading-list/:bookId', async (req) => {
    const { bookId } = req.params as { bookId: string };
    const res = db
      .prepare('DELETE FROM reading_list WHERE user_id = ? AND book_id = ?')
      .run(req.user!.id, bookId);
    return { removed: Number(res.changes) > 0 };
  });

  app.patch('/api/reading-list/:bookId/position', async (req, reply) => {
    const { bookId } = req.params as { bookId: string };
    const userId = req.user!.id;
    const parsed = movePositionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const rows = readingListRows(userId);
    if (!rows.some((r) => r.id === bookId)) return reply.code(404).send({ error: 'not-found' });
    const moved = moveWithin({ rows, afterId: parsed.data.afterBookId, movingId: bookId });
    if (!moved.ok) return reply.code(409).send({ error: moved.error });
    db.prepare('UPDATE reading_list SET sort_key = ? WHERE user_id = ? AND book_id = ?').run(
      moved.key,
      userId,
      bookId,
    );
    return { ok: true, sortKey: moved.key };
  });

  /**
   * The queue has notes and a shelf does not: "after the sequel" and "book
   * club, November" are things you write about a POSITION, not about a book.
   */
  app.patch('/api/reading-list/:bookId', async (req, reply) => {
    const { bookId } = req.params as { bookId: string };
    const parsed = readingListNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const res = db
      .prepare('UPDATE reading_list SET note = ? WHERE user_id = ? AND book_id = ?')
      .run(parsed.data.note, req.user!.id, bookId);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    return { ok: true };
  });

  /* ---------------------------------------------------------- memberships */

  /** Two indexed lookups, so the book page can open its Add-to panel pre-ticked. */
  app.get('/api/books/:id/shelves', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sees = seesHidden(req);
    if (!bookExists(id, sees)) return reply.code(404).send({ error: 'not-found' });
    const userId = req.user!.id;
    const rows = db
      .prepare(
        `SELECT s.id FROM shelf_items i JOIN shelves s ON s.id = i.shelf_id
         WHERE i.book_id = ? AND s.user_id = ?`,
      )
      .all(id, userId) as { id: string }[];
    const queued = db
      .prepare('SELECT 1 FROM reading_list WHERE user_id = ? AND book_id = ?')
      .get(userId, id);
    // Where in the queue, so the book page can say "3rd" rather than merely
    // "queued" - and it must be the third row of the list the reader can
    // open, so books on an unmounted drive are not counted past.
    const position = queued ? visiblePosition(userId, id, sees) : null;
    return {
      shelfIds: rows.map((r) => r.id),
      onReadingList: queued !== undefined,
      readingListPosition: position,
    };
  });
}
