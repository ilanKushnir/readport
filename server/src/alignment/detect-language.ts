import { francAll } from 'franc';
import { LANGUAGES } from '@readport/shared';

/**
 * Work out what language a book is in, from the book.
 *
 * Two callers, two reasons. The library wants a language to browse by, and
 * the file's own tag is not to be trusted for that: Calibre stamps "en" on
 * everything it is not told otherwise about, so a Hebrew novel is "English"
 * until somebody reads it. Alignment wants a language for one narrow
 * purpose - the romanizer spells numbers out in it ("25" -> "twenty five"
 * or "vingt-cinq") - and there getting it wrong costs anchors around numbers
 * and nothing else.
 *
 * How it reads. Several windows of prose are taken from across the book,
 * skipping the front matter (title page, copyright, contents, which are in
 * the publisher's language rather than the book's) and the back matter (the
 * "about the author" and the adverts). Each window is classified by script
 * first - Hebrew, Cyrillic, Han - because the script settles the question
 * outright for a Greek or a Thai book and narrows it to a handful of
 * candidates for the rest; inside Cyrillic and Arabic script the letters
 * one language never writes (no Russian text has "ї", no Ukrainian has "ы",
 * no Arabic has "گ") narrow it further. What the script leaves open,
 * character trigrams settle: `franc` ranks the candidates by how closely the
 * window's trigram profile matches each language's.
 *
 * It abstains rather than guesses. A window votes only when the winner is
 * ahead of the runner-up by a margin; the book gets an answer only when
 * enough windows agree; and a page of names, a bilingual edition, a
 * chapter heading on its own all come back as "no answer", which the caller
 * treats as unknown. A wrong confident answer would outrank the file's tag
 * in the library, so the bar is set on the side of silence.
 */

export interface LanguageGuess {
  /** A code from shared/src/languages.ts. */
  language: string;
  /** 0..1. A script that belongs to one language is certain; trigrams are scored by margin and agreement. */
  confidence: number;
  /** Named so a log line can say where the answer came from. */
  basis: 'script' | 'trigrams';
  /** How many windows were read, and how many of them agreed with the answer. */
  windows: number;
  agreeing: number;
}

/**
 * Windows are short and many, not few and long, because of how `franc`
 * scores. It normalises a window's trigram distance against the whole
 * distance, most of which is trigrams no language's model lists at all, and
 * that part grows with the window while the part that tells languages
 * apart saturates - so the lead the right language has over the runner-up
 * is 0.06 on 450 characters of Spanish prose and 0.007 on 2,000 characters of
 * the same text. At 500 characters the lead is well calibrated (0.04-0.2 on
 * real prose, 0.025 on the hard pairs), and twelve windows of it are six
 * thousand characters of evidence with eleven cross-checks built in.
 */
export const WINDOW_CHARS = 500;
/** Windows per book, spread evenly through the middle of the text. */
export const WINDOWS = 12;
/** The share of the book skipped at the start and at the end. */
const FRONT_MATTER = 0.05;
const BACK_MATTER = 0.03;
/** A book shorter than this is read whole, in even pieces; there is nothing to skip. */
const WHOLE_BOOK_CHARS = WINDOW_CHARS * WINDOWS * 1.5;

/** Letters a window needs before its trigrams mean anything. */
const MIN_WINDOW_LETTERS = 250;
/** Letters a window needs before its script alone is allowed to decide. */
const MIN_SCRIPT_LETTERS = 100;
/** Below this share of letters in one script, a window is bilingual and does not vote. */
const MIN_SCRIPT_SHARE = 0.6;
/**
 * A page of names, a table of contents, a book that is one line repeated:
 * few distinct words for the number of words. Real prose in any language
 * with spaces runs well above this; scripts without spaces read as one
 * enormous word and pass trivially.
 */
const MIN_DISTINCT_WORDS = 0.15;
/** Measured over the head of the window: a page repeats its own phrases, a roster repeats its names. */
const DISTINCT_WORDS_HEAD = 200;
/** How far ahead the winner must be for one window to vote at all. */
const MIN_VOTE_MARGIN = 0.01;
/** The share of windows that must agree. Six of twelve is a coin toss; eight is a book. */
const MIN_AGREEMENT = 2 / 3;
/**
 * The lead the agreeing windows must typically show, by how many agree. On
 * a 500-character window real prose puts the right language 0.04-0.2
 * ahead, Portuguese against Galician 0.03, and a page that is half Spanish
 * and half Portuguese 0.025. Several windows agreeing is evidence in
 * itself, so each may be less sure.
 */
function requiredMargin(agreeing: number): number {
  return agreeing >= 6 ? 0.02 : agreeing >= 3 ? 0.025 : 0.03;
}

