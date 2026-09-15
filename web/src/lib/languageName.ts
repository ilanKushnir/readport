import { UNKNOWN_LANGUAGE, languageLabel } from '@readport/shared';

/**
 * A language's name, in the reader's own language where the browser can
 * say it - "Français" to a French reader, "French" to an English one,
 * "צרפתית" to a Hebrew one - and the shared English table where it cannot.
 */
export function languageName(
  code: string | null | undefined,
  locale: string | undefined = undefined,
): string {
  if (!code || code === UNKNOWN_LANGUAGE) return languageLabel(code);
  try {
    if (typeof Intl !== 'undefined' && 'DisplayNames' in Intl) {
      const names = new Intl.DisplayNames(locale ? [locale] : undefined, {
        type: 'language',
        fallback: 'none',
      });
      const name = names.of(code);
      if (name && name.toLowerCase() !== code.toLowerCase()) {
        return name.charAt(0).toUpperCase() + name.slice(1);
      }
    }
  } catch {
    /* an unknown tag, or a browser without DisplayNames */
  }
  return languageLabel(code);
}

/** "French, German and Unknown" for a `fr+de+unknown` facet value. */
export function languageListName(value: string, locale?: string): string {
  const parts = value
    .split('+')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => languageName(v, locale));
  if (parts.length === 0) return languageLabel(null);
  try {
    if (typeof Intl !== 'undefined' && 'ListFormat' in Intl)
      return new Intl.ListFormat(locale ? [locale] : undefined, {
        style: 'long',
        type: 'conjunction',
      }).format(parts);
  } catch {
    /* fall through */
  }
  return parts.join(', ');
}
