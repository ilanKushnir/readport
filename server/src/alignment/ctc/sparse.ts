import { PROBE_BREAK, type DecodedChar, type ProbeWindow } from './emissions.js';
import { type Anchor } from './anchors.js';

/**
 * Where to listen.
 *
 * Forced alignment does not need to hear a book to time it. It needs enough
 * places where the decoded audio and the text provably agree that everything
 * in between can be interpolated, and narration is close to a constant rate
 * over a couple of minutes - so a short probe every so often buys almost the
 * same timeline as decoding every sample, for a fifteenth of the compute.
 *
 * "Almost" is the whole problem, and it is what the refinement pass is for.
 * Interpolation assumes the narrator kept reading at the same pace between two
 * anchors, and the places where that is false are exactly the places a reader
 * notices: a chapter break, a pause for a section heading, a passage of the
 * ebook the narration skips, a producer's credit. Each of those shows up as a
 * stretch whose implied reading rate is wrong - too few book characters per
 * second across a silence, too many across a skip - so the schedule spends its
 * second round of probes on precisely those stretches and leaves the steady
 * parts alone.
 *
 * Pure: planning is separated from decoding so the schedule can be tested
 * without the model.
 */

export interface SparsePlan {
  /** Audio decoded per probe. */
  windowMs: number;
  /** Distance between probe starts in the first pass. */
  everyMs: number;
  /** Refinement passes over the suspicious stretches. */
  refineRounds: number;
  /**
   * Relative deviation from the book's median reading rate that marks a
   * stretch as worth another probe. 0.2 means "20% faster or slower".
   */
  rateTolerance: number;
  /** Extra probes allowed, as a fraction of the first pass. */
  refineBudget: number;
}

/**
 * Defaults, measured on real narration rather than chosen: see
 * docs/alignment.md. A 6-hour audiobook plans ~360 probes of 8 seconds,
 * about 13% of the audio, plus refinement.
 *
 * A probe every minute rather than every two and a half: measured against
 * what the narration actually says at points no probe listened to, on three
 * hours of a Russian audiobook, the median error fell from 1.2 s to 0.6 s,
 * the share within two seconds rose from 72% to 83% and the worst from
 * 11.5 s to 5.8 s - for two and a half times the listening. Interpolation
 * between two probes is the whole of the error, and it grows with the
 * distance between them.
 */
export const DEFAULT_SPARSE_PLAN: SparsePlan = {
  windowMs: 8_000,
  everyMs: 60_000,
  // Enough rounds to halve a skipped passage's stretch from a grid interval
  // down to a couple of probes wide, one probe per round.
  refineRounds: 6,
  rateTolerance: 0.2,
  refineBudget: 0.6,
};

/**
 * The settings-level choice, expressed as a schedule. `exact` has no
 * schedule: it decodes every sample.
 */
/** Schedule for a settings value, or null when every sample is decoded. */
export function planFor(precision: 'standard' | 'exact'): SparsePlan | null {
  return precision === 'exact' ? null : DEFAULT_SPARSE_PLAN;
}

/** The first pass: one probe every `everyMs`, from the top of the book. */
export function gridWindows(audioMs: number, plan: SparsePlan): ProbeWindow[] {
  const every = Math.max(1000, Math.round(plan.everyMs));
  const win = Math.max(1000, Math.round(plan.windowMs));
  const out: ProbeWindow[] = [];
  for (let startMs = 0; startMs < audioMs; startMs += every) {
    out.push({ startMs, durationMs: Math.min(win, audioMs - startMs) });
  }
  return out;
}

/**
 * Where each stage of a sync ends, on the narration's clock.
 *
 * A sync works forward through the book a stage at a time, and the reader
 * can follow along as far as the stages have got. The first is short so read
 * along is there from the beginning about half a minute after the sync
 * starts; the ones after it grow, because by then the sync is far ahead of
 * anyone listening (it runs about twenty times faster than the narration)
 * and a longer stage costs fewer re-matches.
 */
export const STAGE_ENDS_MS = [180_000, 600_000, 1_500_000, 3_300_000];
/** Past the opening stages, one stage per hour of narration. */
export const STAGE_STEP_MS = 3_600_000;

/** One stage of a sync: the grid probes it listens to, and where it ends. */
export interface Stage {
  windows: ProbeWindow[];
  /** The end of the stretch this stage owns: the next stage's start, or the end of the audio. */
  endMs: number;
}

