import {
  segmentsFromTimings,
  type AlignerResult,
  type EbookSentenceInput,
  type RawTiming,
} from '../timings.js';
import {
  matchChars,
  type Anchor,
  type BookSentence,
  type MatchOptions,
  type MatchResult,
  type MatchStats,
  type SentenceTiming,
} from './anchors.js';
import { type AlignmentGap, type AlignmentSegment } from '@readport/shared';
import {
  decodeBook,
  openProbeDecoder,
  type DecodedBook,
  type DecodedChar,
  type EmissionOptions,
  type ProbeDecoder,
  type ProbeDecoderOptions,
  type ProbeWindow,
} from './emissions.js';
import { romanize } from './romanize.js';
import {
  assembleProbes,
  gridWindows,
  refineWindows,
  stagesOf,
  type ProbeRun,
  type SparsePlan,
} from './sparse.js';

/**
 * Forced alignment: line up an audiobook against the ebook text we already
 * have, instead of transcribing it from scratch.
 *
 * Free-form speech recognition is the wrong tool for this job. We are not
 * trying to discover the words - they are sitting in the EPUB. We only need to
 * know *when* each one is spoken. So the engine runs a CTC acoustic model over
 * the audio, greedy-decodes its emissions into a stream of romanized characters
 * with 20 ms timestamps, and then finds where that stream and the book's own
 * romanized characters agree.
 *
 * Agreement is established with character n-grams that occur exactly once on
 * each side, ordered by a longest increasing subsequence. That matters: it
 * assumes nothing about text position being proportional to audio position, so
 * front matter, credits, chapter announcements, endnotes and an index simply
 * produce no anchors instead of dragging the whole alignment off course.
 *
 * And it does not need to hear the whole book. Anchors are what the timeline is
 * built from, and a handful of seconds every couple of minutes yields plenty of
 * them; the rest is interpolation between anchors that a second pass checks and
 * repairs where the implied reading rate says something happened (see
 * sparse.ts). That is the difference between an hour of compute for a six-hour
 * audiobook and about five minutes of it.
 *
 * Measured on a real hour-long human-narrated audiobook: nearly nineteen
 * thousand candidate anchors, all but a handful of them monotone, about 94% of
 * sentences timed, and every spot check landed on the correct sentence. The alternative that was
 * tried first - synthesising the text with espeak and warping it onto the
 * narration with DTW - looked superb against a synthetic fixture and failed
 * completely against a real narrator, so it is not in the codebase.
 */

/** Why a book could not be aligned, in words the operator can act on. */
export class AlignmentRefusedError extends Error {
  readonly code = 'alignment-refused';
  constructor(
    message: string,
    readonly stats: MatchStats,
  ) {
    super(message);
    this.name = 'AlignmentRefusedError';
  }
}

export interface CtcAlignRequest {
  /** The aligner model and its vocabulary, already downloaded. */
  modelPath: string;
  vocabPath: string;
  /** Audio files in playback order, with each one's offset on the book timeline. */
  trackPaths: string[];
  trackStartMs: number[];
  /** Each track's length as the library scan measured it, to save an ffprobe. */
  trackDurationMs?: (number | undefined)[];
  /** BCP-47 code; selects the romanization conventions, not a model. */
  language: string;
  /** Sentences in reading order, as the rest of the pipeline knows them. */
  sentences: EbookSentenceInput[];
  /** The text of each sentence, parallel to `sentences`. */
  sentenceText: string[];
  threads: number;
  signal?: AbortSignal;
  /** 0..1 over the decode, which is essentially all of the wall clock. */
  onProgress?: (fraction: number, detail: string) => void;
  /**
   * Listen to short probes on this schedule instead of the whole book. Absent
   * means decode every sample, which is slower by more than an order of
   * magnitude and, on everything measured so far, no more accurate at the
   * sentence level.
   */
  plan?: SparsePlan;
  /**
   * Hear about each longer opening of the book as it is settled, while the
   * sync works on the rest - what lets a reader read along from the start of
   * a book whose sync has only just begun. Sampled syncs only, and never
   * called with the whole book: that is the return value.
   */
  onPartial?: (partial: PartialAlignment) => void;
  /**
   * The acoustic front ends, defaulting to the real ones. The only reason they
   * are injectable is testing: everything this module actually decides -
   * refusal, refinement, gaps, how timings become segments - is downstream of
   * the decode, and a test that had to carry the 317 MB model (and onnxruntime,
   * which CI does not install) could not cover any of it.
   */
  decode?: (opts: EmissionOptions) => Promise<DecodedBook>;
  openDecoder?: (opts: ProbeDecoderOptions) => Promise<ProbeDecoder>;
}

