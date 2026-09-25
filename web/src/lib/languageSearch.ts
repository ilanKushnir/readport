import { UNKNOWN_LANGUAGE } from '@readport/shared';
import { languageName } from './languageName';
import { searchNames } from './nameSearch';

/**
 * The names a language answers to in a search: in the reader's language, in
 * its own, in English, and its code - so "Rus", "рус" and "ru" all find
 * Russian, whatever language the app itself is in. A facet value that is
 * several languages (`fr+de`) answers to each of them.
 */
export function languageNames(value: string, uiLocale: string): string[] {
  const out = new Set<string>();
  for (const code of value
    .split('+')
    .map((c) => c.trim())
    .filter(Boolean)) {
    out.add(languageName(code, uiLocale));
    if (code === UNKNOWN_LANGUAGE) continue;
    out.add(languageName(code, code));
    out.add(languageName(code, 'en'));
    out.add(code);
  }
  return [...out];
}

/** What a query finds among languages, best first (see `searchNames`). */
export function searchLanguages<T extends { names: string[] }>(entries: T[], query: string): T[] {
  return searchNames(entries, query);
}
