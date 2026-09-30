import { NgramIndex } from './ngram-index.js';

/**
 * Character-anchor matcher for CTC forced alignment.
 *
 * The CTC model emits one continuous romanized character stream with a
 * millisecond stamp per character (no word/space token). This module pairs that
 * stream against the ebook's romanized characters and derives per-sentence
 * timings.
 *
 * Method (validated on an hour-long human-narrated audiobook: nearly nineteen
 * thousand candidate anchors, all but a handful monotone after LIS, about 94%
 * of sentences aligned, every spot check on the correct sentence):
 *
 *  1. Concatenate the sentences into one book string, remembering which span
 *     belongs to which sentence.
 *  2. Take every N-gram (N=14) of both strings and keep only the grams that
 *     occur EXACTLY ONCE on each side. Those pairs are candidate anchors -
 *     unambiguous by construction, so no similarity threshold is needed.
 *  3. A longest increasing subsequence over the heard positions throws away the
 *     candidates that would require the narrator to jump backwards.
 *  4. Linear interpolation between consecutive anchors maps any book character
 *     position to a millisecond; positions outside the anchor range clamp.
 *  5. A sentence whose nearest anchor is further away than `gapChars` is
 *     reported as a gap rather than a timing.
 *
 * Why anchors rather than a global forced alignment or DTW: this makes no
 * proportionality assumption between book position and audio time. Front
 * matter, credits, headings and any other un-narrated text simply produce no
 * anchors, so they become gaps instead of dragging the whole mapping off (the
 * failure mode measured on the DTW prototype, where every spot check landed on
 * the wrong sentence).
 *
 * Pure: no I/O, no clock, deterministic for a given input.
 */

/** One decoded character with the timestamp of the frame that emitted it. */
export interface HeardChar {
  c: string;
  ms: number;
}

/** One ebook sentence, already romanized to the model's character set. */
export interface BookSentence {
  index: number;
  romanized: string;
  /**
   * The part of the book it is in: its chapter file (spine item).
   *
   * A narration leaves out whole parts - the front matter, a preface, a
   * chapter's summary page - far more often than a few sentences inside one,
   * and knowing where the parts begin and end is what lets a stretch whose
   * text could not have been read in its time say WHICH text that was (see
   * `findSkips`). Absent, nothing is inferred and the stretch is interpolated
   * as it always was.
   */
  block?: number;
}

export interface SentenceTiming {
  index: number;
  startMs: number;
  endMs: number;
  /** 1 at an anchor, falling linearly to 0 at `gapChars` away. 0 for gaps. */
  score: number;
  /** True when no anchor is near enough for the timing to be trustworthy. */
  gap: boolean;
  /**
   * The narration left this sentence out (see `findSkips`): not a sentence
   * nobody could place, but one the audiobook does not read.
   */
  skipped?: boolean;
  /**
   * How far `startMs` could be wrong, in milliseconds. Zero on an anchor and
   * growing with the audio distance to the nearest one, because everything
   * between two anchors is interpolation and interpolation assumes a steady
   * reading rate that a pause, a chapter break or a page of front matter
   * quietly breaks. The reader subtracts this before a switch, so a handoff
   * lands on narration already read rather than ahead of it.
   */
  uncertaintyMs: number;
}

/** One place where the decoded audio and the book text provably agree. */
export interface Anchor {
  /** Character offset into the concatenated book text. */
  bookPos: number;
  /** Absolute millisecond in the book's audio. */
  ms: number;
}

export interface MatchStats {
  bookChars: number;
  heardChars: number;
  /** heard/book. ~0.94 on real narration; digits and abbreviations decode short. */
  charRatio: number;
  candidateAnchors: number;
  monotoneAnchors: number;
  anchorsPerKiloChar: number;
  alignedSentences: number;
  /**
   * The pairing is not credible: too few monotone anchors for the book's
   * length. This is the refusal signal - a wrong book/audio pairing produces
   * near-zero anchors, where a correct one produced ~386 per 1000 characters.
   */
  implausible: boolean;
  /**
   * The decoded stream was longer than `maxIndexChars` and only a prefix of it
   * was indexed. Reaching this means a whole-book decode of an audiobook
   * longer than any that exists; the ebook side has no such limit.
   */
  indexTruncated: boolean;
}