export interface CtcAlignResult {
  result: AlignerResult;
  stats: MatchStats;
  /** Provenance for the alignments table. */
  model: string;
  audioMs: number;
  /** Audio actually put through the model, for the speed estimate. 0 = all of it. */
  decodedMs: number;
  /** Probes decoded, or 0 for a whole-book decode. */
  probes: number;
  /**
   * How much of the ebook's text the narration appears to cover: ~1 for a
   * complete reading, well under 1 for an abridgement.
   *
   * NOT the raw heard/book character ratio, which under sampling is the
   * fraction of the audio that was decoded and says nothing about the
   * narration. Dividing that fraction back out is what makes the number mean
   * the same thing at every precision.
   */
  narrationRatio: number;
}

/**
 * The opening of a book a sync has finished with, while it is still working
 * on the rest.
 *
 * A sync listens to the narration from the start forward, a stage at a time
 * (sparse.stagesOf), and everything up to the last place both the text and
 * the narration were heard to agree is as final as it will get: a later
 * stage only ever adds what comes after it. So it can be handed to a reader
 * as soon as it is reached, and the book read along with from the beginning
 * while the sync carries on through the rest.
 */
export interface PartialAlignment {
  /**
   * Segments and gaps for the settled sentences only - a prefix of the book.
   * `coverage` is of the whole book, so it grows as the sync goes on.
   */
  result: AlignerResult;
  /** Read along can follow the narration this far, in book milliseconds. */
  throughMs: number;
  /** How many sentences, from the first, are settled. */
  sentences: number;
  model: string;
  audioMs: number;
}

/**
 * A sentence is only claimed as exact when it sits close to an anchor, because
 * that is the only place the timing comes from a real acoustic match rather
 * than from interpolation between two of them.
 */
export const EXACT_SCORE = 0.9;

/**
 * ...and when the anchor is close in *time*, not just in characters.
 *
 * Character distance was a good enough proxy while the whole book was decoded
 * and anchors were everywhere. Under sampling it is not: three hundred
 * characters is twenty seconds of narration, so a sentence can be "near an
 * anchor" by the character score and still be an interpolation across a third
 * of a minute. Measured, this threshold is what separates the sentences a
 * probe actually heard from the ones inferred between two probes.
 */
export const EXACT_UNCERTAINTY_MS = 2_500;

export async function alignWithCtc(req: CtcAlignRequest): Promise<CtcAlignResult> {
  const book: BookSentence[] = req.sentences.map((s, i) => ({
    index: i,
    romanized: romanize(req.sentenceText[i] ?? '', req.language),
    // The chapter file: what lets a stretch of text the narration skipped be
    // told from text it read (anchors.findSkips).
    block: s.spineIdx,
  }));
  const bookChars = book.reduce((a, s) => a + s.romanized.length, 0);
  if (bookChars === 0) {
    // Two different things, and the person reading this needs to know which:
    // a book with no text at all has nothing to sync, whatever the language;
    // one whose text has no letters in this language's alphabet may well be
    // paired under the wrong language.
    const anyText = req.sentenceText.some((t) => /[\p{L}\p{N}]/u.test(t));
    throw new Error(
      anyText
        ? 'None of the ebook’s text can be matched in this language - check the language set for this pair.'
        : 'This ebook has no text ReadPort can read - its pages may be pictures, as in a scanned book - so there is nothing to sync the narration to.',
    );
  }

  req.onProgress?.(0, 'Listening to the narration');
  const heard = req.plan
    ? await listenSparsely(req, book, req.plan)
    : await listenThroughout(req, book);

  if (heard.match.stats.implausible) {
    const stats = heard.match.stats;
    throw new AlignmentRefusedError(
      `This audio does not appear to narrate this ebook: only ${stats.monotoneAnchors} matching ` +
        `passages were found across ${stats.bookChars.toLocaleString()} characters of text. ` +
        `Check that the two editions really are the same work.`,
      stats,
    );
  }

  // One shared layer owns monotonicity, interpolation, gaps and confidence, so
  // this engine cannot invent a segment shape of its own.
  const byIndex = new Map(heard.match.timings.map((t) => [t.index, t]));
  const result = segmentsFromTimings(req.sentences, (i) => rawTiming(byIndex.get(i)), {
    audioMs: heard.audioMs,
  });
  result.gaps = [
    ...result.gaps,
    ...textOnlyGaps(req.sentences, heard.match.timings, result.segments),
  ].sort((a, b) => a.fromMs - b.fromMs);

  const decodedFraction = heard.audioMs > 0 ? heard.decodedMs / heard.audioMs : 1;
  return {
    result,
    stats: heard.match.stats,
    model: heard.model,
    audioMs: heard.audioMs,
    decodedMs: heard.decodedMs,
    probes: heard.probes,
    narrationRatio: decodedFraction > 0 ? heard.match.stats.charRatio / decodedFraction : 0,
  };
}

