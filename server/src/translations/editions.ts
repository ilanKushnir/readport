import fs from 'node:fs';
import { type TranslationSuggestion, type TranslationTitle } from '@readport/shared';
import { type AppContext } from '../context.js';
import { getProgressState } from '../progress/service.js';
import { bookVisible } from '../library/visibility.js';
import { otherTitles, titleBooks } from './groups.js';
import { ensureMatches, matchState } from './store.js';
import { type Suggestion } from './suggest.js';

/**
 * A book's other languages, as the book page and the reader show them: each
 * title with its books, where this reader is in it, and how closely its
 * text has been matched to this one's.
 */

interface BookRow {
  id: string;
  kind: string;
  format: string;
  title: string;
  author: string | null;
  language: string | null;
  cover_path: string | null;
}

function bookRow(ctx: AppContext, id: string): BookRow | undefined {
  return ctx.db
    .prepare('SELECT id, kind, format, title, author, language, cover_path FROM books WHERE id = ?')
    .get(id) as BookRow | undefined;
}

const byKind = (a: { kind: string }, b: { kind: string }) =>
  (a.kind === 'ebook' ? 0 : 1) - (b.kind === 'ebook' ? 0 : 1);

/**
 * The other titles of this book's work, as this person may see them: a
 * hidden book is not there for a reader, and a title whose books are all
 * hidden is not there at all.
 */
export function translationTitles(
  ctx: AppContext,
  userId: string,
  bookId: string,
  sees: boolean,
): TranslationTitle[] {
  const { db } = ctx;
  const mine = titleBooks(db, bookId);
  const titles: TranslationTitle[] = [];
  let pending = false;
  for (const books of otherTitles(db, bookId)) {
    const rows = books
      .filter((id) => bookVisible(db, id, sees))
      .map((id) => bookRow(ctx, id))
      .filter((r): r is BookRow => !!r)
      .sort(byKind);
    if (rows.length === 0) continue;
    const lead = rows[0]!;
    let progress: TranslationTitle['progress'] = null;
    for (const r of rows) {
      const state = getProgressState(db, userId, r.id);
      if (state && (!progress || Date.parse(state.updatedAt) > Date.parse(progress.updatedAt)))
        progress = {
          bookId: r.id,
          pct: state.locator.pct,
          finished: state.finished,
          updatedAt: state.updatedAt,
        };
    }
    const match = matchState(
      db,
      mine,
      rows.map((r) => r.id),
    );
    if (match === 'pending') pending = true;
    titles.push({
      language: lead.language ?? rows.find((r) => r.language)?.language ?? null,
      title: lead.title,
      author: lead.author ?? rows.find((r) => r.author)?.author ?? null,
      books: rows.map((r) => ({
        id: r.id,
        kind: r.kind === 'audio' ? 'audio' : 'ebook',
        format: r.format,
        hasCover: !!r.cover_path && fs.existsSync(r.cover_path),
      })),
      progress,
      match,
    });
  }
  // Something is on its way: make sure it is actually queued. Cheap when it is.
  if (pending) ensureMatches(db, bookId);
  return titles.sort(
    (a, b) => (a.language ?? '').localeCompare(b.language ?? '') || a.title.localeCompare(b.title),
  );
}

/** A suggestion as the API hands it out. */
export function suggestionDto(s: Suggestion): TranslationSuggestion {
  return {
    language: s.title.language,
    title: s.title.title,
    author: s.title.author,
    books: s.title.books,
    score: s.score,
    evidence: s.evidence,
  };
}
