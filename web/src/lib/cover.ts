import { type BookSummary, type CoverSourceName } from '@readport/shared';

/**
 * Where a book's cover is fetched from. Its version is part of the address,
 * so a cover that has changed is fetched afresh rather than shown from the
 * browser's cached copy of the old one.
 */
export function coverSrc(book: Pick<BookSummary, 'id' | 'coverV'>): string {
  return `/api/books/${book.id}/cover${book.coverV ? `?v=${encodeURIComponent(book.coverV)}` : ''}`;
}

/** The catalogues covers are looked up in, by the names they go by everywhere. */
export const COVER_SOURCE_NAME: Record<CoverSourceName, string> = {
  apple: 'Apple Books',
  audible: 'Audible',
  google: 'Google Books',
  openlibrary: 'Open Library',
};
