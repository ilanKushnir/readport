import { describe, expect, it } from 'vitest';
import {
  authorSimilarity,
  nameForms,
  scoreTranslation,
  skeleton,
  type TitleFacts,
} from './suggest.js';

/**
 * Guessing translations. Every name and title here is invented: an author
 * who writes in English, the same author as a Russian or a Hebrew edition
 * spells her, and a second author with the same surname.
 */

const title = (over: Partial<TitleFacts>): TitleFacts => ({
  id: over.id ?? 'x',
  books: [{ id: over.id ?? 'x', kind: 'ebook', format: 'epub', hasCover: false }],
  title: 'The Lantern of Ash Harbor',
  author: 'Rivka Sharon',
  language: 'en',
  series: null,
  seriesIdx: null,
  chars: 200_000,
  durationMs: null,
  chapters: 24,
  ...over,
});

describe('author names across alphabets', () => {
  it('romanizes and sorts the words, so script and word order do not matter', () => {
    expect(nameForms('Rivka Sharon', 'en').roman).toBe('rivka sharon');
    expect(nameForms('Ривка Шарон', 'ru').roman).toBe('rivka sharon');
    expect(nameForms('Шарон, Ривка', 'ru').roman).toBe('rivka sharon');
  });

  it('folds the letters scripts spell differently into one skeleton', () => {
    expect(skeleton('sharon')).toBe('srn');
    expect(skeleton('shrvn')).toBe('srbn');
    expect(skeleton('rivka')).toBe(skeleton('rbkh'));
  });

  it('knows the same author in Latin, Cyrillic and Hebrew letters', () => {
    const en = nameForms('Rivka Sharon', 'en');
    expect(authorSimilarity(en, nameForms('Ривка Шарон', 'ru'))).toBe(1);
    expect(authorSimilarity(en, nameForms('רבקה שרון', 'he'))).toBeGreaterThanOrEqual(0.8);
    expect(authorSimilarity(en, nameForms('R. Sharon', 'en'))).toBeGreaterThanOrEqual(0.8);
  });

  it('does not take a namesake for the author', () => {
    expect(
      authorSimilarity(nameForms('Anna Petrova', 'en'), nameForms('Maria Petrova', 'en')),
    ).toBeLessThan(0.8);
    expect(
      authorSimilarity(nameForms('Rivka Sharon', 'en'), nameForms('Tobiah Quenell', 'en')),
    ).toBeLessThan(0.5);
  });
});

describe('scoreTranslation', () => {
  it('suggests the same book in another language, and says why', () => {
    const ru = title({
      id: 'ru',
      title: 'Фонарь Пепельной гавани',
      author: 'Ривка Шарон',
      language: 'ru',
      chars: 216_000, // Russian runs about 8% longer
      chapters: 24,
    });
    const s = scoreTranslation(title({ id: 'en' }), ru);
    expect(s).not.toBeNull();
    expect(s!.evidence).toEqual({ author: true, series: false, length: true, chapters: true });
    expect(s!.score).toBeGreaterThan(0.85);
  });

  it('weighs an audiobook against an ebook by how long the text would take to read', () => {
    const audio = title({
      id: 'ru-audio',
      author: 'Ривка Шарон',
      language: 'ru',
      books: [{ id: 'ru-audio', kind: 'audio', format: 'm4b', hasCover: false }],
      chars: null,
      chapters: null,
      // 200k chars of English is about 216k of Russian, about 3.6 hours read aloud.
      durationMs: Math.round((216_000 / 16.5) * 1000),
    });
    const s = scoreTranslation(title({ id: 'en' }), audio);
    expect(s?.evidence.length).toBe(true);
  });

  it('rules out the same author’s other books by their length and chapters', () => {
    const other = title({
      id: 'ru-other',
      author: 'Ривка Шарон',
      language: 'ru',
      chars: 520_000,
      chapters: 61,
    });
    expect(scoreTranslation(title({ id: 'en' }), other)).toBeNull();
  });

  it('never pairs two books in the same language, or one whose language is unknown', () => {
    expect(scoreTranslation(title({ id: 'a' }), title({ id: 'b' }))).toBeNull();
    expect(scoreTranslation(title({ id: 'a' }), title({ id: 'b', language: null }))).toBeNull();
  });

  it('counts a place in a series as evidence', () => {
    const s = scoreTranslation(
      title({ id: 'en', series: 'Ash Harbor', seriesIdx: 1 }),
      title({
        id: 'de',
        author: 'Rivka Sharon',
        language: 'de',
        series: 'Aschehafen',
        seriesIdx: 1,
        chars: 228_000,
      }),
    );
    expect(s?.evidence.series).toBe(true);
  });
});