/** What the shared timing layer is told about one sentence's matcher timing. */
function rawTiming(t: SentenceTiming | undefined): RawTiming | null {
  if (!t || t.gap) return null;
  return {
    startMs: t.startMs,
    endMs: t.endMs,
    score: t.score,
    exact: t.score >= EXACT_SCORE && t.uncertaintyMs <= EXACT_UNCERTAINTY_MS,
    uncertaintyMs: t.uncertaintyMs,
  };
}

/**
 * The text the narration leaves out, as `text-only` gaps: one for each run of
 * sentences the matcher found skipped, placed at the moment the narration
 * passes over it - from the end of the last timed sentence before the run to
 * the start of the first after it.
 *
 * Recorded so that what reads the alignment can tell text the audiobook does
 * not read from text nobody could place: the "only in the audiobook" notice
 * (beyond.ts) asks exactly that of every stretch of narration with no text.
 */
function textOnlyGaps(
  sentences: EbookSentenceInput[],
  timings: SentenceTiming[],
  segments: AlignmentSegment[],
): AlignmentGap[] {
  const skipped = new Set(timings.filter((t) => t.skipped).map((t) => t.index));
  if (skipped.size === 0) return [];
  const segById = new Map(segments.map((s) => [s.sentenceId, s]));
  const timedAt = (i: number) => segById.get(sentences[i]!.sentenceId);
  const gaps: AlignmentGap[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (!skipped.has(i)) continue;
    let j = i;
    while (j + 1 < sentences.length && skipped.has(j + 1)) j++;
    let before: AlignmentSegment | undefined;
    for (let a = i - 1; a >= 0 && !before; a--) before = timedAt(a);
    let after: AlignmentSegment | undefined;
    for (let b = j + 1; b < sentences.length && !after; b++) after = timedAt(b);
    const fromMs = Math.round(before ? before.endMs : 0);
    const toMs = Math.round(after ? Math.max(fromMs, after.startMs) : fromMs);
    gaps.push({ fromMs, toMs, reason: 'text-only' });
    i = j;
  }
  return gaps;
}

interface Heard {
  match: MatchResult;
  audioMs: number;
  model: string;
  decodedMs: number;
  probes: number;
}

/** Decode every sample. Slow, and kept for operators who want it that way. */
async function listenThroughout(req: CtcAlignRequest, book: BookSentence[]): Promise<Heard> {
  const decoded = await (req.decode ?? decodeBook)({
    modelPath: req.modelPath,
    vocabPath: req.vocabPath,
    trackPaths: req.trackPaths,
    trackStartMs: req.trackStartMs,
    threads: req.threads,
    signal: req.signal,
    onProgress: ({ doneMs, totalMs }) => {
      const f = totalMs > 0 ? Math.min(1, doneMs / totalMs) : 0;
      // The decode is the whole cost; matching afterwards is milliseconds.
      req.onProgress?.(f * 0.97, `Listening to the narration · ${Math.round(f * 100)}%`);
    },
  });

  req.onProgress?.(0.97, 'Matching the narration to the text');
  const heard: DecodedChar[] = decoded.chars;
  return {
    match: matchChars(book, heard, { audioMs: decoded.audioMs }),
    audioMs: decoded.audioMs,
    model: decoded.model,
    decodedMs: decoded.audioMs,
    probes: 0,
  };
}

/**
 * Probes the opening stage may spend on refinement, whatever its share.
 *
 * The opening is where a narration most often departs from its text - a
 * producer's announcement, a preface it leaves out - and it is the first
 * thing anybody reads along with. Its stage is three minutes long, which
 * would buy it a single refinement probe; it borrows a few from the stages
 * after it, which the overall budget still caps.
 */
const OPENING_REFINE_PROBES = 4;

/**
 * Decode a grid of short probes, then spend a bounded number of extra probes
 * on the stretches whose implied reading rate says the interpolation between
 * them cannot be trusted.
 *
 * Both happen a stage at a time, from the start of the book forward
 * (sparse.stagesOf): a stage's grid, then its refinement, then on to the
 * next. That is what lets a reader start reading along at once - each stage
 * settles a longer opening of the book (`onPartial`) - and it costs nothing:
 * refining is local to the stretch it refines, and the budget is the same,
 * dealt out stage by stage with whatever a stage leaves carried to the next.
 *
 * The rounds are re-matched from scratch rather than patched: matching a
 * 50,000-character book against its anchors takes milliseconds, and rebuilding
 * means a late probe can revise an anchor the earlier rounds got wrong instead
 * of being stitched onto a mistake.
 */
