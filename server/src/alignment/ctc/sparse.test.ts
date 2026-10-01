import { describe, expect, it } from 'vitest';
import { matchChars, type Anchor, type BookSentence } from './anchors.js';
import { PROBE_BREAK, type DecodedChar, type ProbeWindow } from './emissions.js';
import {
  DEFAULT_SPARSE_PLAN,
  STAGE_ENDS_MS,
  STAGE_STEP_MS,
  assembleProbes,
  gridWindows,
  planFor,
  refineWindows,
  stagesOf,
  type ProbeRun,
  type SparsePlan,
} from './sparse.js';

/**
 * The probe schedule, tested without the model.
 *
 * Everything here is arithmetic over anchors and windows, and it decides how
 * much of a book gets listened to - so it is worth pinning down precisely,
 * particularly the refinement rule, whose whole job is to notice the places
 * where interpolating between two anchors would be a lie.
 */

const PLAN: SparsePlan = { ...DEFAULT_SPARSE_PLAN, windowMs: 8_000, everyMs: 100_000 };

function anchorsAtRate(count: number, rate: number, fromMs = 0, everyMs = 100_000): Anchor[] {
  return Array.from({ length: count }, (_, i) => ({
    ms: fromMs + i * everyMs,
    bookPos: Math.round(i * everyMs * rate),
  }));
}

describe('gridWindows', () => {
  it('covers the book at the planned spacing', () => {
    const win = gridWindows(500_000, PLAN);
    expect(win.map((w) => w.startMs)).toEqual([0, 100_000, 200_000, 300_000, 400_000]);
    expect(win.every((w) => w.durationMs === 8_000)).toBe(true);
  });

  it('clips the last probe to the end of the audio instead of running past it', () => {
    const win = gridWindows(203_000, PLAN);
    expect(win.at(-1)).toEqual({ startMs: 200_000, durationMs: 3_000 });
  });
});

describe('planFor', () => {
  it('gives the exact setting no schedule at all, so every sample is decoded', () => {
    expect(planFor('exact')).toBeNull();
  });

  it('gives the standard setting a schedule that samples a small share', () => {
    const plan = planFor('standard')!;
    // A probe a minute: about an eighth of the audio, before refinement.
    expect(plan.windowMs / plan.everyMs).toBeLessThan(0.15);
  });
});

