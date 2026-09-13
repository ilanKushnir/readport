import { lengthRatioScore, TITLE_FLOOR, type PairEvidence } from '@readport/shared';
import {
  normalizeAuthor,
  normalizeTitle,
  stringSimilarity,
  tokenSimilarity,
  tokenize,
} from '../util/text.js';

/**
 * Conservative pair candidate scoring. Metadata alone can suggest a pair but
 * never authorizes sentence-level switching (that requires alignment).
 * False positives are worse than false negatives: anything ambiguous stays a
 * candidate for human review, and low scores generate nothing at all.
 */

export interface PairInputs {
  ebook: {
    title: string;
    author: string | null;
    language: string | null;
    series: string | null;
    identifiers: Record<string, string>;
    totalChars: number | null;
  };
  audio: {
    title: string;
    author: string | null;
    language: string | null;
    series: string | null;
    identifiers: Record<string, string>;
    durationMs: number | null;
  };
}

/** Typical narration pace, characters per second (empirically ~15–18). */
const NARRATION_CHARS_PER_SEC = 16.5;

export const CANDIDATE_THRESHOLD = 0.55;

/**
 * How far behind the best match a rival may be and still be offered.
 *
 * A book has one audiobook, so two suggestions for the same file are two
 * guesses at one answer. Anything this far behind the leader on either side
 * has lost: the crossed pair scores well below the right one and is dropped.
 * The margin is not zero because two editions of the SAME book (a reissue, a
 * boxed set) score within a hair of each other and both deserve to be shown.
 */
export const PAIR_RIVAL_MARGIN = 0.08;
export const DEFAULT_AUTO_THRESHOLD = 0.92;