export interface MatchOptions {
  /** N-gram length used for anchoring. 14 is the validated value. */
  ngram?: number;
  /** Distance (in book characters) to the nearest anchor beyond which a sentence is a gap. */
  gapChars?: number;
  /** True audio duration. Timings are clamped to it; defaults to the last heard stamp. */
  audioMs?: number;
  /** Below this anchor density the pairing is refused outright. */
  minAnchorsPerKiloChar?: number;
  /** Memory guard on the decoded side, which is the only side that is indexed. */
  maxIndexChars?: number;
  /**
   * Fraction of the audio distance to the nearest anchor that a timing may be
   * wrong by. See {@link SentenceTiming.uncertaintyMs}.
   */
  uncertaintyRate?: number;
  /** Floor under every uncertainty, covering frame quantisation and seek error. */
  uncertaintyBaseMs?: number;
}

export interface MatchResult {
  timings: SentenceTiming[];
  stats: MatchStats;
  /**
   * The monotone anchor set the timings were interpolated from, in book order.
   * Exposed so a sparse decode can see where its evidence actually is and
   * spend another probe where the narration rate says something happened.
   */
  anchors: Anchor[];
}

const DEFAULT_NGRAM = 14;
const DEFAULT_GAP_CHARS = 3000;
const DEFAULT_MIN_ANCHORS_PER_KILOCHAR = 2;
/**
 * Uncertainty slope and floor, measured rather than chosen. Against a
 * contiguous decode of a real hour-long audiobook, sampled every 150 seconds:
 * signed error ran from about -20 s to +9 s with a median of half a second, and
 * this slope covered all but about one timed sentence in seventy. The floor covers the rest - the
 * sentences sitting right on an anchor, where the residual is frame
 * quantisation, the seek, and the reference's own imprecision rather than
 * anything this module can model.
 */
const DEFAULT_UNCERTAINTY_RATE = 0.15;
const DEFAULT_UNCERTAINTY_BASE_MS = 2_000;
/**
 * Cap on the DECODED side only. Each indexed position costs sixteen bytes of
 * typed array at a load factor of one half, so this ceiling is ~130 MB and is
 * only ever approached by a whole-book decode of a book of about 180 hours.
 * Sampling a six-hour audiobook indexes about 90,000 characters - under 3 MB.
 * The ebook is streamed past the index rather than indexed, so its length is
 * unbounded.
 */
const DEFAULT_MAX_INDEX_CHARS = 8_000_000;

/**
 * Match the decoded character stream against the book's romanized characters.
 *
 * When the match is implausible the timings are withheld entirely (empty
 * array) rather than returned sparse: a caller that trusted a handful of
 * coincidental anchors would scatter the reader across the wrong audio. The
 * `implausible` flag says why, so the caller can surface the refusal.
 */
