import { randomUUID } from 'node:crypto';
import {
  EMPTY_PLACES_DOC,
  type EbookLocator,
  type PlacesDoc,
  foldReadingPlace,
  placesDocSchema,
} from '@readport/shared';
import { type DB, nowIso } from '../db/index.js';

/**
 * Where each person reads each book (see places.ts in the shared package
 * for what a place is). Folded from applied progress inside the transaction
 * that applied it, like the stats diary, so the places and the position can
 * never disagree about what happened.
 */

export function readPlacesDoc(db: DB, userId: string, bookId: string): PlacesDoc {
  const row = db
    .prepare('SELECT doc_json FROM reading_places WHERE user_id = ? AND book_id = ?')
    .get(userId, bookId) as { doc_json: string } | undefined;
  if (!row) return EMPTY_PLACES_DOC;
  try {
    const parsed = placesDocSchema.safeParse(JSON.parse(row.doc_json));
    // A document this build cannot read starts again rather than failing
    // the checkpoint that brought the reader here.
    return parsed.success ? parsed.data : EMPTY_PLACES_DOC;
  } catch {
    return EMPTY_PLACES_DOC;
  }
}

export function writePlacesDoc(db: DB, userId: string, bookId: string, doc: PlacesDoc): void {
  db.prepare(
    `INSERT INTO reading_places (user_id, book_id, doc_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, book_id) DO UPDATE SET doc_json = excluded.doc_json,
       updated_at = excluded.updated_at`,
  ).run(userId, bookId, JSON.stringify(doc), nowIso());
}

export interface PlacesFolder {
  /** Fold one applied ebook checkpoint. Runs inside the caller's transaction. */
  fold(userId: string, bookId: string, atIso: string, locator: EbookLocator): void;
}

export function preparePlacesFolder(db: DB): PlacesFolder {
  // A book's length, asked once per batch: a drained queue is mostly one book.
  const lengths = new Map<string, number | null>();
  const lengthOf = (bookId: string): number | null => {
    if (!lengths.has(bookId)) {
      const row = db.prepare('SELECT meta_json FROM books WHERE id = ?').get(bookId) as
        { meta_json: string | null } | undefined;
      let chars: number | null = null;
      try {
        const total = (JSON.parse(row?.meta_json ?? '{}') as { totalChars?: unknown }).totalChars;
        if (typeof total === 'number' && total > 0) chars = total;
      } catch {
        /* no length: the fold assumes a novel's */
      }
      lengths.set(bookId, chars);
    }
    return lengths.get(bookId) ?? null;
  };
  return {
    fold(userId, bookId, atIso, locator) {
      const doc = readPlacesDoc(db, userId, bookId);
      const next = foldReadingPlace(doc, { at: atIso, locator }, lengthOf(bookId), () =>
        randomUUID().slice(0, 12),
      );
      writePlacesDoc(db, userId, bookId, next);
    },
  };
}
