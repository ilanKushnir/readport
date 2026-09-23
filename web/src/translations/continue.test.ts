import { describe, expect, it } from 'vitest';
import { type TranslationTitle } from '@readport/shared';
import { bookOf, continueUrl, formatLabel, leadBook } from './continue';
import { landingNote } from './LanguagesSheet';
import { editionFor } from '../pages/FriendsPage';

/** A Russian title with an ebook and an audiobook, as the book detail names it. Invented. */
const russian = (over: Partial<TranslationTitle> = {}): TranslationTitle => ({
  language: 'ru',
  title: 'Фонарь Пепельной гавани',
  author: 'Ривка Шарон',
  books: [
    { id: 'ru-ebook', kind: 'ebook', format: 'epub', hasCover: true },
    { id: 'ru-audio', kind: 'audio', format: 'multi', hasCover: false },
  ],
  progress: null,
  match: 'close',
  ...over,
});

describe('continuing in another language', () => {
  it('opens the reader at the carried place, saying where it came from', () => {
    expect(
      continueUrl(
        {
          bookId: 'ru-ebook',
          precision: 'paragraph',
          to: { medium: 'ebook', spineIdx: 2, charOffset: 40, sentenceId: 's1', pct: 0.5 },
        },
        'en',
      ),
    ).toBe(
      '/read/ru-ebook?spine=2&char=40&sentence=s1&handoff=1&via=translation&granularity=paragraph&fromLang=en',
    );
  });

  it('opens the player at the carried time', () => {
    expect(
      continueUrl(
        {
          bookId: 'ru-audio',
          precision: 'proportional',
          to: { medium: 'audio', trackIdx: 1, positionMs: 5000, bookMs: 65000, pct: 0.4 },
        },
        null,
      ),
    ).toBe('/listen/ru-audio?track=1&pos=5000&handoff=1&via=translation&granularity=proportional');
  });

  it('picks the book to open: the one read last, else the ebook', () => {
    expect(leadBook(russian()).id).toBe('ru-ebook');
    expect(
      leadBook(
        russian({
          progress: {
            bookId: 'ru-audio',
            pct: 0.3,
            finished: false,
            updatedAt: '2026-09-01T00:00:00Z',
          },
        }),
      ).id,
    ).toBe('ru-audio');
    expect(bookOf(russian(), 'audio')?.id).toBe('ru-audio');
  });

  it('says what opening will do: the same paragraph only when the texts are matched', () => {
    expect(landingNote(russian(), 'ebook')).toBe('translations.continue.paragraph');
    expect(landingNote(russian({ match: 'rough' }), 'ebook')).toBe(
      'translations.continue.paragraph',
    );
    expect(landingNote(russian({ match: 'pending' }), 'ebook')).toBe(
      'translations.continue.pending',
    );
    expect(landingNote(russian({ match: 'none' }), 'audio')).toBe(
      'translations.continue.approximate',
    );
  });

  it('names a format the way the library badges do', () => {
    expect(formatLabel({ kind: 'ebook', format: 'epub' }, 'AUDIO')).toBe('EPUB');
    expect(formatLabel({ kind: 'audio', format: 'm4b' }, 'AUDIO')).toBe('M4B');
    expect(formatLabel({ kind: 'audio', format: 'multi' }, 'AUDIO')).toBe('AUDIO');
  });
});

describe('recommending a book in more than one language', () => {
  const editions = [
    { bookId: 'en-ebook', title: 'The Lantern of Ash Harbor', language: 'en' },
    { bookId: 'ru-ebook', title: 'Фонарь Пепельной гавани', language: 'ru' },
  ];

  it('hands a friend the edition in the language they read in', () => {
    expect(editionFor(editions, 'ru').bookId).toBe('ru-ebook');
  });

  it('hands them this one when their language is unknown or not among the editions', () => {
    expect(editionFor(editions, null).bookId).toBe('en-ebook');
    expect(editionFor(editions, 'de').bookId).toBe('en-ebook');
  });
});
