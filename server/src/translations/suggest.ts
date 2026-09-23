import {
  expansionRatio,
  lengthRatioScore,
  normaliseLanguage,
  type TranslationEvidence,
} from '@readport/shared';
import { type DB } from '../db/index.js';
import { romanize } from '../alignment/ctc/romanize.js';
import { normalizeAuthor, normalizeForMatch, stringSimilarity } from '../util/text.js';
import { visibleSql } from '../library/visibility.js';
import { dismissed, groupOf } from './groups.js';

/**
 * Guessing which books are the same work in another language.
 *
 * A translation shares almost nothing with its original on the surface:
 * the title is translated, the text is translated, and even the author's
 * name is often in another alphabet. What survives is the author - once
 * both names are written in the same letters - a place in a series, the
 * number of chapters, and a length that a translation into that language
 * would have. Those are what this compares.
 *
 * It only ever suggests. A curator links; a guess never does.
 */

/** Characters of text per second of narration, as the pair scorer assumes (pairing/score.ts). */
const NARRATION_CHARS_PER_SEC = 16.5;
/** Below this a guess is not worth anybody's time. */
export const TRANSLATION_SUGGEST_THRESHOLD = 0.62;
/** A rival this close to the best guess for the same book is shown beside it: it may be the right one. */
const RIVAL_MARGIN = 0.04;

/** One title as the suggester sees it: its books, and the facts it compares. */
export interface TitleFacts {
  /** The id that stands for the title: its ebook when it has one. */
  id: string;
  books: { id: string; kind: 'ebook' | 'audio'; format: string; hasCover: boolean }[];
  title: string;
  author: string | null;
  language: string | null;
  series: string | null;
  seriesIdx: number | null;
  /** Characters of text, from the ebook. */
  chars: number | null;
  /** Running time, from the audiobook. */
  durationMs: number | null;
  /** Chapters in the ebook's table of contents. */
  chapters: number | null;
}

interface NameForms {
  /** Each word of the name in Latin letters, sorted: "sharon rivka" and "rivka sharon" agree. */
  roman: string;
  /** The same, consonants only, with sounds scripts spell differently folded together. */
  skeleton: string;
  words: string[];
}

/**
 * The consonants of a romanized word, with the letters different scripts
 * use for one sound folded together: Hebrew writes the vowels it writes at
 * all as consonants, Cyrillic's ш is "sh", and a b in one alphabet is a v in
 * another (Hebrew ב is both).
 */