/**
 * ISO 639-3, which is what `franc` speaks, to the codes this build names.
 * Only these are ever answered: a book `franc` calls Scots or Afrikaans is
 * answered by whichever of these came second, so the candidate lists below
 * are built from this table and a language it cannot name is one it does
 * not compete with either.
 */
const FRANC_TO_CODE: Record<string, string> = {
  eng: 'en',
  heb: 'he',
  deu: 'de',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  rus: 'ru',
  arb: 'ar',
  nld: 'nl',
  pol: 'pl',
  ukr: 'uk',
  ces: 'cs',
  ron: 'ro',
  swe: 'sv',
  dan: 'da',
  nob: 'nb',
  fin: 'fi',
  ell: 'el',
  tur: 'tr',
  jpn: 'ja',
  kor: 'ko',
  cmn: 'zh',
  hin: 'hi',
  pes: 'fa',
  urd: 'ur',
  ben: 'bn',
  ind: 'id',
  vie: 'vi',
  tha: 'th',
  hun: 'hu',
  bul: 'bg',
  hrv: 'hr',
  srp: 'sr',
  slk: 'sk',
  slv: 'sl',
  lit: 'lt',
  lvs: 'lv',
  ekk: 'et',
  cat: 'ca',
  glg: 'gl',
  ydd: 'yi',
  swh: 'sw',
  zlm: 'ms',
  tam: 'ta',
};

/** The Latin-script languages `franc` may choose between. */
const LATIN_CANDIDATES = [
  'eng',
  'deu',
  'fra',
  'spa',
  'ita',
  'por',
  'nld',
  'pol',
  'ces',
  'ron',
  'swe',
  'dan',
  'nob',
  'fin',
  'tur',
  'ind',
  'vie',
  'hun',
  'hrv',
  'srp',
  'slk',
  'slv',
  'lit',
  'lvs',
  'ekk',
  'cat',
  'glg',
  'swh',
  'zlm',
];

/**
 * Languages of a shared script, told apart by their letters: the ones a
 * language never writes, and the ones a page of it cannot do without. A
 * Russian window is not a Serbian one - Serbian has no "ы", "э" or "щ" and
 * Russian has no "ј", "љ" or "њ" - and it is not a Bulgarian one either,
 * because a Bulgarian page is full of "ъ" and a Russian page has almost
 * none. Persian is Arabic script plus "پ چ ژ گ", Urdu is that plus "ٹ ڈ ڑ
 * ں ے". Unnamed neighbours (Belarusian, Macedonian, Kazakh) are listed so
 * that a book in one of them is answered "unknown" rather than with the
 * nearest language this build does name.
 */
interface Narrowing {
  code: string;
  /** Letters that rule the language out when more than a trace of them appears. */
  never: string;
  /** Letters a page of the language always has some of; none means the language is out. */
  needs: string;
}
const CYRILLIC: Narrowing[] = [
  { code: 'rus', never: 'іїєґјљњћђџўѓќѕәғқңөұүһ', needs: 'ыэё' },
  { code: 'ukr', never: 'ыэёъјљњћђџўѓќѕәғқңөұүһ', needs: 'іїєґ' },
  { code: 'bul', never: 'ыэёіїєґјљњћђџўѓќѕәғқңөұүһ', needs: 'ъ' },
  { code: 'srp', never: 'ыэёйщъьіїєґўѓќѕәғқңөұүһ', needs: 'јљњћђџ' },
  { code: 'mkd', never: 'ыэёйщъьіїєґўәғқңөұүһ', needs: 'ѓќѕ' },
  { code: 'bel', never: 'ищъјљњћђџѓќѕәғқңөұүһ', needs: 'ў' },
  { code: 'kaz', never: 'іїєґјљњћђџѓќѕ', needs: 'әғқңөұүһ' },
];
const ARABIC: Narrowing[] = [
  { code: 'arb', never: 'پچژگٹڈڑںے', needs: '' },
  { code: 'pes', never: 'ٹڈڑںے', needs: 'پچژگ' },
  { code: 'urd', never: '', needs: 'ٹڈڑںے' },
];
/**
 * The closest Latin-script pairs, told apart the same way. Portuguese leads
 * Galician by a hair on trigrams alone, and a page of it always has "ã",
 * "õ" or "ç", which Galician never writes; Spanish never writes those
 * either, Catalan and Portuguese never write "ñ", Italian none of them.
 * Languages absent from this table are candidates whatever the letters.
 */