export function scorePair(input: PairInputs): { score: number; evidence: PairEvidence } {
  const notes: string[] = [];
  const et = normalizeTitle(input.ebook.title);
  const at = normalizeTitle(input.audio.title);
  const titleScore = Math.max(
    stringSimilarity(et, at),
    tokenSimilarity(tokenize(et), tokenize(at)),
  );

  let authorScore = 0.5; // unknown
  if (input.ebook.author && input.audio.author) {
    authorScore = stringSimilarity(
      normalizeAuthor(input.ebook.author),
      normalizeAuthor(input.audio.author),
    );
  } else {
    notes.push('Author missing on one side; treated as neutral evidence.');
  }

  const eIds = Object.values(input.ebook.identifiers).map((v) => v.toLowerCase());
  const aIds = Object.values(input.audio.identifiers).map((v) => v.toLowerCase());
  const identifierMatch = eIds.length > 0 && aIds.length > 0 && eIds.some((v) => aIds.includes(v));

  let languageMatch: boolean | null = null;
  const eLang = languageCode(input.ebook.language);
  const aLang = languageCode(input.audio.language);
  if (eLang && aLang) {
    languageMatch = eLang === aLang;
    if (!languageMatch) notes.push('Languages differ - possible translation mismatch.');
  }

  let seriesMatch: boolean | null = null;
  if (input.ebook.series && input.audio.series) {
    seriesMatch =
      stringSimilarity(normalizeTitle(input.ebook.series), normalizeTitle(input.audio.series)) >
      0.85;
  }

  let durationPagesRatio: number | null = null;
  if (input.ebook.totalChars && input.audio.durationMs) {
    const expectedMs = (input.ebook.totalChars / NARRATION_CHARS_PER_SEC) * 1000;
    durationPagesRatio = input.audio.durationMs / expectedMs;
    if (durationPagesRatio < 0.7) {
      notes.push('Audio much shorter than the text suggests - possibly abridged.');
    } else if (durationPagesRatio > 1.45) {
      notes.push('Audio much longer than the text suggests - possibly a different edition.');
    }
  }

  // Weighted score.
  //
  // The title carries the pair. Sharing an author used to be worth a quarter
  // of it on its own, which is nearly worthless as evidence: someone who owns
  // a dozen books by one writer gets a perfect author score on every WRONG
  // combination as well as the right one. That is how "Tenfold Harvests" (ebook)
  // came to be suggested against "Tenfold Cellars" (audiobook) at 61%.
  let score = 0;
  score += 0.6 * titleScore;
  score += 0.15 * authorScore;
  score += 0.08 * (languageMatch === null ? 0.5 : languageMatch ? 1 : 0);
  score += 0.07 * (seriesMatch === null ? 0.5 : seriesMatch ? 1 : 0);
  if (durationPagesRatio !== null) {
    score += 0.1 * lengthRatioScore(durationPagesRatio);
  } else {
    score += 0.05;
  }
  if (identifierMatch) score = Math.max(score, 0.96);
  // Contradictory languages are a hard damper regardless of titles.
  if (languageMatch === false) score = Math.min(score, 0.4);
  // Two different titles are two different books. Nothing but a shared
  // identifier - an ISBN or ASIN, which names the work itself - may carry a
  // pair past this, however well everything else agrees.
  if (titleScore < TITLE_FLOOR && !identifierMatch) {
    score = Math.min(score, CANDIDATE_THRESHOLD - 0.01);
    notes.push('Titles are too different to suggest these are the same book.');
  }

  const evidence: PairEvidence = {
    titleScore: round3(titleScore),
    authorScore: round3(authorScore),
    identifierMatch,
    languageMatch,
    seriesMatch,
    durationPagesRatio: durationPagesRatio === null ? null : round3(durationPagesRatio),
    contentScore: null,
    notes,
  };
  return { score: round3(Math.max(0, Math.min(1, score))), evidence };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** ID3/MP4 tags often carry ISO 639-2 codes (`eng`, `heb`); EPUBs carry BCP-47. */
const ISO_639_2_TO_1: Record<string, string> = {
  eng: 'en',
  heb: 'he',
  ger: 'de',
  deu: 'de',
  fre: 'fr',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  dut: 'nl',
  nld: 'nl',
  rus: 'ru',
  pol: 'pl',
  swe: 'sv',
  nor: 'no',
  dan: 'da',
  fin: 'fi',
  gre: 'el',
  ell: 'el',
  tur: 'tr',
  ara: 'ar',
  jpn: 'ja',
  chi: 'zh',
  zho: 'zh',
  kor: 'ko',
  hun: 'hu',
  cze: 'cs',
  ces: 'cs',
  ukr: 'uk',
  ron: 'ro',
  rum: 'ro',
  hin: 'hi',
};

/** Normalize a language tag to a 2-letter code; `und`/unknown → null. */
export function languageCode(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const lower = tag.trim().toLowerCase();
  if (!lower || lower === 'und' || lower === 'unknown') return null;
  const base = lower.split(/[-_]/)[0]!;
  if (base.length === 3) return ISO_639_2_TO_1[base] ?? null;
  return base.length === 2 ? base : null;
}

/** A scored pair awaiting the competition below. */
export interface RivalPair<T> {
  ebookId: string;
  audioId: string;
  score: number;
  item: T;
}

/**
 * Keep only the suggestions that win their side of the shelf.
 *
 * Scoring each pair on its own lets one ebook be suggested against several
 * audiobooks and vice versa. Someone who owns two books by one author in both
 * formats gets the two right pairs AND the two crossed ones - and on the
 * shelf the crossed ones look just as plausible, because everything except
 * the title agrees.
 *
 * A book has one audiobook, so two suggestions for the same file are two
 * guesses at one answer. A pair survives only if nothing clearly better wants
 * either of its halves. Ties survive: two editions of the same book score
 * within a hair of each other and both deserve to be offered.
 */
export function chooseRivalPairs<T>(
  pairs: readonly RivalPair<T>[],
  opts: {
    /** Books already linked to something; they are out of the running. */
    settledEbooks?: ReadonlySet<string>;
    settledAudios?: ReadonlySet<string>;
    margin?: number;
  } = {},
): RivalPair<T>[] {
  const margin = opts.margin ?? PAIR_RIVAL_MARGIN;
  const best = new Map<string, number>();
  const note = (k: string, v: number) => best.set(k, Math.max(best.get(k) ?? 0, v));
  for (const p of pairs) {
    note(`e:${p.ebookId}`, p.score);
    note(`a:${p.audioId}`, p.score);
  }
  return pairs.filter((p) => {
    if (opts.settledEbooks?.has(p.ebookId) || opts.settledAudios?.has(p.audioId)) return false;
    const bestE = best.get(`e:${p.ebookId}`) ?? p.score;
    const bestA = best.get(`a:${p.audioId}`) ?? p.score;
    return p.score >= bestE - margin && p.score >= bestA - margin;
  });
}