/** The grid, cut into stages (STAGE_ENDS_MS), in the order they are listened to. */
export function stagesOf(grid: ProbeWindow[], audioMs: number): Stage[] {
  const stages: Stage[] = [];
  let k = 0;
  let endMs = 0;
  const nextEnd = () => (k < STAGE_ENDS_MS.length ? STAGE_ENDS_MS[k++]! : endMs + STAGE_STEP_MS);
  let current: ProbeWindow[] = [];
  endMs = nextEnd();
  for (const w of grid) {
    while (w.startMs >= endMs) {
      if (current.length) stages.push({ windows: current, endMs });
      current = [];
      endMs = nextEnd();
    }
    current.push(w);
  }
  if (current.length) stages.push({ windows: current, endMs });
  // The last stage owns the rest of the audio, whatever its nominal end.
  if (stages.length) stages[stages.length - 1]!.endMs = Math.max(audioMs, 0);
  return stages;
}

/**
 * The part of the narration a refinement round may spend probes on.
 *
 * A sync that works forward a stage at a time refines each stage as it gets
 * there, and only that stage: a stretch before `fromMs` has been settled and
 * handed to the reader already, and one past `toMs` belongs to a stage that
 * has not been listened to. Only the last stage looks past the last anchor
 * to the end of the audio - an earlier one ends where the next one's grid
 * takes over, and probing that gap would spend a probe on what the next
 * stage hears anyway.
 */
export interface RefineHorizon {
  fromMs: number;
  toMs: number;
  /** This is the last stage: an unanchored tail up to `toMs` is fair game. */
  last: boolean;
}

/**
 * A stretch of narration between two consecutive anchors, long enough that
 * nothing was decoded inside it.
 */
interface Span {
  fromMs: number;
  toMs: number;
  /** Book characters per millisecond implied by the two anchors. */
  rate: number;
  /** Book characters between the two anchors. */
  chars: number;
}

/**
 * Pick the next round of probes: the stretches where the implied reading rate
 * says the interpolation is lying, plus any stretch that produced no anchors
 * at all (a probe that landed in music, in silence, or in text the ebook does
 * not contain).
 *
 * Returns an empty array when the timeline looks uniform, which ends the
 * refinement early - most books get there after one round.
 */
export function refineWindows(
  anchors: Anchor[],
  covered: ProbeWindow[],
  audioMs: number,
  plan: SparsePlan,
  limit: number,
  horizon: RefineHorizon = { fromMs: 0, toMs: audioMs, last: true },
): ProbeWindow[] {
  if (limit <= 0) return [];
  const win = Math.max(1000, Math.round(plan.windowMs));
  // Only stretches wider than a probe can hide anything; anything narrower is
  // already as well anchored as this schedule can make it.
  const minSpanMs = Math.max(2 * win, Math.round(plan.everyMs / 3));

  // Stretches that skipped text may be narrower: a preface skipped between
  // two probes is only pinned down once a probe has landed close to where the
  // reading resumes, and halving a grid interval gets there in a few rounds.
  const minSkipSpanMs = 2 * win;
  const spans: Span[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1]!;
    const b = anchors[i]!;
    const dt = b.ms - a.ms;
    if (dt < minSkipSpanMs) continue;
    const chars = b.bookPos - a.bookPos;
    spans.push({ fromMs: a.ms, toMs: b.ms, rate: chars / Math.max(1, dt), chars });
  }
  // Unanchored head and tail: no rate to judge, but every bit as unmapped.
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const blind: Span[] = [];
  if (first && first.ms >= minSpanMs)
    blind.push({ fromMs: 0, toMs: first.ms, rate: NaN, chars: 0 });
  const tailTo = Math.min(audioMs, horizon.toMs);
  if (last && horizon.last && tailTo - last.ms >= minSpanMs) {
    blind.push({ fromMs: last.ms, toMs: tailTo, rate: NaN, chars: 0 });
  }
  /** Whether a stretch is this round's to refine (RefineHorizon). */
  const inHorizon = (s: Span) => s.toMs > horizon.fromMs && s.fromMs < horizon.toMs;

  const rates = spans
    .map((s) => s.rate)
    .filter((r) => r > 0)
    .sort((x, y) => x - y);
  const median = rates.length ? rates[rates.length >> 1]! : 0;
  const tol = Math.log(1 + Math.max(0.01, plan.rateTolerance));

  /**
   * Time a span cannot account for at the median reading rate.
   *
   * A pause adds seconds without adding characters, so it shows up here and
   * nowhere else. As a RATIO it barely registers - a fifteen-second break
   * inside a hundred-and-fifty-second span is a ten-per-cent wobble, under
   * any tolerance worth setting - which is why spans containing chapter
   * breaks used to sail through refinement untouched while carrying the
   * largest errors in the book. It is also precisely the quantity the timing
   * layer turns into uncertainty, so probing the worst of these is what
   * shrinks the rewind a reader feels when they switch.
   *
   * A blind span has no rate to judge, and none of it is mapped, so all of it
   * is unaccounted for.
   */
  const slackMs = (s: Span): number => {
    const width = s.toMs - s.fromMs;
    if (!(s.rate > 0) || median <= 0) return width;
    return Math.max(0, width * (1 - s.rate / median));
  };
  /**
   * Text a span cannot account for: how much longer its characters take to
   * read at the median rate than the span lasted.
   *
   * The mirror of the slack above, and the signature of a SKIP - a preface,
   * a chapter's summary the narrator leaves out. Slack alone ranked these
   * last (a skip adds characters, not seconds), so the budget went on pauses
   * while a skipped preface was interpolated across a minute of narration
   * and the highlight swept through it with the voice a chapter away.
   */
  const excessMs = (s: Span): number =>
    s.rate > 0 && median > 0 ? Math.max(0, s.chars / median - (s.toMs - s.fromMs)) : 0;
  /** What a span leaves unexplained, either way round. */
  const needMs = (s: Span): number => Math.max(slackMs(s), excessMs(s));
  // Comfortably above ordinary variation in reading rate, and well below a
  // chapter break - the point is to catch silences, not to chase noise.
  const SUSPECT_SLACK_MS = 4_000;

  // The median above is the whole book's so far; only what is judged is
  // limited to the horizon.
  const suspect = spans.filter((s) => {
    if (!inHorizon(s)) return false;
    const width = s.toMs - s.fromMs;
    // A skip is worth chasing into a narrow span; anything else only in a
    // span wider than the schedule's own resolution.
    if (width < minSpanMs && excessMs(s) < SUSPECT_SLACK_MS) return false;
    return (
      !(s.rate > 0) ||
      median <= 0 ||
      Math.abs(Math.log(s.rate / median)) > tol ||
      needMs(s) >= SUSPECT_SLACK_MS
    );
  });
  // Worst first, measured by what is unaccounted for rather than by width:
  // five minutes nobody has listened to, or a preface's worth of text read in
  // no time at all, matters more than a fifteen-second pause, and all of them
  // matter more than a long stretch that simply reads a little fast.
  const ranked = [...blind.filter(inHorizon), ...suspect].sort(
    (a, b) => needMs(b) - needMs(a) || b.toMs - b.fromMs - (a.toMs - a.fromMs),
  );

  const out: ProbeWindow[] = [];
  for (const span of ranked) {
    if (out.length >= limit) break;
    const startMs = placeIn(span, [...covered, ...out], win, audioMs);
    if (startMs === null) continue;
    out.push({ startMs, durationMs: Math.min(win, audioMs - startMs) });
  }
  return out;
}