async function listenSparsely(
  req: CtcAlignRequest,
  book: BookSentence[],
  plan: SparsePlan,
): Promise<Heard> {
  const decoder = await (req.openDecoder ?? openProbeDecoder)({
    modelPath: req.modelPath,
    vocabPath: req.vocabPath,
    trackPaths: req.trackPaths,
    trackStartMs: req.trackStartMs,
    trackDurationMs: req.trackDurationMs,
    threads: req.threads,
    signal: req.signal,
  });
  try {
    const audioMs = decoder.audioMs;
    const grid = gridWindows(audioMs, plan);
    const budget = Math.floor(grid.length * Math.max(0, plan.refineBudget));

    // The bar counts probes, not rounds: every probe costs about the same, so
    // a bar linear in probes is linear in time.
    //
    // The refinement budget is counted from the start, before a single round
    // is scheduled. Counting only the grid put the bar at 97% with up to 60%
    // of the probes still to come, and then dragged it BACKWARDS each time a
    // round was added - which is precisely the shape that makes a thirteen
    // minute alignment announce eight. Planning for the worst case means the
    // bar can only move forward, and a book that needs little refinement
    // finishes early instead of late, which is the direction to be wrong in.
    const planned = grid.length + budget;
    let finished = 0;
    const report = () => {
      const f = planned > 0 ? Math.min(1, finished / planned) : 0;
      req.onProgress?.(
        f * 0.97,
        `Listening to the narration · ${finished.toLocaleString()} of ${planned.toLocaleString()} samples`,
      );
    };

    const runs: ProbeRun[] = [];
    const decodeRound = async (windows: ProbeWindow[]) => {
      const chunks = await decoder.decode(windows, (done) => {
        finished = runs.length + done;
        report();
      });
      windows.forEach((window, i) => runs.push({ window, chars: chunks[i] ?? [] }));
      finished = runs.length;
      report();
    };

    report();
    const stages = stagesOf(grid, audioMs);
    // Where each sentence's text ends in the book string the matcher builds,
    // to tell which sentences an anchor has settled.
    const ends: number[] = [];
    book.reduce((at, s) => {
      ends.push(at + s.romanized.length);
      return at + s.romanized.length;
    }, 0);

    let match: MatchResult | null = null;
    let spent = 0;
    let allowance = 0;
    // The end of what has been handed over: refinement looks only past it.
    let settledMs = 0;
    for (let k = 0; k < stages.length; k++) {
      const stage = stages[k]!;
      const last = k === stages.length - 1;
      // Before the last stage the book has only been heard in part, and the
      // refusal threshold - anchors for the WHOLE book's length - would
      // refuse every opening. The last stage is matched as a whole-book
      // listen always was, refusal and all.
      const opts: MatchOptions = last ? { audioMs } : { audioMs, minAnchorsPerKiloChar: 0 };
      await decodeRound(stage.windows);
      match = matchChars(book, assembleProbes(runs), opts);

      allowance += Math.floor(stage.windows.length * Math.max(0, plan.refineBudget));
      if (k === 0) allowance = Math.max(allowance, OPENING_REFINE_PROBES);
      const horizon = { fromMs: settledMs, toMs: last ? audioMs : stage.endMs, last };
      for (let round = 0; round < plan.refineRounds; round++) {
        const limit = Math.min(budget, allowance) - spent;
        if (limit <= 0) break;
        const covered = runs.map((r) => r.window);
        const extra = refineWindows(match.anchors, covered, audioMs, plan, limit, horizon);
        if (extra.length === 0) break;
        await decodeRound(extra);
        spent += extra.length;
        match = matchChars(book, assembleProbes(runs), opts);
      }

      if (!last) {
        const partial = settle(req, ends, match, decoder.model, audioMs);
        if (partial && partial.throughMs > settledMs) {
          settledMs = partial.throughMs;
          req.onPartial?.(partial);
        }
      }
    }
    if (!match) match = matchChars(book, assembleProbes(runs), { audioMs });

    // Refinement is done, whether or not it used its whole budget. Closing the
    // gap here is the one forward jump the bar is allowed.
    finished = planned;
    report();
    req.onProgress?.(0.97, 'Matching the narration to the text');
    return {
      match,
      audioMs,
      model: decoder.model,
      // What the decoder actually heard, not what it was asked for: probes
      // are clipped at track ends and skipped when a sliver remains, and
      // counting the request would understate how much of the book went
      // unheard - which is the number the abridgement check divides by.
      decodedMs: decoder.decodedMs,
      probes: runs.length,
    };
  } finally {
    await decoder.close();
  }
}

