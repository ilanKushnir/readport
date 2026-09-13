import { describe, expect, it } from 'vitest';
import { buildCues, shouldFollow } from './readalong';
import { type SentenceIndexEntry } from '../lib/types';

/**
 * Taking over from the voice, and getting it back.
 *
 * `following || cueOnScreen` meant a deliberate scroll was undone by the next
 * tick of the clock whenever the spoken sentence happened to still be
 * visible - which, in scrolling mode, is most of a chapter. The page pulled
 * itself back and "Back to the voice" blinked in and out.
 */
const CUE = buildCues(
  [{ id: 's1', start: 0, end: 10 } as SentenceIndexEntry],
  [{ sentenceId: 's1', startMs: 0, endMs: 1000 }],
)[0]!;

describe('shouldFollow', () => {
  it('follows while the reader has not taken over', () => {
    expect(shouldFollow(true, CUE, false)).toBe(true);
    expect(shouldFollow(true, CUE, true)).toBe(true);
  });

  it('does not resume just because the sentence is still visible', () => {
    // The reader has just scrolled; the voice has not been away yet.
    expect(shouldFollow(false, CUE, true, false)).toBe(false);
  });

  it('resumes when the voice comes back to where they went', () => {
    expect(shouldFollow(false, CUE, true, true)).toBe(true);
  });

  it('stays off while the voice is somewhere else', () => {
    expect(shouldFollow(false, CUE, false, true)).toBe(false);
    expect(shouldFollow(false, CUE, false, false)).toBe(false);
  });

  it('has nothing to follow without a cue', () => {
    expect(shouldFollow(true, null, true)).toBe(false);
  });

  it('behaves as before for callers that do not track a takeover', () => {
    // The default keeps the old meaning for any call site not passing it.
    expect(shouldFollow(false, CUE, true)).toBe(true);
  });
});
