import { type DB, nowIso } from '../db/index.js';
import { newId } from '../util/ids.js';

/**
 * Which books are the same work in other languages (migration 24).
 *
 * Two levels, kept apart on purpose:
 *
 * - A TITLE is one edition of a work in one language: an ebook, an
 *   audiobook, or the two of them when they are paired. Pairing already
 *   says an ebook and an audiobook are one book; nothing here repeats it.
 * - A GROUP is the titles that are one work: the English title, its Russian
 *   translation, its German one.
 *
 * A row in `translations` puts one book in a group, and its title comes
 * with it: the paired audiobook of a linked ebook is in the group without a
 * row of its own. So a book paired after it was linked brings its other
 * half along, and one unpaired later leaves with its pair - the group never
 * has to be told either happened.
 */

const SETTLED = "status IN ('auto','confirmed')";

/** The books that are one title with this one: itself, and whatever it is paired with. */
export function titleBooks(db: DB, bookId: string): string[] {
  const seen = [bookId];
  const partners = db.prepare(
    `SELECT CASE WHEN ebook_id = ? THEN audio_id ELSE ebook_id END AS id FROM pairs
      WHERE (ebook_id = ? OR audio_id = ?) AND ${SETTLED}`,
  );
  // A pair is two books, but a manual link can give an ebook two narrations:
  // follow the pairs to the end, however few steps that is.
  for (let i = 0; i < seen.length && seen.length < 16; i++) {
    const id = seen[i]!;
    for (const row of partners.all(id, id, id) as { id: string }[]) {
      if (!seen.includes(row.id)) seen.push(row.id);
    }
  }
  return seen;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

/** The group a book is in, through itself or through the book it is paired with. */
export function groupOf(db: DB, bookId: string): string | null {
  const books = titleBooks(db, bookId);
  const row = db
    .prepare(
      `SELECT group_id FROM translations WHERE book_id IN (${placeholders(books.length)})
        ORDER BY linked_at, book_id LIMIT 1`,
    )
    .get(...books) as { group_id: string } | undefined;
  return row?.group_id ?? null;
}

/**
 * Every title in a group, each as its books. The order is the order the
 * titles joined, which is stable between two requests.
 */
export function groupTitles(db: DB, groupId: string): string[][] {
  const members = db
    .prepare('SELECT book_id FROM translations WHERE group_id = ? ORDER BY linked_at, book_id')
    .all(groupId) as { book_id: string }[];
  const titles: string[][] = [];
  const placed = new Set<string>();
  for (const { book_id } of members) {
    if (placed.has(book_id)) continue;
    const books = titleBooks(db, book_id);
    for (const id of books) placed.add(id);
    titles.push(books);
  }
  return titles;
}

/** The other titles this book is the same work as, each as its books. Empty when it is linked to nothing. */
export function otherTitles(db: DB, bookId: string): string[][] {
  const group = groupOf(db, bookId);
  if (!group) return [];
  const mine = new Set(titleBooks(db, bookId));
  return groupTitles(db, group).filter((books) => !books.some((id) => mine.has(id)));
}

/** Every book that is this one in another language, any format. */
export function translationBookIds(db: DB, bookId: string): string[] {
  return otherTitles(db, bookId).flat();
}

export class TranslationLinkError extends Error {
  constructor(readonly code: 'same-title' | 'same-language' | 'not-found') {
    super(code);
  }
}

function languageOf(db: DB, ids: string[]): string | null {
  const row = db
    .prepare(
      `SELECT language FROM books WHERE id IN (${placeholders(ids.length)}) AND language IS NOT NULL
        ORDER BY CASE kind WHEN 'ebook' THEN 0 ELSE 1 END LIMIT 1`,
    )
    .get(...ids) as { language: string } | undefined;
  return row?.language ?? null;
}

/**
 * Say that two books are the same work in different languages.
 *
 * Their groups become one: linking the Russian edition to the English one
 * that is already linked to the German makes all three one work. Linking
 * two books of the same title (a book and its own audiobook) is pairing,
 * not this, and two titles in the same language are two editions of one
 * language, which is not this either - both are refused.
 *
 * Returns the group they are in now.
 */
export function linkTranslations(db: DB, bookId: string, otherId: string, by: string): string {
  const exists = db.prepare('SELECT 1 FROM books WHERE id = ?');
  if (!exists.get(bookId) || !exists.get(otherId)) throw new TranslationLinkError('not-found');
  const mine = titleBooks(db, bookId);
  const theirs = titleBooks(db, otherId);
  if (mine.some((id) => theirs.includes(id))) throw new TranslationLinkError('same-title');
  const la = languageOf(db, mine);
  const lb = languageOf(db, theirs);
  if (la && lb && la === lb) throw new TranslationLinkError('same-language');

  const ga = groupOf(db, bookId);
  const gb = groupOf(db, otherId);
  if (ga && ga === gb) return ga;
  const group = ga ?? gb ?? newId('tr');
  const at = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    // Two groups meeting: the one being joined keeps its id.
    if (ga && gb) db.prepare('UPDATE translations SET group_id = ? WHERE group_id = ?').run(ga, gb);
    const add = db.prepare(
      'INSERT OR IGNORE INTO translations (book_id, group_id, linked_by, linked_at) VALUES (?, ?, ?, ?)',
    );
    if (!ga) add.run(bookId, group, by, at);
    if (!gb) add.run(otherId, group, by, at);
    // A pairing made after one half was linked can leave the other half in
    // a group of its own; the title is one, so its groups are too.
    mergeTitle(db, mine, group);
    mergeTitle(db, theirs, group);
    // Said no to once, and now yes: the yes stands.
    forgetDismissals(db, mine, theirs);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return group;
}

/** Fold any other group a title's books are in into `group`. Inside a transaction. */
function mergeTitle(db: DB, books: string[], group: string): void {
  const others = db
    .prepare(
      `SELECT DISTINCT group_id FROM translations
        WHERE book_id IN (${placeholders(books.length)}) AND group_id != ?`,
    )
    .all(...books, group) as { group_id: string }[];
  const move = db.prepare('UPDATE translations SET group_id = ? WHERE group_id = ?');
  for (const { group_id } of others) move.run(group, group_id);
}

/**
 * After two books are paired: a title in two groups is one title, so its
 * groups become one. Nothing to do for the usual case of a pairing between
 * two books nobody has linked.
 */
export function healTitleGroups(db: DB, bookId: string): void {
  const books = titleBooks(db, bookId);
  const groups = db
    .prepare(
      `SELECT DISTINCT group_id FROM translations WHERE book_id IN (${placeholders(books.length)})
        ORDER BY group_id`,
    )
    .all(...books) as { group_id: string }[];
  if (groups.length < 2) return;
  const keep = groupOf(db, bookId)!;
  db.exec('BEGIN IMMEDIATE');
  try {
    mergeTitle(db, books, keep);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Take a title out of the group this book is in: "this is not the same
 * book after all". Remembered as a dismissal, so the suggestion that
 * probably made it is not made again. A group left with one title is no
 * group, and goes.
 */
export function unlinkTranslation(db: DB, bookId: string, otherId: string, by: string): boolean {
  const group = groupOf(db, bookId);
  if (!group || groupOf(db, otherId) !== group) return false;
  const theirs = titleBooks(db, otherId);
  const mine = titleBooks(db, bookId);
  if (mine.some((id) => theirs.includes(id))) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM translations WHERE book_id IN (${placeholders(theirs.length)})`).run(
      ...theirs,
    );
    rememberDismissal(db, bookId, otherId, by);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (groupTitles(db, group).length < 2)
    db.prepare('DELETE FROM translations WHERE group_id = ?').run(group);
  return true;
}

/** The two ids in the order the dismissal and alignment tables keep them. */
export function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function rememberDismissal(db: DB, a: string, b: string, by: string): void {
  const [x, y] = ordered(a, b);
  db.prepare(
    `INSERT INTO translation_dismissals (book_a, book_b, decided_by, decided_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (book_a, book_b) DO UPDATE SET decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
  ).run(x, y, by, nowIso());
}

/** "These are not the same book": the suggestion goes, and does not come back. */
export function dismissSuggestion(db: DB, bookId: string, otherId: string, by: string): void {
  rememberDismissal(db, bookId, otherId, by);
}

function forgetDismissals(db: DB, mine: string[], theirs: string[]): void {
  const drop = db.prepare('DELETE FROM translation_dismissals WHERE book_a = ? AND book_b = ?');
  for (const a of mine) for (const b of theirs) drop.run(...ordered(a, b));
}

/** Whether a curator has said these two titles are not the same book. */
export function dismissed(db: DB, mine: string[], theirs: string[]): boolean {
  const q = db.prepare('SELECT 1 FROM translation_dismissals WHERE book_a = ? AND book_b = ?');
  for (const a of mine) for (const b of theirs) if (q.get(...ordered(a, b))) return true;
  return false;
}
