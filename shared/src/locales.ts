import { z } from 'zod';

/**
 * The languages the interface itself speaks. Distinct from the languages a
 * BOOK may be in (languages.ts): a French reader may well read Hebrew books,
 * and the two settings never meet.
 *
 * `dir` is the writing direction the whole app takes in that locale. A book's
 * own direction is decided by the book and stays independent of it.
 */
export interface UiLocale {
  code: string;
  /** The language's own name for itself, which is how a picker should list it. */
  native: string;
  /** Its English name, for logs and for anyone lost in a picker. */
  english: string;
  dir: 'ltr' | 'rtl';
}

export const UI_LOCALES: UiLocale[] = [
  { code: 'en', native: 'English', english: 'English', dir: 'ltr' },
  { code: 'he', native: 'עברית', english: 'Hebrew', dir: 'rtl' },
  { code: 'ru', native: 'Русский', english: 'Russian', dir: 'ltr' },
  { code: 'ar', native: 'العربية', english: 'Arabic', dir: 'rtl' },
  { code: 'es', native: 'Español', english: 'Spanish', dir: 'ltr' },
  { code: 'fr', native: 'Français', english: 'French', dir: 'ltr' },
  { code: 'de', native: 'Deutsch', english: 'German', dir: 'ltr' },
  { code: 'pt', native: 'Português', english: 'Portuguese', dir: 'ltr' },
  { code: 'it', native: 'Italiano', english: 'Italian', dir: 'ltr' },
  { code: 'nl', native: 'Nederlands', english: 'Dutch', dir: 'ltr' },
  { code: 'pl', native: 'Polski', english: 'Polish', dir: 'ltr' },
  { code: 'uk', native: 'Українська', english: 'Ukrainian', dir: 'ltr' },
  { code: 'cs', native: 'Čeština', english: 'Czech', dir: 'ltr' },
  { code: 'ro', native: 'Română', english: 'Romanian', dir: 'ltr' },
  { code: 'sv', native: 'Svenska', english: 'Swedish', dir: 'ltr' },
  { code: 'da', native: 'Dansk', english: 'Danish', dir: 'ltr' },
  { code: 'nb', native: 'Norsk bokmål', english: 'Norwegian Bokmål', dir: 'ltr' },
  { code: 'fi', native: 'Suomi', english: 'Finnish', dir: 'ltr' },
  { code: 'el', native: 'Ελληνικά', english: 'Greek', dir: 'ltr' },
  { code: 'tr', native: 'Türkçe', english: 'Turkish', dir: 'ltr' },
  { code: 'ja', native: '日本語', english: 'Japanese', dir: 'ltr' },
  { code: 'ko', native: '한국어', english: 'Korean', dir: 'ltr' },
  { code: 'zh-Hans', native: '简体中文', english: 'Simplified Chinese', dir: 'ltr' },
];

export const UI_LOCALE_CODES = UI_LOCALES.map((l) => l.code);
export const DEFAULT_UI_LOCALE = 'en';

export const uiLocaleSchema = z.enum(UI_LOCALE_CODES as [string, ...string[]]);

export function uiLocale(code: string | null | undefined): UiLocale | undefined {
  return UI_LOCALES.find((l) => l.code === code);
}

/**
 * The supported locale a browser's language list points at, or null.
 *
 * "zh-CN" and "zh" both mean Simplified Chinese here; "pt-BR" is Portuguese;
 * "nb-NO" and plain "no" are Bokmål. Matched in the order the browser lists
 * them, which is the order the person ranked them in.
 */
export function suggestUiLocale(languages: readonly string[]): string | null {
  for (const raw of languages) {
    const tag = raw.toLowerCase();
    if (tag.startsWith('zh')) return 'zh-Hans';
    if (tag === 'no' || tag.startsWith('no-') || tag.startsWith('nb') || tag.startsWith('nn'))
      return 'nb';
    const base = tag.split(/[-_]/)[0]!;
    const hit = UI_LOCALES.find((l) => l.code.toLowerCase() === base);
    if (hit) return hit.code;
  }
  return null;
}
