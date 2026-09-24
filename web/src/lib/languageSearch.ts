import { UNKNOWN_LANGUAGE } from '@readport/shared';
import { languageName } from './languageName';

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

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .trim();

/**
 * What a query finds, best first: a name that starts with it, then a word
 * in a name that does, then a name that merely contains it - each group in
 * the order the entries came in. An empty query finds everything, as it was.
 */
export function searchLanguages<T extends { names: string[] }>(entries: T[], query: string): T[] {
  const q = fold(query);
  if (!q) return entries;
  const rank = (entry: T): number => {
    let best = 3;
    for (const raw of entry.names) {
      const name = fold(raw);
      if (name.startsWith(q)) return 0;
      if (name.split(/[\s()\-,]+/).some((w) => w.startsWith(q))) best = Math.min(best, 1);
      else if (name.includes(q)) best = Math.min(best, 2);
    }
    return best;
  };
  return entries
    .map((entry, i) => ({ entry, i, r: rank(entry) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.entry);
}