export function skeleton(word: string): string {
  return word
    .replace(/kh/g, 'k')
    .replace(/sh/g, 's')
    .replace(/ch/g, 'c')
    .replace(/zh/g, 'z')
    .replace(/ts/g, 'c')
    .replace(/[aeiouy'h]/g, '')
    .replace(/[vw]/g, 'b')
    .replace(/f/g, 'p')
    .replace(/[qc]/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1');
}

export function nameForms(name: string, language: string | null): NameForms {
  const words = normalizeAuthor(name)
    .split(' ')
    .map((w) => romanize(w, language ?? 'en'))
    .filter((w) => w.length > 0)
    .sort();
  return { roman: words.join(' '), skeleton: words.map(skeleton).join(' '), words };
}

/**
 * How alike two author names are, 0-1, whatever alphabet each is in. The
 * surname alone counts too, when the first names at least start the same
 * way - "R. Sharon" is Rivka Sharon; "Anna Petrova" is not "Maria Petrova".
 */
export function authorSimilarity(a: NameForms, b: NameForms): number {
  if (!a.roman || !b.roman) return 0;
  let best = Math.max(
    stringSimilarity(a.roman, b.roman),
    stringSimilarity(a.skeleton, b.skeleton) * 0.95,
  );
  const longest = (f: NameForms) => [...f.words].sort((x, y) => y.length - x.length)[0] ?? '';
  const sa = longest(a);
  const sb = longest(b);
  const surname = Math.max(
    stringSimilarity(sa, sb),
    stringSimilarity(skeleton(sa), skeleton(sb)) * 0.95,
  );
  const restA = a.words.filter((w) => w !== sa).map((w) => w[0]);
  const restB = b.words.filter((w) => w !== sb).map((w) => w[0]);
  if (surname >= 0.85 && restA.length > 0 && restA.every((c, i) => restB[i] === c))
    best = Math.max(best, surname * 0.95);
  return best;
}

/** Words of a title worth comparing across languages: the long ones, which names are. */
function titleWords(title: string, language: string | null): Set<string> {
  return new Set(
    normalizeForMatch(title)
      .split(' ')
      .filter((w) => w.length >= 4)
      .map((w) => romanize(w, language ?? 'en'))
      .filter((w) => w.length >= 4),
  );
}

function lengthEvidence(x: TitleFacts, y: TitleFacts): number | null {
  const grow = expansionRatio(x.language, y.language);
  if (x.chars && y.chars) return lengthRatioScore(y.chars / (x.chars * grow));
  if (x.durationMs && y.durationMs) return lengthRatioScore(y.durationMs / x.durationMs);
  const text = x.chars ? x : y.chars ? y : null;
  const audio = x.durationMs ? x : y.durationMs ? y : null;
  if (text && audio && text !== audio) {
    const chars = text.chars! * expansionRatio(text.language, audio.language);
    return lengthRatioScore(audio.durationMs! / ((chars / NARRATION_CHARS_PER_SEC) * 1000));
  }
  return null;
}

function chapterEvidence(x: TitleFacts, y: TitleFacts): number | null {
  if (!x.chapters || !y.chapters) return null;
  const hi = Math.max(x.chapters, y.chapters);
  const off = Math.abs(x.chapters - y.chapters);
  if (off <= Math.max(1, Math.round(hi * 0.1))) return 1;
  return Math.max(0, 1 - (off / hi) * 2);
}

/** How likely two titles are the same work in two languages, and why; null when not at all. */
export function scoreTranslation(
  x: TitleFacts,
  y: TitleFacts,
): { score: number; evidence: TranslationEvidence } | null {
  const lx = normaliseLanguage(x.language);
  const ly = normaliseLanguage(y.language);
  // Two languages, both known: a book of unknown language could as easily
  // be a second copy in the same one.
  if (!lx || !ly || lx === ly) return null;
  const author =
    x.author && y.author
      ? authorSimilarity(nameForms(x.author, lx), nameForms(y.author, ly))
      : null;
  const sameSeriesPlace =
    x.seriesIdx != null && y.seriesIdx != null && Math.abs(x.seriesIdx - y.seriesIdx) < 0.01;
  // The author is what a translation keeps. Without them agreeing, only a
  // series and its place in it together are worth a look.
  if ((author ?? 0) < 0.8 && !(sameSeriesPlace && author === null)) return null;
  const length = lengthEvidence(x, y);
  const chapters = chapterEvidence(x, y);
  const words = titleWords(x.title, lx);
  const shared = [...titleWords(y.title, ly)].filter((w) => words.has(w)).length;
  const score =
    0.5 * (author ?? 0.6) +
    0.2 * (length ?? 0.5) +
    0.15 * (chapters ?? 0.5) +
    0.1 * (sameSeriesPlace ? 1 : x.seriesIdx != null && y.seriesIdx != null ? 0 : 0.5) +
    0.05 * Math.min(1, shared);
  // Clearly different lengths or structures rule a pair out, however alike
  // the names: the same author wrote their other books too.
  if ((length !== null && length < 0.3) || (chapters !== null && chapters < 0.3)) return null;
  if (score < TRANSLATION_SUGGEST_THRESHOLD) return null;
  return {
    score: Math.round(score * 1000) / 1000,
    evidence: {
      author: (author ?? 0) >= 0.8,
      series: sameSeriesPlace,
      length: (length ?? 0) >= 0.5,
      chapters: (chapters ?? 0) >= 0.7,
    },
  };
}

/**
 * Every title in the library as the suggester needs it - ready books only,
 * and only those the asker may see - each once, by its ebook where it has
 * one.
 */
export function libraryTitles(db: DB, sees: boolean): TitleFacts[] {
  const books = db
    .prepare(
      `SELECT b.id, b.kind, b.format, b.title, b.author, b.language, b.series, b.series_idx,
              b.duration_ms, b.meta_json, b.cover_path,
              (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count
         FROM books b WHERE b.scan_state = 'ready' AND ${visibleSql(sees)}`,
    )
    .all() as {
    id: string;
    kind: string;
    format: string;
    title: string;
    author: string | null;
    language: string | null;
    series: string | null;
    series_idx: number | null;
    duration_ms: number | null;
    meta_json: string | null;
    cover_path: string | null;
    chapter_count: number;
  }[];
  const byId = new Map(books.map((b) => [b.id, b]));
  const partner = new Map<string, string>();
  for (const p of db
    .prepare("SELECT ebook_id, audio_id FROM pairs WHERE status IN ('auto','confirmed')")
    .all() as { ebook_id: string; audio_id: string }[]) {
    if (!byId.has(p.ebook_id) || !byId.has(p.audio_id)) continue;
    if (!partner.has(p.ebook_id)) partner.set(p.ebook_id, p.audio_id);
    if (!partner.has(p.audio_id)) partner.set(p.audio_id, p.ebook_id);
  }
  const done = new Set<string>();
  const out: TitleFacts[] = [];
  const ordered = [...books].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'ebook' ? -1 : 1));
  for (const b of ordered) {
    if (done.has(b.id)) continue;
    const other = partner.get(b.id);
    const members = [b, ...(other && !done.has(other) ? [byId.get(other)!] : [])];
    for (const m of members) done.add(m.id);
    const ebook = members.find((m) => m.kind === 'ebook') ?? null;
    const audio = members.find((m) => m.kind === 'audio') ?? null;
    const lead = ebook ?? audio!;
    let chars: number | null = null;
    try {
      chars = ebook ? (JSON.parse(ebook.meta_json ?? '{}').totalChars ?? null) : null;
    } catch {
      chars = null;
    }
    out.push({
      id: lead.id,
      books: members
        .sort((m1, m2) => (m1.kind === 'ebook' ? -1 : 1) - (m2.kind === 'ebook' ? -1 : 1))
        .map((m) => ({
          id: m.id,
          kind: m.kind === 'audio' ? 'audio' : 'ebook',
          format: m.format,
          hasCover: !!m.cover_path,
        })),
      title: lead.title,
      author: lead.author ?? ebook?.author ?? audio?.author ?? null,
      language: normaliseLanguage(lead.language ?? ebook?.language ?? audio?.language ?? null),
      series: lead.series ?? null,
      seriesIdx: lead.series_idx ?? null,
      chars,
      durationMs: audio?.duration_ms ?? null,
      chapters: ebook ? Number(ebook.chapter_count) || null : null,
    });
  }
  return out;
}

export interface Suggestion {
  title: TitleFacts;
  score: number;
  evidence: TranslationEvidence;
}

function eligible(db: DB, x: TitleFacts, y: TitleFacts): boolean {
  const gx = groupOf(db, x.id);
  if (gx && gx === groupOf(db, y.id)) return false;
  return !dismissed(
    db,
    x.books.map((b) => b.id),
    y.books.map((b) => b.id),
  );
}

/** The best guesses for one book, best first: per other language, the leader and whoever is close behind it. */
export function suggestionsFor(db: DB, bookId: string, sees: boolean, limit = 5): Suggestion[] {
  const titles = libraryTitles(db, sees);
  const mine = titles.find((t) => t.books.some((b) => b.id === bookId));
  if (!mine) return [];
  const scored: Suggestion[] = [];
  for (const other of titles) {
    if (other === mine) continue;
    const s = scoreTranslation(mine, other);
    if (s && eligible(db, mine, other)) scored.push({ title: other, ...s });
  }
  const best = new Map<string, number>();
  for (const s of scored)
    best.set(s.title.language!, Math.max(best.get(s.title.language!) ?? 0, s.score));
  return scored
    .filter((s) => s.score >= best.get(s.title.language!)! - RIVAL_MARGIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Every guess in the library, for the page that lists them all: two titles
 * each other's best in the other's language, best first. Titles are only
 * compared within a shared first letter of a surname skeleton, so a large
 * library costs a little more than a small one rather than its square.
 */
export function librarySuggestions(
  db: DB,
  sees: boolean,
  limit = 100,
): { a: TitleFacts; b: TitleFacts; score: number; evidence: TranslationEvidence }[] {
  const titles = libraryTitles(db, sees).filter((t) => t.author && t.language);
  const buckets = new Map<string, TitleFacts[]>();
  for (const t of titles) {
    const forms = nameForms(t.author!, t.language);
    const keys = new Set(forms.words.map((w) => skeleton(w).slice(0, 2)).filter(Boolean));
    for (const k of keys) {
      const list = buckets.get(k) ?? [];
      list.push(t);
      buckets.set(k, list);
    }
  }
  const pairs = new Map<
    string,
    { a: TitleFacts; b: TitleFacts; score: number; evidence: TranslationEvidence }
  >();
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = list[i]!.id < list[j]!.id ? [list[i]!, list[j]!] : [list[j]!, list[i]!];
        const key = `${a.id}|${b.id}`;
        if (pairs.has(key)) continue;
        const s = scoreTranslation(a, b);
        if (s && eligible(db, a, b)) pairs.set(key, { a, b, ...s });
      }
    }
  }
  // Each title's best score per other language: a pair is kept when it is
  // near the top for both of its titles.
  const top = new Map<string, number>();
  const note = (t: TitleFacts, lang: string, score: number) => {
    const k = `${t.id}|${lang}`;
    top.set(k, Math.max(top.get(k) ?? 0, score));
  };
  for (const p of pairs.values()) {
    note(p.a, p.b.language!, p.score);
    note(p.b, p.a.language!, p.score);
  }
  return [...pairs.values()]
    .filter(
      (p) =>
        p.score >= top.get(`${p.a.id}|${p.b.language}`)! - RIVAL_MARGIN &&
        p.score >= top.get(`${p.b.id}|${p.a.language}`)! - RIVAL_MARGIN,
    )
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}
