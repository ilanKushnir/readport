import {
  type Locator,
  type TranslationBook,
  type TranslationMapResponse,
  type TranslationTitle,
} from '@readport/shared';
import { api } from '../api/client';
import { recordCheckpoint } from '../progress/engine';

/**
 * Carrying on in another language: find this place in the other edition,
 * and the address of its reader or player opened there.
 */

/**
 * A book's format as the library badges name it: EPUB, M4B, MP3 - or, for an
 * audiobook that is a folder of files, the word for audio.
 */
export function formatLabel(
  book: { kind: 'ebook' | 'audio'; format: string },
  audioWord: string,
): string {
  if (book.kind === 'ebook') return (book.format || 'epub').toUpperCase();
  return !book.format || book.format === 'multi' ? audioWord : book.format.toUpperCase();
}

/** A title's book of one kind - the ebook to read, the audiobook to listen to. */
export function bookOf(title: TranslationTitle, kind: 'ebook' | 'audio'): TranslationBook | null {
  return title.books.find((b) => b.kind === kind) ?? null;
}

/** The title's book to open first: the one this reader was in last, else its ebook. */
export function leadBook(title: TranslationTitle): TranslationBook {
  const last = title.progress && title.books.find((b) => b.id === title.progress!.bookId);
  return last ?? title.books[0]!;
}

/**
 * The other edition's reader or player, at the carried place, saying where
 * it came from so it can greet the reader with the language they left.
 */
export function continueUrl(res: TranslationMapResponse, fromLanguage: string | null): string {
  const via =
    `&handoff=1&via=translation&granularity=${res.precision}` +
    (fromLanguage ? `&fromLang=${encodeURIComponent(fromLanguage)}` : '');
  if (res.to.medium === 'ebook') {
    const sentence = res.to.sentenceId ? `&sentence=${encodeURIComponent(res.to.sentenceId)}` : '';
    return `/read/${res.bookId}?spine=${res.to.spineIdx}&char=${res.to.charOffset ?? 0}${sentence}${via}`;
  }
  return `/listen/${res.bookId}?track=${res.to.trackIdx}&pos=${res.to.positionMs}${via}`;
}

/**
 * Where `from` in this book is in `toBookId`. The place left is recorded as
 * a switch first, so going back finds the reader where they were.
 */
export async function carryOver(
  fromBookId: string,
  from: Locator,
  toBookId: string,
): Promise<TranslationMapResponse> {
  const res = await api<TranslationMapResponse>(`/api/books/${fromBookId}/translations/map`, {
    method: 'POST',
    body: { from, toBookId, mode: 'start' },
  });
  void recordCheckpoint(fromBookId, 'switch', from);
  return res;
}