describe('refineWindows', () => {
  it('probes a span that lost time to a pause, which no ratio would catch', () => {
    // A chapter break is the commonest reason a span is badly interpolated and
    // the hardest for a rate test to see: ten seconds missing from a hundred
    // is a ten-per-cent wobble, comfortably inside any tolerance worth
    // setting, so these spans used to sail through carrying the largest
    // errors in the book.
    const RATE = 0.015;
    const anchors = anchorsAtRate(10, RATE);
    // Span 4→5 advances only 90% of the characters in the same wall clock:
    // ten seconds of the hundred went on silence rather than on reading.
    for (let i = 5; i < anchors.length; i++) {
      anchors[i]!.bookPos -= Math.round(0.1 * 100_000 * RATE);
    }
    const spanRate = (anchors[5]!.bookPos - anchors[4]!.bookPos) / 100_000;
    // Confirm the ratio test genuinely cannot see it, so this test is about
    // the slack rule and not about a tolerance that happens to be tight.
    expect(Math.abs(Math.log(spanRate / RATE))).toBeLessThan(
      Math.log(1 + DEFAULT_SPARSE_PLAN.rateTolerance),
    );

    const probes = refineWindows(anchors, gridWindows(900_000, PLAN), 900_000, PLAN, 4);
    expect(probes.length).toBeGreaterThan(0);
    // And it probes inside the span that lost the time.
    expect(probes.some((w) => w.startMs >= 400_000 && w.startMs < 500_000)).toBe(true);
  });

  it('leaves a steadily-read book alone', () => {
    const anchors = anchorsAtRate(10, 0.015);
    expect(refineWindows(anchors, gridWindows(900_000, PLAN), 900_000, PLAN, 10)).toEqual([]);
  });

  it('probes the stretch where the narration slowed down', () => {
    // A pause in the middle: the same audio span carries a third of the text,
    // which is what a chapter break or a long musical sting looks like from
    // here.
    const anchors = anchorsAtRate(10, 0.015);
    for (let i = 5; i < anchors.length; i++) anchors[i]!.bookPos -= 1000;

    const out = refineWindows(anchors, gridWindows(900_000, PLAN), 900_000, PLAN, 10);
    expect(out).toHaveLength(1);
    // Between the fourth and fifth anchors, i.e. 400 s and 500 s.
    expect(out[0]!.startMs).toBeGreaterThan(400_000);
    expect(out[0]!.startMs).toBeLessThan(500_000);
  });

  it('probes a stretch the narration raced through, too', () => {
    const anchors = anchorsAtRate(10, 0.015);
    for (let i = 5; i < anchors.length; i++) anchors[i]!.bookPos += 4000;
    const out = refineWindows(anchors, gridWindows(900_000, PLAN), 900_000, PLAN, 10);
    expect(out).toHaveLength(1);
    expect(out[0]!.startMs).toBeGreaterThan(400_000);
    expect(out[0]!.startMs).toBeLessThan(500_000);
  });

  it('probes an unanchored head - the part no measured rate can describe', () => {
    // Nothing matched for the first four minutes: a foreword, a credit, or a
    // probe that landed in music.
    const anchors = anchorsAtRate(6, 0.015, 240_000);
    const out = refineWindows(anchors, [], 900_000, PLAN, 10);
    expect(out.some((w) => w.startMs < 240_000)).toBe(true);
  });

  it('probes an unanchored tail', () => {
    const anchors = anchorsAtRate(4, 0.015);
    const out = refineWindows(anchors, [], 900_000, PLAN, 10);
    expect(out.some((w) => w.startMs > 300_000)).toBe(true);
  });

  it('never proposes a window over audio it has already decoded', () => {
    const anchors = anchorsAtRate(10, 0.015);
    for (let i = 5; i < anchors.length; i++) anchors[i]!.bookPos -= 1000;
    const covered: ProbeWindow[] = [{ startMs: 400_000, durationMs: 100_000 }];
    expect(refineWindows(anchors, covered, 900_000, PLAN, 10)).toEqual([]);
  });

  it('spends a small budget on the widest unmapped stretches first', () => {
    const anchors: Anchor[] = [
      { ms: 0, bookPos: 0 },
      // A 400 s hole with next to nothing read in it, then a 120 s stretch
      // that reads a minute too much. Both are suspicious; only one fits, and
      // five minutes nobody can account for is the worse of the two.
      { ms: 400_000, bookPos: 1_000 },
      { ms: 520_000, bookPos: 3_700 },
      { ms: 620_000, bookPos: 5_200 },
    ];
    const out = refineWindows(anchors, [], 900_000, PLAN, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.startMs).toBeGreaterThan(150_000);
    expect(out[0]!.startMs).toBeLessThan(250_000);
  });

  it('chases a skipped passage before a pause of about its size', () => {
    // At 15 characters a second: a 60 s stretch holding 3,000 characters (two
    // minutes of text skipped - a preface), and a 150 s one holding 1,950 (a
    // twenty-second pause). The budget buys one probe; the skip gets it.
    const anchors: Anchor[] = [
      { ms: 0, bookPos: 0 },
      { ms: 100_000, bookPos: 1_500 },
      { ms: 160_000, bookPos: 4_500 },
      { ms: 310_000, bookPos: 6_450 },
      { ms: 410_000, bookPos: 7_950 },
      { ms: 510_000, bookPos: 9_450 },
    ];
    const out = refineWindows(anchors, [], 510_000, PLAN, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.startMs).toBeGreaterThan(100_000);
    expect(out[0]!.startMs).toBeLessThan(160_000);
  });

  it('follows a skip into a stretch narrower than the grid would bother with', () => {
    // Earlier rounds have closed in on a skipped preface: 30 s of audio now
    // holds 2,000 characters. Too narrow for a pause to be worth a probe,
    // not for text read in no time.
    const anchors = anchorsAtRate(10, 0.015);
    anchors.splice(5, 0, { ms: 430_000, bookPos: 6_450 + 2_000 });
    for (let i = 6; i < anchors.length; i++) anchors[i]!.bookPos += 2_000;
    anchors[4] = { ms: 400_000, bookPos: 6_000 };
    const out = refineWindows(anchors, [], 900_000, PLAN, 10);
    expect(out.some((w) => w.startMs >= 400_000 && w.startMs < 430_000)).toBe(true);
  });

  it('proposes nothing when the budget is spent', () => {
    const anchors = anchorsAtRate(4, 0.015, 240_000);
    expect(refineWindows(anchors, [], 900_000, PLAN, 0)).toEqual([]);
  });
});

