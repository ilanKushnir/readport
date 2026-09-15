/**
 * The languages whose numbers and abbreviations the romanizer knows how to
 * spell out, which is the only thing a book's language decides - script
 * transliteration is keyed on the characters themselves, so a book in a
 * language not listed here still aligns, it just loses the anchors around its
 * numerals. Offered in the pairing dropdown and as the server-wide fallback.
 */
export interface LanguageSpec {
  code: string;
  label: string;
  native: string;
}

export const LANGUAGES: LanguageSpec[] = [
  {
    code: 'en',
    label: 'English',
    native: 'English',
  },
  {
    code: 'he',
    label: 'Hebrew',
    native: 'עברית',
  },
  { code: 'de', label: 'German', native: 'Deutsch' },
  { code: 'fr', label: 'French', native: 'Français' },
  { code: 'es', label: 'Spanish', native: 'Español' },
  { code: 'it', label: 'Italian', native: 'Italiano' },
  { code: 'pt', label: 'Portuguese', native: 'Português' },
  { code: 'ru', label: 'Russian', native: 'Русский' },
  { code: 'ar', label: 'Arabic', native: 'العربية' },
  { code: 'nl', label: 'Dutch', native: 'Nederlands' },
];

/**
 * Languages a book may be in, for the language facet and a per-book override.
 *
 * Broader than `LANGUAGES` above, which is only what the romanizer knows how
 * to spell numbers in: a Polish audiobook aligns fine, it just cannot be
 * narrated in Polish digits, and it certainly deserves to be called Polish
 * rather than "PL" in the sidebar. English labels; a client with
 * `Intl.DisplayNames` shows the reader's own language's name for each.
 */
