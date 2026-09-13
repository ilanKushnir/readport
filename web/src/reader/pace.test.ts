import { describe, expect, it } from 'vitest';
import { buildCues, CONFIDENT_MS, isConfident, paceOffset } from './readalong';
import { type SentenceIndexEntry } from '../lib/types';

/**
 * The pace marker, and when a timing may be shown as a fact.
 *
 * Karaoke highlighting was reported as inaccurate and as leaving marks behind:
 * a wrong highlight is worse than none, because the reader's eye follows it.
 * So the continuous thing is a marker beside the text — an estimate, drawn as
 * one — and the text itself is only ever touched where the aligner is sure.
 */

const sentence = (id: string, start: number, end: number): SentenceIndexEntry =>
  ({ id, start, end }) as SentenceIndexEntry;

// Gapped the way real sentences are: the whitespace between them belongs to
// neither, which is the room the marker drifts through during a breath.
const SENTENCES = [sentence('s1', 0, 90), sentence('s2', 100, 190), sentence('s3', 200, 290)];

/** s1 spoken 0–1000ms, s2 2000–3000ms (a one-second breath), s3 3000–4000ms. */
const cues = buildCues(SENTENCES, [
  { sentenceId: 's1', startMs: 0, endMs: 1000, uncertaintyMs: 100 },
  { sentenceId: 's2', startMs: 2000, endMs: 3000, uncertaintyMs: 4000 },
  { sentenceId: 's3', startMs: 3000, endMs: 4000 },
]);

describe('paceOffset', () => {
  it('moves through a sentence at the rate the sentence is spoken', () => {
    // s1 is 90 characters spoken over 1000ms.
    expect(paceOffset(cues, 0)).toBe(0);
    expect(paceOffset(cues, 500)).toBe(45);
    expect(paceOffset(cues, 999)).toBeCloseTo(89.9, 1);
  });

  it('keeps moving through the breath between two sentences', () => {
    // The old highlight sat still on the finished sentence and then jumped.
    const a = paceOffset(cues, 1100)!;
    const b = paceOffset(cues, 1500)!;
    const c = paceOffset(cues, 1900)!;
    expect(a).toBeGreaterThanOrEqual(90);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // It arrives at the next sentence rather than overshooting into it.
    expect(c).toBeLessThanOrEqual(100);
  });

  it('never runs backwards', () => {
    let previous = -1;
    for (let ms = 0; ms <= 4000; ms += 25) {
      const at = paceOffset(cues, ms);
      if (at === null) continue;
      expect(at, `at ${ms}ms`).toBeGreaterThanOrEqual(previous);
      previous = at;
    }
  });

  it('stays inside the text it is describing', () => {
    for (let ms = 0; ms <= 4000; ms += 50) {
      const at = paceOffset(cues, ms);
      if (at === null) continue;
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(290);
    }
  });

  it('has nothing to say before the narration reaches this chapter', () => {
    expect(paceOffset(cues, -10_000)).toBeNull();
  });

  it('lets go rather than guessing across a hole in the alignment', () => {
    // Two cues twenty seconds apart is not a breath; the aligner lost the
    // thread in between and the marker must not invent a position.
    const holed = buildCues(SENTENCES, [
      { sentenceId: 's1', startMs: 0, endMs: 1000 },
      { sentenceId: 's3', startMs: 21_000, endMs: 22_000 },
    ]);
    expect(paceOffset(holed, 10_000)).toBeNull();
  });

  it('has nothing to say for a chapter with no timings', () => {
    expect(paceOffset([], 1000)).toBeNull();
  });

  it('survives a zero-length cue without dividing by zero', () => {
    const degenerate = buildCues(
      [sentence('s1', 0, 10)],
      [{ sentenceId: 's1', startMs: 500, endMs: 500 }],
    );
    const at = paceOffset(degenerate, 500);
    expect(at === null || Number.isFinite(at)).toBe(true);
  });
});

describe('isConfident', () => {
  it('trusts a tight timing', () => {
    expect(isConfident(cues.find((c) => c.id === 's1')!)).toBe(true);
  });

  it('does not trust a loose one', () => {
    expect(isConfident(cues.find((c) => c.id === 's2')!)).toBe(false);
  });

  it('treats an unstated uncertainty as unknown, not as certain', () => {
    // s3 has no uncertaintyMs. Silence is not a promise.
    expect(isConfident(cues.find((c) => c.id === 's3')!)).toBe(false);
  });

  it('has nothing to trust when there is no cue', () => {
    expect(isConfident(null)).toBe(false);
  });

  it('draws the line where it says it does', () => {
    const [tight, loose] = [CONFIDENT_MS, CONFIDENT_MS + 1].map(
      (u) =>
        buildCues(
          [sentence('x', 0, 10)],
          [{ sentenceId: 'x', startMs: 0, endMs: 1, uncertaintyMs: u }],
        )[0]!,
    );
    expect(isConfident(tight)).toBe(true);
    expect(isConfident(loose)).toBe(false);
  });
});