export function matchChars(
  book: BookSentence[],
  heard: HeardChar[],
  opts: MatchOptions = {},
): MatchResult {
  const ngram = Math.max(1, Math.trunc(opts.ngram ?? DEFAULT_NGRAM));
  const gapChars = Math.max(1, opts.gapChars ?? DEFAULT_GAP_CHARS);
  const minDensity = Math.max(0, opts.minAnchorsPerKiloChar ?? DEFAULT_MIN_ANCHORS_PER_KILOCHAR);
  const maxIndexChars = Math.max(ngram, Math.trunc(opts.maxIndexChars ?? DEFAULT_MAX_INDEX_CHARS));
  const uncertaintyRate = Math.max(0, opts.uncertaintyRate ?? DEFAULT_UNCERTAINTY_RATE);
  const uncertaintyBaseMs = Math.max(0, opts.uncertaintyBaseMs ?? DEFAULT_UNCERTAINTY_BASE_MS);

  // --- 1. one book string, plus the span each sentence owns ---
  const spans: { start: number; end: number }[] = [];
  const pieces: string[] = [];
  let cursor = 0;
  for (const s of book) {
    const start = cursor;
    cursor += s.romanized.length;
    spans.push({ start, end: cursor });
    pieces.push(s.romanized);
  }
  const bookText = pieces.join('');

  // Heard side. A decoder entry is normally a single character, but we expand
  // defensively so that a multi-character entry cannot desynchronise positions
  // from stamps. The running max hardens the later monotonicity guarantee
  // against a decoder that emits a stamp out of order.
  let heardText = '';
  const heardMs: number[] = [];
  let lastMs = 0;
  for (const h of heard) {
    lastMs = Math.max(lastMs, h.ms);
    heardText += h.c;
    for (let i = 0; i < h.c.length; i++) heardMs.push(lastMs);
  }

  const durationMs = Math.max(0, opts.audioMs ?? lastMs);

  // --- 2. candidate anchors: grams unique on both sides ---
  // Indexed on the heard side and streamed on the book side. Under sampling
  // the heard stream is a few tens of thousands of characters against a book's
  // million-plus, so this is both the small index and the one that bounds
  // memory; the book is never truncated.
  const indexTruncated = heardText.length > maxIndexChars;
  const index = new NgramIndex(heardText, ngram, maxIndexChars);
  const pairs = index
    .matchAgainst(bookText)
    .map((m) => ({ b: m.b, h: m.a }))
    // The scan runs in book order already, but the sort makes the LIS
    // precondition explicit rather than incidental.
    .sort((x, y) => x.b - y.b);

  // --- 3. LIS over the heard positions enforces narration order ---
  const anchors = longestIncreasingByHeard(pairs);
  const anchorBook = anchors.map((a) => a.b);
  const anchorMs = anchors.map((a) => heardMs[a.h] ?? 0);

  const density = bookText.length > 0 ? (anchors.length * 1000) / bookText.length : 0;
  const stats: MatchStats = {
    bookChars: bookText.length,
    heardChars: heardText.length,
    charRatio: bookText.length > 0 ? heardText.length / bookText.length : 0,
    candidateAnchors: pairs.length,
    monotoneAnchors: anchors.length,
    anchorsPerKiloChar: density,
    alignedSentences: 0,
    // An empty book has nothing to verify against, so it can never be credible.
    implausible: bookText.length === 0 || density < minDensity,
    indexTruncated,
  };

  const anchorList: Anchor[] = anchorBook.map((bookPos, i) => ({ bookPos, ms: anchorMs[i]! }));
  if (stats.implausible) return { timings: [], stats, anchors: anchorList };

  // Fallback for positions clamped outside the anchor span, where there is no
  // bracketing pair to measure a time distance against.
  const msPerChar =
    anchorBook.length > 1
      ? Math.max(
          0,
          (anchorMs[anchorMs.length - 1]! - anchorMs[0]!) /
            Math.max(1, anchorBook[anchorBook.length - 1]! - anchorBook[0]!),
        )
      : 0;

  /**
   * How fast this narrator actually reads, measured robustly.
   *
   * Not the average above: that is total time over total characters, so every
   * pause in the book is folded into it. A book with a fifteen-second break
   * between chapters reports a rate that already "expects" those breaks, and
   * then no individual span looks unusual - which is precisely how a pause
   * hides. The median across consecutive anchor pairs is immune: a pause
   * inflates the one span that contains it and leaves the other several
   * hundred alone.
   */
  const readingMsPerChar = (() => {
    const rates: number[] = [];
    for (let i = 1; i < anchorBook.length; i++) {
      const chars = anchorBook[i]! - anchorBook[i - 1]!;
      const ms = anchorMs[i]! - anchorMs[i - 1]!;
      if (chars > 0 && ms > 0) rates.push(ms / chars);
    }
    if (rates.length === 0) return msPerChar;
    rates.sort((a, b) => a - b);
    return rates[rates.length >> 1]!;
  })();

  // --- 4. text the narration left out ---
  // Between two anchors the timeline is interpolated by characters, which is
  // right while the narrator reads everything in between and badly wrong when
  // they skip something: a two-page preface between the book's title and its
  // first chapter was spread across the first minute of narration, and the
  // highlight swept through it while the voice read chapter one. Where the
  // book's parts say what was skipped, it is taken out of the timeline.
  const skips = findSkips(book, spans, anchorBook, anchorMs, readingMsPerChar, durationMs);
  const timeBook = skips.anchors.length
    ? mergeAnchors(anchorBook, anchorMs, skips.anchors)
    : { book: anchorBook, ms: anchorMs };

  // --- 5 + 6. interpolate, then gate on anchor distance ---
  const timings: SentenceTiming[] = [];
  let floorMs = 0;
  for (let i = 0; i < book.length; i++) {
    const span = spans[i]!;
    const length = span.end - span.start;
    const dist = nearestAnchorDistance(anchorBook, span.start);
    // Measured from the sentence start, as validated. An empty sentence (a
    // heading, or one that romanized to nothing) has no characters to anchor,
    // so we never claim a timing for it; nor for one the narration skipped.
    const gap =
      length === 0 || anchorBook.length === 0 || dist > gapChars || skips.skipped[i] === 1;

    let startMs = clamp(msAtBookPos(timeBook.book, timeBook.ms, span.start), 0, durationMs);
    // Monotone in position by construction; the running floor makes it a
    // guarantee the caller can rely on rather than a property of the anchors.
    startMs = Math.max(startMs, floorMs);
    const endMs = Math.max(
      startMs,
      clamp(msAtBookPos(timeBook.book, timeBook.ms, span.end), 0, durationMs),
    );
    floorMs = startMs;

    // Measured on the interpolated timing, not the floored one: the floor only
    // ever moves a start later, and a start pushed later is exactly the case
    // the reader must be protected from.
    const reach = anchorTimeDistance(
      anchorMs,
      anchorBook,
      span.start,
      dist,
      msPerChar,
      readingMsPerChar,
      uncertaintyRate,
    );
    // Inside the anchored range `reach.ms` is already the whole doubt - rate
    // drift plus whatever time the span cannot account for. Outside it, the
    // timing is not an interpolation at all: it is the edge anchor's time,
    // held, while the narration kept going, so the entire extrapolated
    // distance is the error.
    const doubt = reach.ms;
    timings.push({
      index: book[i]!.index,
      startMs,
      endMs,
      score: gap ? 0 : Math.max(0, 1 - dist / gapChars),
      gap,
      ...(skips.skipped[i] === 1 ? { skipped: true } : {}),
      uncertaintyMs: Math.round(uncertaintyBaseMs + doubt),
    });
  }
  stats.alignedSentences = timings.reduce((n, t) => n + (t.gap ? 0 : 1), 0);

  return { timings, stats, anchors: anchorList };
}

