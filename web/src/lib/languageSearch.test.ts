import { describe, expect, it } from 'vitest';
import { languageNames, searchLanguages } from './languageSearch';

const entries = (ui: string) =>
  ['en', 'ru', 'he', 'fr', 'unknown'].map((value) => ({ value, names: languageNames(value, ui) }));
const find = (q: string, ui = 'en') => searchLanguages(entries(ui), q).map((e) => e.value);

describe('finding a language in the library’s list', () => {
  it('finds it by its name in the app’s language, in its own, or in English', () => {
    expect(find('rus')).toEqual(['ru']);
    expect(find('рус')).toEqual(['ru']);
    expect(find('עבר')).toEqual(['he']);
    expect(find('Hebrew', 'he')).toEqual(['he']);
  });

  it('does not mind accents or case', () => {
    expect(find('FRANCAIS')).toEqual(['fr']);
  });

  it('puts names that start with the query before names that only contain it', () => {
    expect(find('en')[0]).toBe('en');
  });

  it('shows everything, in order, for an empty query', () => {
    expect(find('  ')).toEqual(['en', 'ru', 'he', 'fr', 'unknown']);
  });

  it('finds nothing for a language the library does not have', () => {
    expect(find('klingon')).toEqual([]);
  });
});
