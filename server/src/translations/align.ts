/**
 * Matching two translations of one book paragraph to paragraph.
 *
 * The method is Gale and Church's (1993), which is still what aligns
 * parallel texts when nothing is known about the two languages but their
 * lengths: a paragraph and its translation are long in proportion to each
 * other, the proportion is steady across a book, and a translator keeps the
 * author's paragraphs far more often than not. So the two books' paragraphs
 * are walked together by dynamic programming, and every step either matches
 * one paragraph to one, merges two or three on one side into one on the
 * other, or lets a paragraph stand alone (a translator's note, a dedication
 * one edition has and the other does not). A step costs how unlikely that
 * kind of step is, plus how unlikely the two lengths are for a translation.
 *
 * Two things a book has that Gale and Church's parliament proceedings did
 * not are used as well: chapters, which translations nearly always start in
 * the same places, and numbers written as digits, which they keep.
 *
 * Nothing here reads a word of either language. That is the point: it works
 * the same for any two languages ReadPort can index, needs no dictionary and
 * no model, and runs in a second on a long novel. What it cannot do is match
 * an abridged translation closely - the lengths stop agreeing - and it says
 * so in its statistics rather than pretending.
 */

export interface Paragraph {
  spineIdx: number;
  /** Chapter-local range of its text, without the surrounding whitespace. */
  start: number;
  end: number;
  /** Where it starts in the whole book: its chapter's cumChars plus `start`. */
  global: number;
  /** Characters of text, whitespace aside. What is compared. */
  len: number;
  /** The first paragraph of its chapter. */
  head: boolean;
  /** The runs of digits in it, sorted and joined: a chapter number, a year. */
  digits: string;
}

/**
 * A book's paragraphs, from its chapters' extracted text - where the
 * extractor writes a line break at every block boundary, so a paragraph is
 * a line (see epub/sanitize.ts `extractText`). Offsets are the same ones
 * the reader and the sentence index use.
 */
export function paragraphsOf(
  chapters: readonly { idx: number; cumChars: number }[],
  textOf: (spineIdx: number) => string | null,
): Paragraph[] {
  const out: Paragraph[] = [];
  for (const ch of chapters) {
    const text = textOf(ch.idx);
    if (!text) continue;
    let head = true;
    let s = 0;
    while (s < text.length) {
      let e = text.indexOf('\n', s);
      if (e < 0) e = text.length;
      const line = text.slice(s, e);
      const content = line.trim();
      if (content) {
        const start = s + (line.length - line.trimStart().length);
        out.push({
          spineIdx: ch.idx,
          start,
          end: start + content.length,
          global: ch.cumChars + start,
          len: content.replace(/\s+/gu, '').length,
          head,
          digits: [...new Set(content.match(/\d+/g) ?? [])].sort().join(','),
        });
        head = false;
      }
      s = e + 1;
    }
  }
  return out;
}

/**
 * The kinds of step, as paragraphs taken from each side, and how often each
 * happens between a book and its translation. Gale and Church's figures,
 * with room made for the three-into-one of dialogue that one edition sets
 * as separate lines and the other runs together.
 */
const MOVES: readonly (readonly [number, number, number])[] = [
  [1, 1, 0.89],
  [1, 0, 0.0049],
  [0, 1, 0.0049],
  [2, 1, 0.0445],
  [1, 2, 0.0445],
  [2, 2, 0.0099],
  [3, 1, 0.001],
  [1, 3, 0.001],
];
const PRIOR_COST = MOVES.map(([, , p]) => -Math.log(p));

/**
 * Variance of a translation's length, per character. Gale and Church
 * measured 6.8 on parliamentary proceedings; literary translation is freer,
 * and a stricter figure makes the aligner prefer merging paragraphs over
 * admitting that one of them came out long.
 */
const VARIANCE_PER_CHAR = 10;

/** Two chapters starting together is what translations do: a step that does it costs less. */
const HEAD_BONUS = 3;
/** The same numbers in both paragraphs: a chapter's number, a date. */
const DIGITS_BONUS = 2;
/** Different numbers on both sides: probably not the same paragraph. */
const DIGITS_PENALTY = 1.5;