/**
 * A stretch whose text would take this many times its duration to read, at
 * the narrator's own measured pace, has text in it the narrator did not
 * read...
 */
const SKIP_RATIO = 1.5;
/** ...when the text it cannot account for is at least this much reading. */
const SKIP_MIN_MS = 10_000;
/**
 * Once the skipped text is taken out, what is left has to be readable in the
 * stretch's time - allowing a narrator this much faster than their median.
 */
const FIT_MAX = 1.2;
/**
 * How much of the opening of a part may be taken for a heading and an
 * introduction the narrator left out, when the parts in between do not
 * account for the whole of the skip.
 */
const HEAD_MAX_CHARS = 1_500;

interface Skips {
  /** 1 for a sentence the narration left out. */
  skipped: Uint8Array;
  /** Where narration stops and resumes around each skip, as inferred anchors. */
  anchors: Anchor[];
}

/**
 * The text the narration left out, found stretch by stretch.
 *
 * A stretch between two anchors (or between the start of the audio and the
 * first anchor, or the last and the end) whose text cannot have been read in
 * its time has had something skipped. The book's parts say what: the whole
 * parts strictly between the two anchors - a preface, a chapter's summary
 * page, the front matter - and, when those are not all of it, the opening of
 * the part the narration resumes in (a heading, an introduction). The first
 * of those that leaves text the narrator could have read in the time is
 * taken. What remains is timed at the narrator's pace outward from the
 * anchors - the text after the first anchor from it, the text before the
 * second up to it - and the rest of the time is simply time with no text:
 * an announcement, a pause, music.
 *
 * Without the parts nothing is inferred: the book gives no way to tell a
 * skipped preface from a skipped sentence, and interpolation is left to do
 * what it always did.
 */