describe('stagesOf', () => {
  const minute = 60_000;
  const grid = gridWindows(5 * 3_600_000, { ...DEFAULT_SPARSE_PLAN, everyMs: minute });

  it('takes the book from the start forward, a short stage first and longer ones after', () => {
    const stages = stagesOf(grid, 5 * 3_600_000);
    // Every grid probe, once, in playback order.
    expect(stages.flatMap((s) => s.windows)).toEqual(grid);
    expect(stages[0]!.windows.map((w) => w.startMs)).toEqual([0, minute, 2 * minute]);
    expect(stages.map((s) => s.endMs).slice(0, STAGE_ENDS_MS.length)).toEqual(STAGE_ENDS_MS);
    // An hour a stage once past the opening ones...
    expect(stages[STAGE_ENDS_MS.length]!.endMs).toBe(STAGE_ENDS_MS.at(-1)! + STAGE_STEP_MS);
    // ...and the last one owns whatever is left of the audio.
    expect(stages.at(-1)!.endMs).toBe(5 * 3_600_000);
    for (const s of stages) {
      expect(s.windows.every((w) => w.startMs < s.endMs)).toBe(true);
    }
  });

  it('makes a short book a single stage, which is a sync as it always was', () => {
    const short = gridWindows(150_000, { ...DEFAULT_SPARSE_PLAN, everyMs: minute });
    expect(stagesOf(short, 150_000)).toEqual([{ windows: short, endMs: 150_000 }]);
  });

  it('has nothing to cut in a book with no audio', () => {
    expect(stagesOf([], 0)).toEqual([]);
  });
});

describe('refineWindows, a stage at a time', () => {
  // Read at 15 characters a second, except for two stretches that took far
  // longer: one before the horizon, one inside it.
  const anchors: Anchor[] = [
    { ms: 0, bookPos: 0 },
    { ms: 100_000, bookPos: 1_500 },
    { ms: 200_000, bookPos: 1_800 },
    { ms: 300_000, bookPos: 3_300 },
    { ms: 400_000, bookPos: 4_800 },
    { ms: 500_000, bookPos: 5_100 },
    { ms: 600_000, bookPos: 6_600 },
  ];

  it('only spends probes on the stage it is refining', () => {
    const out = refineWindows(anchors, [], 3_600_000, PLAN, 10, {
      fromMs: 300_000,
      toMs: 700_000,
      last: false,
    });
    expect(out.length).toBeGreaterThan(0);
    // The slow stretch before 300 s was settled and handed over already.
    expect(out.every((w) => w.startMs >= 300_000 && w.startMs < 700_000)).toBe(true);
    expect(out.some((w) => w.startMs > 400_000 && w.startMs < 500_000)).toBe(true);
  });

  it('leaves the gap after the last anchor to the next stage', () => {
    // Nothing anchored between 600 s and the stage's end at 900 s: the next
    // stage's grid starts there anyway.
    const out = refineWindows(anchors, [], 3_600_000, PLAN, 10, {
      fromMs: 550_000,
      toMs: 900_000,
      last: false,
    });
    expect(out.filter((w) => w.startMs > 600_000)).toEqual([]);
  });

  it('chases an unanchored tail in the last stage, up to the end of the audio', () => {
    const out = refineWindows(anchors, [], 900_000, PLAN, 10, {
      fromMs: 550_000,
      toMs: 900_000,
      last: true,
    });
    expect(out.some((w) => w.startMs > 600_000 && w.startMs < 900_000)).toBe(true);
  });
});

describe('assembleProbes', () => {
  const run = (startMs: number, text: string, msPerChar = 60): ProbeRun => ({
    window: { startMs, durationMs: 8_000 },
    chars: [...text].map((c, i) => ({ c, ms: startMs + i * msPerChar })),
  });

  it('splices probes in playback order however they were scheduled', () => {
    const out = assembleProbes([run(200_000, 'ccc'), run(0, 'aaa'), run(100_000, 'bbb')]);
    expect(out.map((c) => c.c).join('')).toBe(`aaa${PROBE_BREAK}bbb${PROBE_BREAK}ccc`);
    expect(out.map((c) => c.ms)).toEqual([...out].sort((a, b) => a.ms - b.ms).map((c) => c.ms));
  });

  it('skips a probe that heard nothing rather than leaving a stray break', () => {
    const out = assembleProbes([
      run(0, 'aaa'),
      { window: { startMs: 100_000, durationMs: 8_000 }, chars: [] },
      run(200_000, 'bbb'),
    ]);
    expect(out.map((c) => c.c).join('')).toBe(`aaa${PROBE_BREAK}bbb`);
  });

  it('never lets an n-gram straddle two probes', () => {
    // The two probes are minutes apart, but their characters would spell a
    // phrase from the middle of the book if they were run together. That
    // phantom must not become an anchor: it would drag every sentence around
    // it to a time nobody spoke it.
    const book: BookSentence[] = [
      { index: 0, romanized: 'zzzzzzzzzzzzzzzzzz' },
      { index: 1, romanized: 'thequickbrownfoxjumped' },
      { index: 2, romanized: 'yyyyyyyyyyyyyyyyyy' },
    ];
    const heard: DecodedChar[] = assembleProbes([
      run(0, 'thequickbrow'),
      run(600_000, 'nfoxjumpedxx'),
    ]);
    const { anchors } = matchChars(book, heard, { audioMs: 700_000 });
    // "thequickbrownfoxjumped" spans the seam; nothing may match it.
    expect(anchors.every((a) => a.bookPos < 18 || a.bookPos >= 40)).toBe(true);
  });
});