/** A step whose lengths are this far apart (in standard deviations) is not counted as matched. */
const MATCHED_Z = 2.5;
/** At least this share of the text matched step by step, for the two to count as closely matched. */
export const CLOSE_SHARE = 0.7;

/** -log(erfc(x)), computed in log space so a long paragraph's tail never underflows (Numerical Recipes' erfcc). */
function negLogErfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const poly =
    -1.26551223 +
    t *
      (1.00002368 +
        t *
          (0.37409196 +
            t *
              (0.09678418 +
                t *
                  (-0.18628806 +
                    t *
                      (0.27886807 +
                        t *
                          (-1.13520398 +
                            t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  return -Math.log(t) + z * z - poly;
}

/** How many standard deviations apart two lengths are, for a translation that runs `c` times as long. */
function lengthZ(la: number, lb: number, c: number): number {
  const mean = Math.max(1, (la + lb / c) / 2);
  return (lb - la * c) / Math.sqrt(VARIANCE_PER_CHAR * c * mean);
}

export interface AlignStats {
  paragraphsA: number;
  paragraphsB: number;
  /** Characters of B per character of A, across the whole of both. */
  ratio: number;
  steps: number;
  /** Steps that matched one paragraph to one. */
  oneToOne: number;
  /** The share of both texts matched one to one (or one to two) by steps whose lengths agree. */
  matchedShare: number;
}

export interface AlignResult {
  /** Paragraph index ranges, one step each: [i0, i1, j0, j1). */
  steps: [number, number, number, number][];
  stats: AlignStats;
  match: 'close' | 'rough';
}

export interface AlignOptions {
  /**
   * How far from the diagonal the path may wander, as a share of the book:
   * front matter one edition has and the other does not moves it off. A
   * wider band costs time; the aligner tries once more with a wide one when
   * the narrow one cannot reach the end.
   */
  band?: number;
  /** Called every few hundred rows, so a long book does not hold the thread (a job's heartbeat). */
  pause?: () => Promise<void>;
}

function prefix(ps: readonly Paragraph[]): Float64Array {
  const out = new Float64Array(ps.length + 1);
  for (let i = 0; i < ps.length; i++) out[i + 1] = out[i]! + ps[i]!.len;
  return out;
}

/** The digits of paragraphs [from, to), as one set's key. */
function digitsOf(ps: readonly Paragraph[], from: number, to: number): string {
  if (to - from === 1) return ps[from]!.digits;
  const all = new Set<string>();
  for (let k = from; k < to; k++) for (const d of ps[k]!.digits.split(',')) if (d) all.add(d);
  return [...all].sort().join(',');
}

/**
 * Align two books' paragraphs. Null when either has no text, or when no
 * path through the band reaches the end (which the retry with a wider band
 * makes very unlikely for two editions of one book).
 */
export async function alignParagraphs(
  A: readonly Paragraph[],
  B: readonly Paragraph[],
  opts: AlignOptions = {},
): Promise<AlignResult | null> {
  if (A.length === 0 || B.length === 0) return null;
  const first = await alignWithin(A, B, opts.band ?? defaultBand(A.length), opts.pause);
  return first ?? (await alignWithin(A, B, 0.3, opts.pause));
}

function defaultBand(n: number): number {
  // Short books get a relatively wider corridor: a two-page preface is a
  // tenth of a novella and a hundredth of a saga.
  return Math.min(0.15, Math.max(0.06, 150 / n));
}

async function alignWithin(
  A: readonly Paragraph[],
  B: readonly Paragraph[],
  band: number,
  pause?: () => Promise<void>,
): Promise<AlignResult | null> {
  const n = A.length;
  const m = B.length;
  const PA = prefix(A);
  const PB = prefix(B);
  const totalA = PA[n]!;
  const totalB = PB[m]!;
  if (totalA <= 0 || totalB <= 0) return null;
  const c = totalB / totalA;
  const minWidth = 25;

  // Row i's corridor: columns whose share of B is within `band` of row i's
  // share of A, widened to at least `minWidth` paragraphs either side of the
  // straight line - so a short book, or a stretch of tiny paragraphs, still
  // has room to merge and split.
  const lo = new Int32Array(n + 1);
  const hi = new Int32Array(n + 1);
  let jl = 0;
  let jh = 0;
  for (let i = 0; i <= n; i++) {
    const f = PA[i]! / totalA;
    while (jl < m && PB[jl]! / totalB < f - band) jl++;
    while (jh < m && PB[jh + 1]! / totalB <= f + band) jh++;
    const diag = Math.round((i * m) / n);
    lo[i] = Math.max(0, Math.min(jl, diag - minWidth));
    hi[i] = Math.min(m, Math.max(jh, diag + minWidth));
  }
  lo[0] = 0;
  hi[n] = m;

  const back: Uint8Array[] = new Array(n + 1);
  // Cost rows for the last four rows: no step reaches further back than three.
  const rows: Float64Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const width = hi[i]! - lo[i]! + 1;
    const cost = new Float64Array(width).fill(Infinity);
    const bp = new Uint8Array(width).fill(255);
    if (i === 0) cost[0] = 0;
    // Stored before it is filled: a step taking nothing from A reads its own row.
    rows[i] = cost;
    back[i] = bp;
    for (let j = lo[i]!; j <= hi[i]!; j++) {
      if (i === 0 && j === 0) continue;
      let best = Infinity;
      let bestMove = 255;
      for (let k = 0; k < MOVES.length; k++) {
        const di = MOVES[k]![0];
        const dj = MOVES[k]![1];
        const pi = i - di;
        const pj = j - dj;
        if (pi < 0 || pj < 0) continue;
        if (pj < lo[pi]! || pj > hi[pi]!) continue;
        const prev = rows[pi]![pj - lo[pi]!]!;
        if (prev === Infinity) continue;
        const la = PA[i]! - PA[pi]!;
        const lb = PB[j]! - PB[pj]!;
        let step = PRIOR_COST[k]! + negLogErfc(lengthZ(la, lb, c) / Math.SQRT2);
        if (di > 0 && dj > 0) {
          if (A[pi]!.head && B[pj]!.head) step -= HEAD_BONUS;
          const da = digitsOf(A, pi, i);
          const db = digitsOf(B, pj, j);
          if (da && db) step += da === db ? -DIGITS_BONUS : DIGITS_PENALTY;
        }
        const total = prev + step;
        if (total < best) {
          best = total;
          bestMove = k;
        }
      }
      cost[j - lo[i]!] = best;
      bp[j - lo[i]!] = bestMove;
    }
    // Only the last three rows are ever looked back at.
    if (i >= 4) rows[i - 4] = EMPTY;
    if (pause && i % 256 === 255) await pause();
  }

  if (rows[n]![m - lo[n]!] === Infinity) return null;

  const steps: [number, number, number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const k = back[i]![j - lo[i]!]!;
    if (k === 255) return null;
    const pi = i - MOVES[k]![0];
    const pj = j - MOVES[k]![1];
    steps.push([pi, i, pj, j]);
    i = pi;
    j = pj;
  }
  steps.reverse();

  let oneToOne = 0;
  let matched = 0;
  for (const [i0, i1, j0, j1] of steps) {
    if (i1 - i0 === 1 && j1 - j0 === 1) oneToOne++;
    // One to one, or a paragraph split in two: what a close translation does.
    // Bigger merges agree on length too easily to count - an abridgement
    // that halves every other paragraph lines up perfectly two by two.
    if (i1 > i0 && j1 > j0 && i1 - i0 + (j1 - j0) <= 3) {
      const la = PA[i1]! - PA[i0]!;
      const lb = PB[j1]! - PB[j0]!;
      if (Math.abs(lengthZ(la, lb, c)) < MATCHED_Z) matched += la + lb / c;
    }
  }
  const matchedShare = matched / (totalA + totalB / c);
  return {
    steps,
    stats: {
      paragraphsA: n,
      paragraphsB: m,
      ratio: Math.round(c * 1000) / 1000,
      steps: steps.length,
      oneToOne,
      matchedShare: Math.round(matchedShare * 1000) / 1000,
    },
    match: matchedShare >= CLOSE_SHARE ? 'close' : 'rough',
  };
}

const EMPTY = new Float64Array(0);

/**
 * The steps as character ranges of each whole book, four numbers a step:
 * [aStart, aEnd, bStart, bEnd, ...]. A side a step takes nothing from is an
 * empty range where that paragraph would have been, so every range is in
 * order and a place between two paragraphs still has somewhere to go.
 */
export function stepsToSpans(
  steps: readonly (readonly [number, number, number, number])[],
  A: readonly Paragraph[],
  B: readonly Paragraph[],
): number[] {
  const endOf = (p: Paragraph) => p.global + (p.end - p.start);
  const out: number[] = [];
  let lastA = A.length ? A[0]!.global : 0;
  let lastB = B.length ? B[0]!.global : 0;
  for (const [i0, i1, j0, j1] of steps) {
    const a0 = i1 > i0 ? A[i0]!.global : lastA;
    const a1 = i1 > i0 ? endOf(A[i1 - 1]!) : lastA;
    const b0 = j1 > j0 ? B[j0]!.global : lastB;
    const b1 = j1 > j0 ? endOf(B[j1 - 1]!) : lastB;
    out.push(a0, a1, b0, b1);
    lastA = a1;
    lastB = b1;
  }
  return out;
}

export type Side = 'a' | 'b';

/** Where a place in one book falls in the other: at the same point in the matching passage, or at its start. */
export interface Carried {
  /** The place in the other book, as a character offset into the whole of it. */
  at: number;
  /** The matching passage in the other book, and the one it matched in this. */
  from: [number, number];
  to: [number, number];
  /** False when the place fell in something the other book does not have. */
  matched: boolean;
}

/**
 * Carry a character offset of one book (`side`) across the spans to the
 * other. `start` lands at the beginning of the matching passage - where to
 * carry on reading from; `point` lands proportionally inside it - where a
 * friend's marker goes.
 */
export function carry(
  spans: readonly number[],
  side: Side,
  x: number,
  mode: 'start' | 'point',
): Carried | null {
  const count = spans.length / 4;
  if (count === 0) return null;
  const s = side === 'a' ? 0 : 2; // this side's start in a step
  const o = side === 'a' ? 2 : 0; // the other side's
  // The last step starting at or before x.
  let lo = 0;
  let hi = count - 1;
  if (x < spans[s]!) hi = -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[mid * 4 + s]! <= x) lo = mid;
    else hi = mid - 1;
  }
  const k = Math.max(0, hi);
  const f0 = spans[k * 4 + s]!;
  const f1 = spans[k * 4 + s + 1]!;
  const t0 = spans[k * 4 + o]!;
  const t1 = spans[k * 4 + o + 1]!;
  if (x < f0 || x >= f1) {
    // Before the first paragraph, or in the space between two: the next
    // passage is where this place leads.
    const next = x < f0 ? k : k + 1;
    if (next >= count) return { at: t1, from: [f0, f1], to: [t0, t1], matched: false };
    const n0 = spans[next * 4 + o]!;
    return {
      at: n0,
      from: [spans[next * 4 + s]!, spans[next * 4 + s + 1]!],
      to: [n0, spans[next * 4 + o + 1]!],
      matched: false,
    };
  }
  if (t1 <= t0) return { at: t0, from: [f0, f1], to: [t0, t1], matched: false };
  const at = mode === 'start' ? t0 : Math.round(t0 + ((x - f0) / (f1 - f0)) * (t1 - t0));
  return { at: Math.min(at, t1 - 1), from: [f0, f1], to: [t0, t1], matched: true };
}