/** Anchors a sync must have before any of the book is handed to a reader. */
const PARTIAL_MIN_ANCHORS = 20;
/**
 * Anchors per thousand characters of the settled text below which it is not
 * handed over: the refusal threshold (anchors.ts), applied to what has been
 * heard rather than to the whole book, so audio of a different book never
 * reaches a reader as a half-finished sync.
 */
const PARTIAL_MIN_DENSITY = 2;
/**
 * A step through the text this many times faster than the narrator reads,
 * over at least JUMP_MIN_CHARS...
 */
const JUMP_FACTOR = 4;
const JUMP_MIN_CHARS = 1_000;
/** ...is only taken as read once this many anchors after it agree. */
const JUMP_CONFIRM_ANCHORS = 10;

/**
 * The last anchor that can be trusted as the edge of what is settled.
 *
 * Normally simply the last one. But the last anchor of a sync still under
 * way can be a jump: either a real one - the narration leaving out a preface
 * just before the stage ended - or a stray, a few characters heard wrong that
 * happen to match text far ahead. A stray at the end of the book does no harm;
 * at the end of a stage it would hand over hours of text interpolated across
 * audio nobody has listened to. The two look alike until more is heard, and
 * a real jump is followed by the narration reading on from where it landed:
 * so a jump marks the edge until enough anchors after it confirm it.
 */
export function settledEdge(anchors: Anchor[]): Anchor | null {
  if (anchors.length === 0) return null;
  const paces: number[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const chars = anchors[i]!.bookPos - anchors[i - 1]!.bookPos;
    const ms = anchors[i]!.ms - anchors[i - 1]!.ms;
    if (chars > 0 && ms > 0) paces.push(ms / chars);
  }
  const lastAnchor = anchors[anchors.length - 1]!;
  if (paces.length === 0) return lastAnchor;
  paces.sort((a, b) => a - b);
  const msPerChar = paces[paces.length >> 1]!;
  for (let i = anchors.length - 1; i >= 1; i--) {
    const a = anchors[i - 1]!;
    const b = anchors[i]!;
    const chars = b.bookPos - a.bookPos;
    const jump = chars >= JUMP_MIN_CHARS && (b.ms - a.ms) * JUMP_FACTOR < chars * msPerChar;
    if (!jump) continue;
    return anchors.length - i >= JUMP_CONFIRM_ANCHORS ? lastAnchor : a;
  }
  return lastAnchor;
}

/**
 * The opening of the book a stage has settled, as a reader can use it: every
 * sentence that ends before the settled edge (settledEdge), timed by the
 * same layer the finished alignment is, or null when too little is known.
 */
function settle(
  req: CtcAlignRequest,
  ends: number[],
  match: MatchResult,
  model: string,
  audioMs: number,
): PartialAlignment | null {
  if (match.anchors.length < PARTIAL_MIN_ANCHORS) return null;
  const edge = settledEdge(match.anchors);
  if (!edge || edge.bookPos <= 0) return null;
  if ((match.anchors.length * 1000) / edge.bookPos < PARTIAL_MIN_DENSITY) return null;
  // Sentences wholly before the edge: the first whose text runs past it is
  // not settled, and neither is anything after it.
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid]! <= edge.bookPos) lo = mid + 1;
    else hi = mid;
  }
  const n = lo;
  if (n === 0) return null;
  const settled = req.sentences.slice(0, n);
  const byIndex = new Map(match.timings.map((t) => [t.index, t]));
  const result = segmentsFromTimings(settled, (i) => rawTiming(byIndex.get(i)));
  result.gaps = [
    ...result.gaps,
    ...textOnlyGaps(
      settled,
      match.timings.filter((t) => t.index < n),
      result.segments,
    ),
  ].sort((a, b) => a.fromMs - b.fromMs);
  const lastSegment = result.segments[result.segments.length - 1];
  if (!lastSegment) return null;
  // Of the whole book, so that it grows as the sync goes on.
  result.coverage =
    req.sentences.length > 0
      ? Math.round((result.segments.length / req.sentences.length) * 1000) / 1000
      : 0;
  return { result, throughMs: lastSegment.endMs, sentences: n, model, audioMs };
}
