import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../../context.js';
import { nowIso } from '../../db/index.js';
import { newId } from '../../util/ids.js';
import { bookRowToSummary } from './library.js';
import { bookVisible, seesHidden, visibleSql } from '../../library/visibility.js';
import { RECOMMENDATION_NOTE_MAX } from '../../friends/prefs.js';
import {
  acceptedFriends,
  areFriends,
  currentlyReading,
  friendColours,
  friendProgress,
  friendshipBetween,
  friendshipRows,
  personOf,
  readingLanguage,
  sharesProgress,
} from '../../friends/service.js';

/**
 * Friends: asking, answering, unfriending; where friends are in a book; and
 * putting a book in front of one.
 *
 * No route here calls requireRole - every /api/* path is already behind
 * requireUser in the global hook, and none of this is about rank. The guard
 * is the ROW: every statement is scoped to the caller's own id, a request
 * can only be accepted by the person it was sent to, and a position is only
 * ever read across an accepted friendship whose other side is sharing (see
 * friends/service.ts). A miss answers 404 rather than 403 where a 403 would
 * confirm that somebody else's row exists.
 */

const idSchema = z.string().min(1).max(64);

export function registerFriendRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const activeUser = (id: string) =>
    db
      .prepare("SELECT id, username, display_name FROM users WHERE id = ? AND status = 'active'")
      .get(id) as { id: string; username: string; display_name: string | null } | undefined;

  const bookExists = (bookId: string, sees: boolean): boolean => bookVisible(db, bookId, sees);

  /* ---------------------------------------------------------------- lists */

  app.get('/api/friends', async (req) => {
    const me = req.user!.id;
    const rows = friendshipRows(db, me);
    const accepted = rows.filter((r) => r.status === 'accepted');
    const colours = friendColours(
      ctx,
      me,
      accepted.map((r) => ({ userId: r.user_id })),
    );
    const friends = accepted.map((r) => {
      const person = personOf(r);
      // What THEY decided, read fresh: switching sharing off has to take
      // effect on the next request, not the next sign-in.
      const shares = sharesProgress(ctx, person.userId);
      return {
        ...person,
        friendshipId: r.id,
        since: r.responded_at ?? r.created_at,
        colour: colours.get(person.userId)!,
        sharesProgress: shares,
        reading: shares ? currentlyReading(db, person.userId, seesHidden(req)) : null,
        // Which edition to hand them when a book is in more than one language.
        language: readingLanguage(ctx, person.userId, seesHidden(req)),
      };
    });
    const pending = (mine: boolean) =>
      rows
        .filter((r) => r.status === 'pending' && (r.requester_id === me) === mine)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .map((r) => ({ id: r.id, ...personOf(r), createdAt: r.created_at }));
    // Everyone else on the server who is not already on a row with this
    // person. Listing the other accounts is appropriate here: nobody gets an
    // account without an admin or an invitation, so this is the household,
    // not the public.
    const known = new Set(rows.map((r) => r.user_id));
    known.add(me);
    const people = (
      db
        .prepare(
          `SELECT id AS user_id, username, display_name FROM users WHERE status = 'active'
            ORDER BY COALESCE(display_name, username) COLLATE NOCASE, username COLLATE NOCASE`,
        )
        .all() as { user_id: string; username: string; display_name: string | null }[]
    )
      .filter((u) => !known.has(u.user_id))
      .map(personOf);
    return { friends, incoming: pending(false), outgoing: pending(true), people };
  });

  /* ------------------------------------------------------------- requests */

  app.post('/api/friends/requests', async (req, reply) => {
    const parsed = z.object({ userId: idSchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const me = req.user!.id;
    const them = parsed.data.userId;
    if (them === me) return reply.code(400).send({ error: 'self' });
    if (!activeUser(them)) return reply.code(404).send({ error: 'not-found' });
    const existing = friendshipBetween(db, me, them);
    if (existing) {
      if (existing.status === 'accepted') {
        return reply.code(409).send({ error: 'already-friends' });
      }
      if (existing.requester_id === me) {
        return reply.code(409).send({ error: 'already-requested' });
      }
      // They asked first. Two people each wanting to be friends is a yes
      // from both sides, not a second request to be answered.
      db.prepare("UPDATE friendships SET status = 'accepted', responded_at = ? WHERE id = ?").run(
        nowIso(),
        existing.id,
      );
      return { status: 'accepted', id: existing.id, userId: them };
    }
    const id = newId('fr');
    try {
      db.prepare(
        `INSERT INTO friendships (id, requester_id, addressee_id, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      ).run(id, me, them, nowIso());
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'already-requested' });
      }
      throw err;
    }
    return reply.code(201).send({ status: 'pending', id, userId: them });
  });

  /** Only the person asked can say yes. */
  app.post('/api/friends/requests/:id/accept', async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = db
      .prepare(
        `UPDATE friendships SET status = 'accepted', responded_at = ?
          WHERE id = ? AND addressee_id = ? AND status = 'pending'`,
      )
      .run(nowIso(), id, req.user!.id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    return { ok: true };
  });

  /**
   * Declining deletes the row, so a declined request can simply be asked
   * again. The requester withdrawing their own request is the same deletion,
   * so it is the same route.
   */
  app.post('/api/friends/requests/:id/decline', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!.id;
    const res = db
      .prepare(
        `DELETE FROM friendships
          WHERE id = ? AND status = 'pending' AND (addressee_id = ? OR requester_id = ?)`,
      )
      .run(id, me, me);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    return { ok: true };
  });

  /** Either party. Their colour and their place on your bars stay in your prefs, harmlessly, in case they are back. */
  app.delete('/api/friends/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const me = req.user!.id;
    const res = db
      .prepare(
        `DELETE FROM friendships
          WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
      )
      .run(me, userId, userId, me);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    return { ok: true };
  });

  /* ------------------------------------------------------------- progress */

  /**
   * Where this person's friends are in one book: what the reader draws on
   * its bar and the book page prints under the hero. `friendCount` says
   * whether there is anyone to recommend it to even when nobody has opened
   * it yet.
   */
  app.get('/api/friends/progress', async (req, reply) => {
    const q = z.object({ bookId: idSchema }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'bad-query' });
    const me = req.user!.id;
    return {
      friends: friendProgress(ctx, me, q.data.bookId, seesHidden(req)),
      friendCount: acceptedFriends(db, me).length,
    };
  });

  /* ------------------------------------------------------ recommendations */

  const recommendSchema = z.object({
    toUserId: idSchema,
    bookId: idSchema,
    note: z.string().trim().max(RECOMMENDATION_NOTE_MAX).nullable().optional(),
  });

  app.post('/api/friends/recommend', async (req, reply) => {
    const parsed = recommendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const me = req.user!.id;
    const { toUserId, bookId } = parsed.data;
    if (toUserId === me) return reply.code(400).send({ error: 'self' });
    if (!activeUser(toUserId)) return reply.code(404).send({ error: 'not-found' });
    // Only to a friend. A request that was never answered is not consent to
    // be sent things.
    if (!areFriends(db, me, toUserId)) return reply.code(403).send({ error: 'not-friends' });
    if (!bookExists(bookId, seesHidden(req))) return reply.code(404).send({ error: 'not-found' });
    // A hidden book is not one to hand to somebody: they could not open it.
    if (!bookVisible(db, bookId, false)) return reply.code(409).send({ error: 'hidden' });
    // Once, until they have dealt with it: the same book from the same
    // person twice is a nudge, and the inbox is not for nudging.
    const open = db
      .prepare(
        `SELECT 1 FROM recommendations
          WHERE from_user_id = ? AND to_user_id = ? AND book_id = ? AND dismissed_at IS NULL`,
      )
      .get(me, toUserId, bookId);
    if (open) return reply.code(409).send({ error: 'already-recommended' });
    const id = newId('rec');
    const note = parsed.data.note ? parsed.data.note : null;
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO recommendations (id, from_user_id, to_user_id, book_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, me, toUserId, bookId, note, createdAt);
    return reply.code(201).send({ recommendation: { id, toUserId, bookId, note, createdAt } });
  });

  /**
   * What friends have put in front of this person, newest first, until it
   * is dismissed. A recommendation outlives the friendship it was made in:
   * it was delivered, and unfriending someone does not unread their note.
   */
  app.get('/api/friends/inbox', async (req) => {
    const me = req.user!.id;
    const sees = seesHidden(req);
    const rows = db
      .prepare(
        `SELECT r.id, r.book_id, r.note, r.created_at, r.seen_at,
                u.id AS user_id, u.username, u.display_name
           FROM recommendations r JOIN users u ON u.id = r.from_user_id
          WHERE r.to_user_id = ? AND r.dismissed_at IS NULL
          ORDER BY r.created_at DESC, r.id LIMIT 100`,
      )
      .all(me) as {
      id: string;
      book_id: string;
      note: string | null;
      created_at: string;
      seen_at: string | null;
      user_id: string;
      username: string;
      display_name: string | null;
    }[];
    const recommendations = [];
    for (const r of rows) {
      // No foreign key on book_id (migration 18): a book that has left the
      // library takes its recommendation off the page, not out of the table.
      // So does a hidden one, until it is shown again.
      const book = db
        .prepare(`SELECT * FROM books b WHERE b.id = ? AND ${visibleSql(sees)}`)
        .get(r.book_id) as Record<string, unknown> | undefined;
      if (!book) continue;
      recommendations.push({
        id: r.id,
        book: bookRowToSummary(ctx, me, book, sees),
        from: personOf(r),
        note: r.note,
        createdAt: r.created_at,
        seenAt: r.seen_at,
      });
    }
    return { recommendations };
  });

  app.post('/api/friends/inbox/:id/seen', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!.id;
    const res = db
      .prepare(
        `UPDATE recommendations SET seen_at = COALESCE(seen_at, ?)
          WHERE id = ? AND to_user_id = ? AND dismissed_at IS NULL`,
      )
      .run(nowIso(), id, me);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    const row = db.prepare('SELECT seen_at FROM recommendations WHERE id = ?').get(id) as {
      seen_at: string;
    };
    return { ok: true, seenAt: row.seen_at };
  });

  /** Dismissing is also seeing: the sender is told it was looked at, not what was done with it. */
  app.post('/api/friends/inbox/:id/dismiss', async (req, reply) => {
    const { id } = req.params as { id: string };
    const now = nowIso();
    const res = db
      .prepare(
        `UPDATE recommendations SET dismissed_at = COALESCE(dismissed_at, ?), seen_at = COALESCE(seen_at, ?)
          WHERE id = ? AND to_user_id = ?`,
      )
      .run(now, now, id, req.user!.id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    return { ok: true };
  });

  /** What this person recommended, and whether it has been looked at. Dismissal is the recipient's business and is not reported. */
  app.get('/api/friends/sent', async (req) => {
    const rows = db
      .prepare(
        `SELECT r.id, r.note, r.created_at, r.seen_at,
                u.id AS user_id, u.username, u.display_name,
                b.id AS book_id, b.title, b.author, b.kind
           FROM recommendations r
           JOIN users u ON u.id = r.to_user_id
           JOIN books b ON b.id = r.book_id AND ${visibleSql(seesHidden(req))}
          WHERE r.from_user_id = ?
          ORDER BY r.created_at DESC, r.id LIMIT 100`,
      )
      .all(req.user!.id) as {
      id: string;
      note: string | null;
      created_at: string;
      seen_at: string | null;
      user_id: string;
      username: string;
      display_name: string | null;
      book_id: string;
      title: string;
      author: string | null;
      kind: string;
    }[];
    return {
      sent: rows.map((r) => ({
        id: r.id,
        to: personOf(r),
        book: { id: r.book_id, title: r.title, author: r.author, kind: r.kind },
        note: r.note,
        createdAt: r.created_at,
        seenAt: r.seen_at,
      })),
    };
  });
}
