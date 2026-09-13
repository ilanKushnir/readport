import { describe, expect, it } from 'vitest';
import { buildCues, nearestCue } from './readalong';
import { type SentenceIndexEntry } from '../lib/types';

/**
 * "Back to the voice" has to work in a gap.
 *
 * `cueAt` answers "nothing" before the first cue, after the last, and in an
 * unaligned stretch - correctly, because a highlight must not claim a
 * sentence nobody is reading. But the button that puts a lost reader back
 * with the narrator asked the same question and got the same nothing, so it
 * did nothing at all, precisely when it was needed.
 */
const S = [
  { id: 'a', start: 0, end: 50 },
  { id: 'b', start: 100, end: 150 },
] as SentenceIndexEntry[];

const cues = buildCues(S, [
  { sentenceId: 'a', startMs: 1_000, endMs: 2_000 },
  { sentenceId: 'b', startMs: 30_000, endMs: 31_000 },
]);

describe('nearestCue', () => {
  it('returns the cue being spoken', () => {
    expect(nearestCue(cues, 1_500)?.id).toBe('a');
  });

  it('answers in the gap where cueAt gives up', () => {
    // Closer to the end of 'a' than to the start of 'b'.
    expect(nearestCue(cues, 5_000)?.id).toBe('a');
    // ...and the other way around.
    expect(nearestCue(cues, 28_000)?.id).toBe('b');
  });

  it('answers before the first cue and after the last', () => {
    expect(nearestCue(cues, 0)?.id).toBe('a');
    expect(nearestCue(cues, 999_000)?.id).toBe('b');
  });

  it('counts time inside a cue as being in it, not near the next', () => {
    expect(nearestCue(cues, 2_000)?.id).toBe('a');
  });

  it('has nothing to offer for a chapter with no timings', () => {
    expect(nearestCue([], 1_000)).toBeNull();
  });

  it('handles a single cue', () => {
    const one = buildCues([S[0]!], [{ sentenceId: 'a', startMs: 10, endMs: 20 }]);
    expect(nearestCue(one, 999)?.id).toBe('a');
    expect(nearestCue(one, 0)?.id).toBe('a');
  });
});