const LATIN: Narrowing[] = [
  { code: 'glg', never: 'ãõç', needs: '' },
  { code: 'spa', never: 'ãõç', needs: '' },
  { code: 'cat', never: 'ñ', needs: '' },
  { code: 'por', never: 'ñ', needs: '' },
  { code: 'ita', never: 'ñãõçß', needs: '' },
  { code: 'fra', never: 'ñãõß', needs: '' },
  { code: 'swe', never: 'æø', needs: '' },
  { code: 'dan', never: 'äö', needs: '' },
  { code: 'nob', never: 'äö', needs: '' },
  { code: 'ces', never: 'äľĺŕô', needs: '' },
  { code: 'slk', never: 'ěřů', needs: '' },
  { code: 'fin', never: 'õ', needs: '' },
];
/** Every named language of the script, for a window the letters leave nobody standing in. */
const CYRILLIC_ALL = ['rus', 'ukr', 'bul', 'srp'];
const ARABIC_ALL = ['arb', 'pes', 'urd'];
/** Below this share of letters a signature letter is a quotation or a name, not the language. */
const SIGNATURE_SHARE = 0.003;

/** Scripts a window's letters are sorted into. */
const SCRIPTS: [string, RegExp][] = [
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['greek', /\p{Script=Greek}/u],
  ['han', /\p{Script=Han}/u],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['thai', /\p{Script=Thai}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['tamil', /\p{Script=Tamil}/u],
];
/** A script that belongs to exactly one language this build names. */
const DECISIVE: Record<string, string> = {
  greek: 'el',
  hangul: 'ko',
  thai: 'th',
  bengali: 'bn',
  tamil: 'ta',
};
/** Scripts shared by several languages, and what `franc` may choose between. */
const SHARED: Record<string, string[]> = {
  hebrew: ['heb', 'ydd'],
  devanagari: ['hin', 'mar', 'npi', 'bho', 'mai', 'mag'],
};

/**
 * Where the windows sit in a text of `total` characters. Pure, so the same
 * plan serves a string in memory and a book read one chapter file at a
 * time. A short book is read whole, in even pieces; a long one is sampled
 * from the 92% in the middle, evenly, never overlapping.
 */
export function windowOffsets(total: number): { at: number; length: number }[] {
  if (total <= 0) return [];
  if (total <= WHOLE_BOOK_CHARS) {
    // Pieces of at least a window each - never twelve slivers of a short book.
    const n = Math.max(1, Math.min(WINDOWS, Math.floor(total / WINDOW_CHARS)));
    const length = Math.ceil(total / n);
    return Array.from({ length: n }, (_, i) => ({
      at: i * length,
      length: Math.min(length, total - i * length),
    }));
  }
  const start = Math.floor(total * FRONT_MATTER);
  const end = Math.floor(total * (1 - BACK_MATTER));
  const span = end - start;
  const n = Math.max(1, Math.min(WINDOWS, Math.floor(span / WINDOW_CHARS)));
  const step = n > 1 ? (span - WINDOW_CHARS) / (n - 1) : 0;
  return Array.from({ length: n }, (_, i) => ({
    at: start + Math.round(i * step),
    length: WINDOW_CHARS,
  }));
}

/** The windows of one string, each started on a word boundary. */
export function sampleWindows(text: string): string[] {
  return windowOffsets(text.length).map(({ at, length }) => {
    let from = at;
    if (from > 0) {
      const gap = text.slice(from, from + 80).search(/\s/);
      if (gap >= 0) from += gap + 1;
    }
    return text.slice(from, at + length);
  });
}

interface Vote {
  code: string | null;
  margin: number;
  basis: 'script' | 'trigrams';
}
const ABSTAIN: Vote = { code: null, margin: 0, basis: 'trigrams' };

/**
 * The candidates the signature letters leave standing, out of `all` - a
 * language without a rule always stands - or, when they leave none,
 * `fallback`.
 */
function narrow(
  letters: string[],
  table: Narrowing[],
  all: string[],
  fallback: string[] = all,
): string[] {
  const seen = new Map<string, number>();
  for (const l of letters) seen.set(l, (seen.get(l) ?? 0) + 1);
  const present = (chars: string) => {
    let n = 0;
    for (const [l, count] of seen) if (chars.includes(l)) n += count;
    return n / letters.length >= SIGNATURE_SHARE;
  };
  const left = all.filter((code) => {
    const rule = table.find((t) => t.code === code);
    return !rule || (!present(rule.never) && (rule.needs === '' || present(rule.needs)));
  });
  return left.length > 0 ? left : fallback;
}

/** Ask `franc` to rank `only`, and read off the winner and its lead. */
function rank(window: string, only: string[]): Vote {
  const scored = francAll(window, { only, minLength: 1 });
  const [best, second] = scored;
  if (!best || best[0] === 'und') return ABSTAIN;
  const margin = best[1] - (second?.[1] ?? 0);
  const code = FRANC_TO_CODE[best[0]] ?? null;
  if (!code || margin < MIN_VOTE_MARGIN) return ABSTAIN;
  return { code, margin, basis: 'trigrams' };
}

/** What one window says, or nothing. */
function readWindow(window: string): Vote {
  const letters = window.toLowerCase().match(/\p{L}/gu) ?? [];
  if (letters.length < MIN_SCRIPT_LETTERS) return ABSTAIN;

  const counts = new Map<string, number>();
  for (const l of letters) {
    for (const [name, re] of SCRIPTS) {
      if (re.test(l)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        break;
      }
    }
  }
  // Japanese is Han and kana together; the kana is what tells it from Chinese.
  const han = counts.get('han') ?? 0;
  const kana = counts.get('kana') ?? 0;
  if ((han + kana) / letters.length >= MIN_SCRIPT_SHARE) {
    return { code: kana / letters.length >= 0.05 ? 'ja' : 'zh', margin: 1, basis: 'script' };
  }
  let script: string | null = null;
  let top = 0;
  for (const [name, n] of counts) {
    if (n > top) {
      top = n;
      script = name;
    }
  }
  if (!script || top / letters.length < MIN_SCRIPT_SHARE) return ABSTAIN; // bilingual, or no script we read
  const decisive = DECISIVE[script];
  if (decisive) return { code: decisive, margin: 1, basis: 'script' };

  if (letters.length < MIN_WINDOW_LETTERS) return ABSTAIN;
  const words = window
    .toLowerCase()
    .split(/[^\p{L}'’]+/u)
    .filter(Boolean)
    .slice(0, DISTINCT_WORDS_HEAD);
  if (words.length > 0 && new Set(words).size / words.length < MIN_DISTINCT_WORDS) return ABSTAIN;

  let only: string[];
  if (script === 'cyrillic') {
    only = narrow(
      letters,
      CYRILLIC,
      CYRILLIC.map((t) => t.code),
      CYRILLIC_ALL,
    );
  } else if (script === 'arabic') {
    only = narrow(
      letters,
      ARABIC,
      ARABIC.map((t) => t.code),
      ARABIC_ALL,
    );
  } else if (script === 'latin') only = narrow(letters, LATIN, LATIN_CANDIDATES);
  else only = SHARED[script] ?? [];
  if (only.length === 0) return ABSTAIN;
  if (only.length === 1) {
    const code = FRANC_TO_CODE[only[0]!] ?? null;
    return code ? { code, margin: 1, basis: 'script' } : ABSTAIN;
  }
  return rank(window, only);
}

/**
 * Pool the windows' votes into one answer, or none.
 *
 * The winner is the language most windows named; it stands only when at
 * least two thirds of ALL windows named it - an abstaining window counts
 * against, because a book half of whose pages cannot be read is not a book
 * whose language is known - and when the agreeing windows' typical margin
 * clears the bar for that many of them.
 */
export function detectLanguageFromWindows(windows: string[]): LanguageGuess | null {
  const votes = windows.map(readWindow);
  const tally = new Map<string, number>();
  for (const v of votes) if (v.code) tally.set(v.code, (tally.get(v.code) ?? 0) + 1);
  let winner: string | null = null;
  let most = 0;
  for (const [code, n] of tally) {
    if (n > most) {
      most = n;
      winner = code;
    }
  }
  if (!winner || most / windows.length < MIN_AGREEMENT) return null;
  const agreeing = votes.filter((v) => v.code === winner);
  const byScript = agreeing.every((v) => v.basis === 'script');
  if (byScript) {
    return {
      language: winner,
      confidence: 0.99,
      basis: 'script',
      windows: windows.length,
      agreeing: most,
    };
  }
  const margins = agreeing.map((v) => v.margin).sort((a, b) => a - b);
  const median = margins[Math.floor(margins.length / 2)]!;
  if (median < requiredMargin(most)) return null;
  const agreement = most / windows.length;
  const confidence = Math.min(0.98, 0.5 + 0.45 * Math.min(1, median / 0.08) * agreement);
  return {
    language: winner,
    confidence,
    basis: 'trigrams',
    windows: windows.length,
    agreeing: most,
  };
}

/**
 * Guess the language of `text`, or null when the evidence does not support a
 * confident answer. Convenience over `detectLanguageFromWindows` for a
 * caller holding the whole text in memory.
 */
export function detectLanguageFromText(text: string): LanguageGuess | null {
  if (!text.trim()) return null;
  return detectLanguageFromWindows(sampleWindows(text));
}

/** True when the romanizer has conventions for this language. */
export function isSupportedLanguage(code: string): boolean {
  return LANGUAGES.some((l) => l.code === code);
}