function findSkips(
  book: BookSentence[],
  spans: { start: number; end: number }[],
  anchorBook: number[],
  anchorMs: number[],
  msPerChar: number,
  durationMs: number,
): Skips {
  const skipped = new Uint8Array(book.length);
  const anchors: Anchor[] = [];
  if (book.length === 0 || anchorBook.length === 0 || !(msPerChar > 0)) return { skipped, anchors };
  if (book.some((s) => s.block === undefined)) return { skipped, anchors };
  const total = spans[spans.length - 1]!.end;
  /** The sentence a book position falls in. */
  const sentenceAt = (pos: number): number => {
    let lo = 0;
    let hi = spans.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (spans[mid]!.start <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // The stretches: before the first anchor, between each two, after the last.
  const edges: { b0: number; m0: number; b1: number; m1: number; head: boolean; tail: boolean }[] =
    [];
  edges.push({ b0: 0, m0: 0, b1: anchorBook[0]!, m1: anchorMs[0]!, head: true, tail: false });
  for (let k = 1; k < anchorBook.length; k++) {
    edges.push({
      b0: anchorBook[k - 1]!,
      m0: anchorMs[k - 1]!,
      b1: anchorBook[k]!,
      m1: anchorMs[k]!,
      head: false,
      tail: false,
    });
  }
  edges.push({
    b0: anchorBook[anchorBook.length - 1]!,
    m0: anchorMs[anchorMs.length - 1]!,
    b1: total,
    m1: Math.max(anchorMs[anchorMs.length - 1]!, durationMs),
    head: false,
    tail: true,
  });

  for (const e of edges) {
    const T = e.m1 - e.m0;
    const C = e.b1 - e.b0;
    if (C <= 0 || C * msPerChar <= T * SKIP_RATIO || C * msPerChar - T < SKIP_MIN_MS) continue;
    // The sentences the two anchors are in are heard; only those strictly
    // between them can have been skipped. At the edges of the book there is
    // no sentence on the far side.
    const iL = e.head ? -1 : sentenceAt(e.b0);
    const iR = e.tail ? book.length : sentenceAt(e.b1);
    if (iR - iL < 2) continue;
    const blockL = iL >= 0 ? book[iL]!.block! : -Infinity;
    const blockR = iR < book.length ? book[iR]!.block! : Infinity;
    // The skip candidates, in order: whole parts strictly between the anchors'
    // own parts, then as much of the opening of the right-hand part as it
    // takes (never more than HEAD_MAX_CHARS).
    let innerFrom = iL + 1;
    while (innerFrom < iR && book[innerFrom]!.block === blockL) innerFrom++;
    let innerTo = innerFrom; // exclusive
    while (innerTo < iR && book[innerTo]!.block !== blockR) innerTo++;
    const charsOf = (a: number, b: number) => (b > a ? spans[b - 1]!.end - spans[a]!.start : 0);
    const fits = (skipChars: number) => (C - skipChars) * msPerChar <= T * FIT_MAX;
    let from = -1;
    let to = -1;
    if (innerTo > innerFrom && fits(charsOf(innerFrom, innerTo))) {
      from = innerFrom;
      to = innerTo;
    } else {
      // Take the right-hand part's opening, a sentence at a time.
      let head = innerTo;
      while (head < iR && charsOf(innerTo, head + 1) <= HEAD_MAX_CHARS) {
        head++;
        if (fits(charsOf(innerFrom, head))) {
          from = innerFrom;
          to = head;
          break;
        }
      }
    }
    if (from < 0 || to <= from) continue;
    for (let i = from; i < to; i++) skipped[i] = 1;
    // What is left is read at the narrator's pace outward from the anchors -
    // or a touch faster, when it only just fits.
    const left = spans[from]!.start - e.b0;
    const right = e.b1 - spans[to - 1]!.end;
    const pace = left + right > 0 ? Math.min(msPerChar, T / (left + right)) : msPerChar;
    anchors.push({ bookPos: spans[from]!.start, ms: Math.round(e.m0 + left * pace) });
    anchors.push({ bookPos: spans[to - 1]!.end, ms: Math.round(e.m1 - right * pace) });
  }
  return { skipped, anchors };
}

/** Real and inferred anchors in one book-ordered timeline, strictly increasing in both. */
function mergeAnchors(
  anchorBook: number[],
  anchorMs: number[],
  extra: Anchor[],
): { book: number[]; ms: number[] } {
  const all = anchorBook.map((b, i) => ({ bookPos: b, ms: anchorMs[i]! }));
  for (const a of extra) all.push(a);
  all.sort((x, y) => x.bookPos - y.bookPos || x.ms - y.ms);
  const book: number[] = [];
  const ms: number[] = [];
  for (const a of all) {
    if (book.length && a.bookPos <= book[book.length - 1]!) continue;
    ms.push(Math.max(a.ms, ms.length ? ms[ms.length - 1]! : 0));
    book.push(a.bookPos);
  }
  return { book, ms };
}

/**
 * Longest strictly increasing subsequence of heard positions, over pairs that
 * are already sorted by book position. Patience sorting, O(n log n).
 */
function longestIncreasingByHeard(pairs: { b: number; h: number }[]): { b: number; h: number }[] {
  if (pairs.length === 0) return [];
  const tails: number[] = []; // tails[k] = smallest heard pos ending a run of length k+1
  const tailIdx: number[] = []; // index into pairs of that run's last element
  const prev = new Array<number>(pairs.length).fill(-1);

  for (let i = 0; i < pairs.length; i++) {
    const v = pairs[i]!.h;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
    prev[i] = lo > 0 ? tailIdx[lo - 1]! : -1;
    tailIdx[lo] = i;
  }

  const out: { b: number; h: number }[] = [];
  let k = tailIdx[tails.length - 1] ?? -1;
  while (k >= 0) {
    out.push(pairs[k]!);
    k = prev[k]!;
  }
  out.reverse();
  return out;
}

/** Linear interpolation between the bracketing anchors; clamps outside them. */
function msAtBookPos(anchorBook: number[], anchorMs: number[], pos: number): number {
  const last = anchorBook.length - 1;
  if (last < 0) return 0;
  if (pos <= anchorBook[0]!) return anchorMs[0]!;
  if (pos >= anchorBook[last]!) return anchorMs[last]!;

  // Greatest i with anchorBook[i] <= pos.
  let lo = 0;
  let hi = last;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (anchorBook[mid]! <= pos) lo = mid;
    else hi = mid;
  }
  const b0 = anchorBook[lo]!;
  const b1 = anchorBook[hi]!;
  const m0 = anchorMs[lo]!;
  const m1 = anchorMs[hi]!;
  const f = (pos - b0) / Math.max(1, b1 - b0);
  return Math.round(m0 + f * (m1 - m0));
}

/**
 * Milliseconds of audio between `pos` and the nearer of its two bracketing
 * anchors - the span over which the interpolation is unverified.
 *
 * Character distance is not a usable proxy: 500 characters is two seconds of
 * brisk narration or twenty across a chapter break, and it is the seconds that
 * decide how far a switch can land from where the reader expected. Outside the
 * anchored range there is no bracketing pair, so the char distance is converted
 * at the book's average rate instead.
 */
function anchorTimeDistance(
  anchorMs: number[],
  anchorBook: number[],
  pos: number,
  charDist: number,
  msPerChar: number,
  /** The narrator's own rate, median-measured, with pauses excluded. */
  readingMsPerChar: number,
  rate: number,
): { ms: number; clamped: boolean } {
  const last = anchorBook.length - 1;
  if (last < 0) return { ms: 0, clamped: false };
  if (pos <= anchorBook[0]! || pos >= anchorBook[last]!) {
    return { ms: charDist * msPerChar, clamped: true };
  }
  let lo = 0;
  let hi = last;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (anchorBook[mid]! <= pos) lo = mid;
    else hi = mid;
  }
  const b0 = anchorBook[lo]!;
  const b1 = anchorBook[hi]!;
  const m0 = anchorMs[lo]!;
  const m1 = anchorMs[hi]!;
  const f = (pos - b0) / Math.max(1, b1 - b0);
  const ms = m0 + f * (m1 - m0);

  // Two independent things can be wrong inside an unverified span, and the
  // doubt is their sum.
  //
  // The first is drift in reading rate, which grows with distance from a
  // verified point - that is the `rate` term below.
  //
  // The second is time the narrator spent NOT reading: a pause at a chapter
  // break, a silence, a musical sting. Interpolating at a constant rate
  // spreads that time evenly across the span, so a pause displaces EVERY
  // position in the span by up to its own length - including positions that
  // sit right next to an anchor. Measuring only the distance to the nearer
  // anchor missed this completely: a fifteen-second chapter break placed the
  // sentence after it fifteen seconds early while reporting a couple of
  // hundred milliseconds of doubt, and the switch landed past the reader.
  //
  // The span's unexplained time bounds that displacement: whatever the span
  // lasted, less what its characters should have taken to read.
  const drift = rate * Math.max(0, Math.min(ms - m0, m1 - ms));
  const slack = Math.max(0, m1 - m0 - (b1 - b0) * readingMsPerChar);
  return { ms: drift + slack, clamped: false };
}

/** Characters from `pos` to the closest anchor, or Infinity when there are none. */
function nearestAnchorDistance(anchorBook: number[], pos: number): number {
  if (anchorBook.length === 0) return Infinity;
  let lo = 0;
  let hi = anchorBook.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (anchorBook[mid]! < pos) lo = mid + 1;
    else hi = mid;
  }
  const after = lo < anchorBook.length ? anchorBook[lo]! - pos : Infinity;
  const before = lo > 0 ? pos - anchorBook[lo - 1]! : Infinity;
  return Math.min(after, before);
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
