import { type DB } from '../db/index.js';

/**
 * Hidden books.
 *
 * An admin can take a book off everyone else's shelves without taking it off
 * the server. A hidden book is on no list, in no count and behind no link
 * for anybody but an admin signed in to ReadPort itself - not a curator, and
 * not an API key, even an admin's, because a key hands the library to
 * another app. To everyone else it is simply not there: every route that
 * names it answers 404, the same answer as a book that never existed, so a
 * guessed id learns nothing.
 *
 * Nothing attached to it is deleted. Progress, notes, shelves, the reading
 * list, a friend's recommendation: all of it waits, untouched, and is there
 * again the moment the book is shown again.
 *
 * A pair is one title in two editions, and it is only as visible as its
 * less visible half. Otherwise a reader would meet the hidden edition
 * through the one they can see - its format on the card, a switch to it in
 * the player. Hiding a paired book hides both editions for that reason (see
 * the admin route); a pair that forms later between a hidden book and a
 * shown one is, to a reader, no pair at all, and the shown book stands on
 * its own.
 */

/** Who is asking, as far as hidden books are concerned. */
export interface Viewer {
  user: { role: string } | null;
  authVia?: 'session' | 'proxy' | 'apikey';
}

/** Whether this request may see hidden books: an admin, not through a key. */
export function seesHidden(viewer: Viewer): boolean {
  return viewer.user?.role === 'admin' && viewer.authVia !== 'apikey';
}

/**
 * SQL keeping only the books a viewer may see, over the books table as
 * `alias`. No bound parameters, so it drops into any WHERE or ON clause
 * without disturbing the argument order around it.
 */
export function visibleSql(sees: boolean, alias = 'b'): string {
  return sees ? '1' : `${alias}.hidden_at IS NULL`;
}

/**
 * SQL keeping only the pairs a viewer may see, over the pairs table as
 * `alias`: both editions shown, or an admin asking.
 */
export function visiblePairSql(sees: boolean, alias = 'p'): string {
  if (sees) return '1';
  return `NOT EXISTS (SELECT 1 FROM books hx
    WHERE hx.id IN (${alias}.ebook_id, ${alias}.audio_id) AND hx.hidden_at IS NOT NULL)`;
}

/** Whether a book exists and this viewer may see it. */
export function bookVisible(db: DB, bookId: string, sees: boolean): boolean {
  const row = db.prepare('SELECT hidden_at FROM books WHERE id = ?').get(bookId) as
    { hidden_at: string | null } | undefined;
  return row !== undefined && (sees || row.hidden_at === null);
}

/**
 * Whether a pair's editions are both there for this viewer. A pair that
 * does not exist answers true: the route that asked will say 404 itself,
 * in its own words.
 */
export function pairVisible(db: DB, pairId: string, sees: boolean): boolean {
  if (sees) return true;
  const row = db
    .prepare(`SELECT ${visiblePairSql(false, 'p')} AS shown FROM pairs p WHERE p.id = ?`)
    .get(pairId) as { shown: number } | undefined;
  return row === undefined || Number(row.shown) === 1;
}

/**
 * Hide a book, or show it again - and its settled other edition with it,
 * because the library shows a title owned twice as one book and hiding half
 * of one would leave the other standing in its place. A `candidate` is a
 * guess nobody has confirmed, so it does not carry the decision across.
 *
 * Returns the ids it applied to, the book's own first.
 */
export function setHidden(db: DB, bookId: string, hidden: boolean, by: string): string[] {
  const partners = (
    db
      .prepare(
        `SELECT CASE WHEN ebook_id = ? THEN audio_id ELSE ebook_id END AS id FROM pairs
          WHERE (ebook_id = ? OR audio_id = ?) AND status IN ('auto','confirmed')`,
      )
      .all(bookId, bookId, bookId) as { id: string }[]
  ).map((r) => r.id);
  const ids = [bookId, ...partners.filter((id) => id !== bookId)];
  const at = new Date().toISOString();
  const write = hidden
    ? db.prepare('UPDATE books SET hidden_at = ?, hidden_by = ? WHERE id = ? AND hidden_at IS NULL')
    : db.prepare('UPDATE books SET hidden_at = NULL, hidden_by = NULL WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ids) {
      if (hidden) write.run(at, by, id);
      else write.run(id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return ids;
}