export const BOOK_LANGUAGES: LanguageSpec[] = [
  ...LANGUAGES,
  { code: 'pl', label: 'Polish', native: 'Polski' },
  { code: 'uk', label: 'Ukrainian', native: 'Українська' },
  { code: 'cs', label: 'Czech', native: 'Čeština' },
  { code: 'ro', label: 'Romanian', native: 'Română' },
  { code: 'sv', label: 'Swedish', native: 'Svenska' },
  { code: 'da', label: 'Danish', native: 'Dansk' },
  { code: 'nb', label: 'Norwegian Bokmål', native: 'Norsk bokmål' },
  { code: 'no', label: 'Norwegian', native: 'Norsk' },
  { code: 'fi', label: 'Finnish', native: 'Suomi' },
  { code: 'el', label: 'Greek', native: 'Ελληνικά' },
  { code: 'tr', label: 'Turkish', native: 'Türkçe' },
  { code: 'ja', label: 'Japanese', native: '日本語' },
  { code: 'ko', label: 'Korean', native: '한국어' },
  { code: 'zh', label: 'Chinese', native: '中文' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { code: 'fa', label: 'Persian', native: 'فارسی' },
  { code: 'ur', label: 'Urdu', native: 'اردو' },
  { code: 'bn', label: 'Bengali', native: 'বাংলা' },
  { code: 'id', label: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'th', label: 'Thai', native: 'ไทย' },
  { code: 'hu', label: 'Hungarian', native: 'Magyar' },
  { code: 'bg', label: 'Bulgarian', native: 'Български' },
  { code: 'hr', label: 'Croatian', native: 'Hrvatski' },
  { code: 'sr', label: 'Serbian', native: 'Српски' },
  { code: 'sk', label: 'Slovak', native: 'Slovenčina' },
  { code: 'sl', label: 'Slovenian', native: 'Slovenščina' },
  { code: 'lt', label: 'Lithuanian', native: 'Lietuvių' },
  { code: 'lv', label: 'Latvian', native: 'Latviešu' },
  { code: 'et', label: 'Estonian', native: 'Eesti' },
  { code: 'ca', label: 'Catalan', native: 'Català' },
  { code: 'eu', label: 'Basque', native: 'Euskara' },
  { code: 'gl', label: 'Galician', native: 'Galego' },
  { code: 'ga', label: 'Irish', native: 'Gaeilge' },
  { code: 'cy', label: 'Welsh', native: 'Cymraeg' },
  { code: 'is', label: 'Icelandic', native: 'Íslenska' },
  { code: 'la', label: 'Latin', native: 'Latina' },
  { code: 'yi', label: 'Yiddish', native: 'ייִדיש' },
  { code: 'sw', label: 'Swahili', native: 'Kiswahili' },
  { code: 'ms', label: 'Malay', native: 'Bahasa Melayu' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்' },
];

/** The facet value that stands for "no language known": a book with none is browsable too. */
export const UNKNOWN_LANGUAGE = 'unknown';

/**
 * Where a book's language came from, most trusted first. A manual override
 * outlives every rescan; metadata is what the file says; `pair` is the other
 * verified edition of the same book lending its answer; `detected` is what
 * reading the text suggested.
 */
export const LANGUAGE_SOURCES = ['manual', 'metadata', 'pair', 'detected'] as const;
export type LanguageSource = (typeof LANGUAGE_SOURCES)[number];

export function languageLabel(code: string | null | undefined): string {
  if (!code || code === UNKNOWN_LANGUAGE) return 'Unknown';
  const base = code.toLowerCase().split(/[-_]/)[0];
  return BOOK_LANGUAGES.find((l) => l.code === base)?.label ?? code.toUpperCase();
}

/**
 * The language a code names, ignoring any region suffix: "pt-BR" and "pt" are
 * both Portuguese. Returns undefined for a code this build does not know,
 * which callers show verbatim rather than guessing at.
 */
export function languageByCode(code: string | null | undefined): LanguageSpec | undefined {
  if (!code) return undefined;
  const base = code.toLowerCase().split(/[-_]/)[0]!;
  return BOOK_LANGUAGES.find((l) => l.code === base);
}

/**
 * Three-letter language codes to two.
 *
 * ffmpeg reports ISO 639-2 ("eng"), EPUBs declare ISO 639-1 ("en"), and a
 * library holding both formats of one book would otherwise show that book's
 * language twice - once as English and once as ENG. Covers the languages
 * this build knows plus the bibliographic variants that differ from the
 * terminological ones, which is where most of the surprises live.
 */
const ISO3_TO_ISO1: Record<string, string> = {
  eng: 'en',
  heb: 'he',
  deu: 'de',
  ger: 'de', // bibliographic
  fra: 'fr',
  fre: 'fr', // bibliographic
  spa: 'es',
  ita: 'it',
  por: 'pt',
  rus: 'ru',
  ara: 'ar',
  nld: 'nl',
  dut: 'nl', // bibliographic
  jpn: 'ja',
  zho: 'zh',
  chi: 'zh', // bibliographic
  kor: 'ko',
  pol: 'pl',
  swe: 'sv',
  dan: 'da',
  nor: 'no',
  fin: 'fi',
  tur: 'tr',
  ell: 'el',
  gre: 'el', // bibliographic
  ces: 'cs',
  cze: 'cs', // bibliographic
  ukr: 'uk',
  ron: 'ro',
  rum: 'ro', // bibliographic
  hun: 'hu',
  hin: 'hi',
  fas: 'fa',
  per: 'fa', // bibliographic
};

/**
 * One canonical form for a language tag, whatever wrote it: lower case, no
 * region, two letters where a two-letter code exists. Returns null for
 * anything that is not plausibly a language tag, so junk in a tag field does
 * not become a row in the sidebar.
 */
export function normaliseLanguage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  if (!/^[a-z]{2,3}$/.test(base)) return null;
  // "und" is ISO 639's own word for "we do not know", and "unknown" is what
  // a tag editor writes: neither is a language to browse by.
  if (base === 'und' || base === 'unknown' || base === 'mul' || base === 'zxx') return null;
  return ISO3_TO_ISO1[base] ?? base;
}