/**
 * Where to put a probe inside a suspicious stretch: the middle of the widest
 * part of it nothing has listened to yet.
 *
 * Aiming at the exact midpoint is not good enough. The commonest reason a
 * stretch is suspicious in the first place is that a grid probe inside it
 * heard nothing - it landed in a pause, in music, in a chapter announcement -
 * and that probe sits at or near the middle. Re-probing the same seconds would
 * spend the budget learning the same nothing.
 */
function placeIn(span: Span, taken: ProbeWindow[], win: number, audioMs: number): number | null {
  const busy = taken
    .filter((w) => w.startMs < span.toMs && w.startMs + w.durationMs > span.fromMs)
    .sort((a, b) => a.startMs - b.startMs);
  let best: { from: number; to: number } | null = null;
  let cursor = span.fromMs;
  for (const w of [...busy, { startMs: span.toMs, durationMs: 0 }]) {
    const free = { from: cursor, to: Math.min(w.startMs, span.toMs) };
    if (free.to - free.from > (best ? best.to - best.from : 0)) best = free;
    cursor = Math.max(cursor, w.startMs + w.durationMs);
  }
  if (!best || best.to - best.from < win) return null;
  const mid = Math.round((best.from + best.to) / 2 - win / 2);
  return Math.max(0, Math.min(mid, audioMs - win));
}

/** One probe and what the model heard in it. */
export interface ProbeRun {
  window: ProbeWindow;
  chars: DecodedChar[];
}

/**
 * Splice every probe decoded so far into one character stream in playback
 * order, with a {@link PROBE_BREAK} between neighbours.
 *
 * The breaks are what make sparse decoding safe rather than merely cheap.
 * Without them the last syllable of one probe and the first of the next -
 * minutes apart in the narration - would form n-grams that the matcher could
 * anchor somewhere neither probe ever visited.
 */
export function assembleProbes(runs: ProbeRun[]): DecodedChar[] {
  const ordered = [...runs].sort((a, b) => a.window.startMs - b.window.startMs);
  const out: DecodedChar[] = [];
  for (const run of ordered) {
    if (run.chars.length === 0) continue;
    if (out.length > 0) out.push({ c: PROBE_BREAK, ms: Math.round(run.window.startMs) });
    for (const c of run.chars) out.push(c);
  }
  return out;
}
