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
  /**
   * An emoji flag, for a glance: the language's main country, by the
   * convention documented above `BOOK_LANGUAGES`. Decoration beside the
   * name, never a substitute for it.
   */
  flag: string;
}

export const LANGUAGES: LanguageSpec[] = [
  { code: 'en', label: 'English', native: 'English', flag: '🇬🇧' },
  { code: 'he', label: 'Hebrew', native: 'עברית', flag: '🇮🇱' },
  { code: 'de', label: 'German', native: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', label: 'French', native: 'Français', flag: '🇫🇷' },
  { code: 'es', label: 'Spanish', native: 'Español', flag: '🇪🇸' },
  { code: 'it', label: 'Italian', native: 'Italiano', flag: '🇮🇹' },
  { code: 'pt', label: 'Portuguese', native: 'Português', flag: '🇵🇹' },
  { code: 'ru', label: 'Russian', native: 'Русский', flag: '🇷🇺' },
  { code: 'ar', label: 'Arabic', native: 'العربية', flag: '🇸🇦' },
  { code: 'nl', label: 'Dutch', native: 'Nederlands', flag: '🇳🇱' },
];

/**
 * Languages a book may be in, for the language facet and a per-book override.
 *
 * Broader than `LANGUAGES` above, which is only what the romanizer knows how
 * to spell numbers in: a Polish audiobook aligns fine, it just cannot be
 * narrated in Polish digits, and it certainly deserves to be called Polish
 * rather than "PL" in the sidebar. English labels; a client with
 * `Intl.DisplayNames` shows the reader's own language's name for each.
 *
 * The flag convention. A language is not a country, so the flag is a hint
 * for the eye and the name beside it is the truth. Each language gets the
 * flag of the country it is named after or most identified with - English
 * 🇬🇧, Spanish 🇪🇸, Portuguese 🇵🇹, Arabic 🇸🇦, Chinese 🇨🇳, Hebrew 🇮🇱,
 * Russian 🇷🇺, Ukrainian 🇺🇦 - never a tally of where it has the most
 * speakers. A language without a state of its own borrows the flag of the
 * place where it is official: Catalan the Andorran, Welsh the Welsh, Latin
 * the Vatican's, Yiddish the Israeli; Basque and Galician share the Spanish
 * flag, Tamil the Indian, and Bokmål and "Norwegian" both fly the Norwegian.
 * Two languages sharing one flag is fine - the name distinguishes them; one
 * language flying two flags would not be.
 */
export const BOOK_LANGUAGES: LanguageSpec[] = [
  ...LANGUAGES,
  { code: 'pl', label: 'Polish', native: 'Polski', flag: '🇵🇱' },
  { code: 'uk', label: 'Ukrainian', native: 'Українська', flag: '🇺🇦' },
  { code: 'cs', label: 'Czech', native: 'Čeština', flag: '🇨🇿' },
  { code: 'ro', label: 'Romanian', native: 'Română', flag: '🇷🇴' },
  { code: 'sv', label: 'Swedish', native: 'Svenska', flag: '🇸🇪' },
  { code: 'da', label: 'Danish', native: 'Dansk', flag: '🇩🇰' },
  { code: 'nb', label: 'Norwegian Bokmål', native: 'Norsk bokmål', flag: '🇳🇴' },
  { code: 'no', label: 'Norwegian', native: 'Norsk', flag: '🇳🇴' },
  { code: 'fi', label: 'Finnish', native: 'Suomi', flag: '🇫🇮' },
  { code: 'el', label: 'Greek', native: 'Ελληνικά', flag: '🇬🇷' },
  { code: 'tr', label: 'Turkish', native: 'Türkçe', flag: '🇹🇷' },
  { code: 'ja', label: 'Japanese', native: '日本語', flag: '🇯🇵' },
  { code: 'ko', label: 'Korean', native: '한국어', flag: '🇰🇷' },
  { code: 'zh', label: 'Chinese', native: '中文', flag: '🇨🇳' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी', flag: '🇮🇳' },
  { code: 'fa', label: 'Persian', native: 'فارسی', flag: '🇮🇷' },
  { code: 'ur', label: 'Urdu', native: 'اردو', flag: '🇵🇰' },
  { code: 'bn', label: 'Bengali', native: 'বাংলা', flag: '🇧🇩' },
  { code: 'id', label: 'Indonesian', native: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'th', label: 'Thai', native: 'ไทย', flag: '🇹🇭' },
  { code: 'hu', label: 'Hungarian', native: 'Magyar', flag: '🇭🇺' },
  { code: 'bg', label: 'Bulgarian', native: 'Български', flag: '🇧🇬' },
  { code: 'hr', label: 'Croatian', native: 'Hrvatski', flag: '🇭🇷' },
  { code: 'sr', label: 'Serbian', native: 'Српски', flag: '🇷🇸' },
  { code: 'sk', label: 'Slovak', native: 'Slovenčina', flag: '🇸🇰' },
  { code: 'sl', label: 'Slovenian', native: 'Slovenščina', flag: '🇸🇮' },
  { code: 'lt', label: 'Lithuanian', native: 'Lietuvių', flag: '🇱🇹' },
  { code: 'lv', label: 'Latvian', native: 'Latviešu', flag: '🇱🇻' },
  { code: 'et', label: 'Estonian', native: 'Eesti', flag: '🇪🇪' },
  { code: 'ca', label: 'Catalan', native: 'Català', flag: '🇦🇩' },
  { code: 'eu', label: 'Basque', native: 'Euskara', flag: '🇪🇸' },
  { code: 'gl', label: 'Galician', native: 'Galego', flag: '🇪🇸' },
  { code: 'ga', label: 'Irish', native: 'Gaeilge', flag: '🇮🇪' },
  { code: 'cy', label: 'Welsh', native: 'Cymraeg', flag: '🏴󠁧󠁢󠁷󠁬󠁳󠁿' },
  { code: 'is', label: 'Icelandic', native: 'Íslenska', flag: '🇮🇸' },
  { code: 'la', label: 'Latin', native: 'Latina', flag: '🇻🇦' },
  { code: 'yi', label: 'Yiddish', native: 'ייִדיש', flag: '🇮🇱' },
  { code: 'sw', label: 'Swahili', native: 'Kiswahili', flag: '🇹🇿' },
  { code: 'ms', label: 'Malay', native: 'Bahasa Melayu', flag: '🇲🇾' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்', flag: '🇮🇳' },
];

/** The facet value that stands for "no language known": a book with none is browsable too. */
export const UNKNOWN_LANGUAGE = 'unknown';

/**
 * Where a book's language came from. A manual override outlives every
 * rescan; metadata is what the file says; `pair` is the other verified
 * edition of the same book lending its answer; `detected` is what reading
 * the prose said. Most trusted first for an audiobook; for an ebook a
 * confident reading of the prose outranks the file's tag, because the tag
 * is so often a tool's default (Calibre stamps "en" on everything) and the
 * prose cannot be - see server/src/library/language.ts for the ladder.
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
 * The flag beside a language, or an empty string for a code this build does
 * not know and for "unknown" - which is exactly a language with no country.
 */
export function languageFlag(code: string | null | undefined): string {
  return languageByCode(code)?.flag ?? '';
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
