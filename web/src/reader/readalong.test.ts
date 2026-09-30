import { describe, expect, it } from 'vitest';
import { type SentenceIndexEntry } from '../lib/types';
import {
  BEYOND_TEXT_SETTLE_MS,
  beyondTextAt,
  type BeyondText,
  type AlignedSegment,
  HOLD_MS,
  buildCues,
  cueArriving,
  cueAt,
  cueForOffset,
  cueForTurn,
  hasArrived,
  locateInTracks,
  nearestChapter,
  paceOffset,
  shouldFollow,
} from './readalong';

/**
 * The read-along cue list, and the judgement calls in it: what to do between
 * two sentences, what to do where the alignment has nothing, and where to
 * start when the reader taps a line the aligner never timed.
 */

function sentence(id: string, start: number, end: number, ord = 0): SentenceIndexEntry {
  return { id, ord, start, end };
}
function segment(sentenceId: string, startMs: number, endMs: number): AlignedSegment {
  return { sentenceId, startMs, endMs };
}

/** Three sentences, spoken one after another with a breath between each. */
const SENTENCES = [sentence('s1', 0, 40, 0), sentence('s2', 40, 90, 1), sentence('s3', 90, 150, 2)];
const SEGMENTS = [
  segment('s1', 1_000, 4_000),
  segment('s2', 4_500, 9_000),
  segment('s3', 9_400, 15_000),
];
const CUES = buildCues(SENTENCES, SEGMENTS);

describe('buildCues', () => {
  it('joins a sentence to its timing by id', () => {
    expect(CUES).toHaveLength(3);
    expect(CUES[0]).toEqual({
      id: 's1',
      charStart: 0,
      charEnd: 40,
      startMs: 1_000,
      endMs: 4_000,
      // No stated uncertainty is unknown, not certain: the pace marker still
      // moves through it, but the text is never marked as a fact.
      uncertaintyMs: Number.POSITIVE_INFINITY,
    });
  });

  it('drops a sentence the aligner never timed rather than inventing one', () => {
    // An interpolated cue would put the highlight on a line with exactly the
    // same confidence as a measured one. Better to have no cue there.
    const cues = buildCues(SENTENCES, [SEGMENTS[0]!, SEGMENTS[2]!]);
    expect(cues.map((c) => c.id)).toEqual(['s1', 's3']);
  });

  it('drops a timing whose sentence is not in this chapter', () => {
    const cues = buildCues(SENTENCES, [...SEGMENTS, segment('elsewhere', 20_000, 21_000)]);
    expect(cues.map((c) => c.id)).toEqual(['s1', 's2', 's3']);
  });

  it('ignores a segment with a nonsense time', () => {
    const cues = buildCues(SENTENCES, [segment('s1', Number.NaN, 4_000), SEGMENTS[1]!]);
    expect(cues.map((c) => c.id)).toEqual(['s2']);
  });

  it('orders by the clock, which is what the lookup searches', () => {
    const shuffled = buildCues(SENTENCES, [SEGMENTS[2]!, SEGMENTS[0]!, SEGMENTS[1]!]);
    expect(shuffled.map((c) => c.startMs)).toEqual([1_000, 4_500, 9_400]);
  });

  it('gives an inverted or empty span enough width to be current', () => {
    const [cue] = buildCues([sentence('s1', 0, 40)], [segment('s1', 5_000, 5_000)]);
    expect(cue!.endMs).toBeGreaterThan(cue!.startMs);
  });
});

describe('cueAt', () => {
  it('finds the sentence being spoken', () => {
    expect(cueAt(CUES, 2_000).cue?.id).toBe('s1');
    expect(cueAt(CUES, 5_000).cue?.id).toBe('s2');
    expect(cueAt(CUES, 14_999).cue?.id).toBe('s3');
  });

  it('holds the last sentence through the breath after it', () => {
    // 4000 → 4500 is a pause between two sentences, not a hole. Letting go
    // there makes the highlight blink on every full stop.
    const got = cueAt(CUES, 4_200);
    expect(got.state).toBe('hold');
    expect(got.cue?.id).toBe('s1');
  });

  it('lets go where the alignment has nothing to say', () => {
    const sparse = buildCues(SENTENCES, [SEGMENTS[0]!, segment('s3', 60_000, 64_000)]);
    // Half a minute of narration this chapter cannot place.
    expect(cueAt(sparse, 30_000)).toEqual({ cue: null, state: 'gap', index: -1 });
  });

  it('holds rather than gapping for exactly the tolerated pause', () => {
    const two = buildCues(SENTENCES, [SEGMENTS[0]!, segment('s2', 4_000 + HOLD_MS + 500, 9_000)]);
    expect(cueAt(two, 4_000 + HOLD_MS).state).toBe('hold');
    expect(cueAt(two, 4_000 + HOLD_MS + 1).state).toBe('gap');
  });

  it('says the narration is before this chapter, but not for a hair', () => {
    expect(cueAt(CUES, 0).state).toBe('hold'); // 1s early - clock rounding
    expect(cueAt(CUES, 1_000 - HOLD_MS - 1).state).toBe('before');
  });

  it('says the narration has left this chapter', () => {
    expect(cueAt(CUES, 15_000 + HOLD_MS).state).toBe('hold');
    expect(cueAt(CUES, 15_000 + HOLD_MS + 1).state).toBe('after');
  });

  it('has an answer for a chapter with no alignment at all', () => {
    expect(cueAt([], 5_000)).toEqual({ cue: null, state: 'gap', index: -1 });
  });

  it('reports the index, so the caller can see what comes next', () => {
    expect(cueAt(CUES, 5_000).index).toBe(1);
  });
});

describe('cueForOffset', () => {
  it('finds the sentence under a tap', () => {
    expect(cueForOffset(CUES, 50)?.id).toBe('s2');
  });

  it('falls forward when the tapped sentence has no timing', () => {
    // Starting behind the reader replays what they just read; starting a
    // little ahead is visible in the highlight and easy to correct.
    const sparse = buildCues(SENTENCES, [SEGMENTS[0]!, SEGMENTS[2]!]);
    expect(cueForOffset(sparse, 60)?.id).toBe('s3');
  });

  it('returns nothing past the last timed sentence', () => {
    expect(cueForOffset(CUES, 500)).toBeNull();
  });

  it('returns nothing when the chapter has no cues', () => {
    expect(cueForOffset([], 10)).toBeNull();
  });
});

describe('a sentence the voice was sent to', () => {
  // A tap on s2. The voice goes to s2's own start, and a seek lands a little
  // short of where it was sent: the clock is still in s1 for a moment.
  const s2 = CUES[1]!;

  it('is the one shown from the moment it is asked for, not the sentence before it', () => {
    expect(cueAt(CUES, 3_500).cue?.id).toBe('s1');
    expect(cueArriving(CUES, 3_500, s2)).toMatchObject({ cue: s2, state: 'on', index: 1 });
  });

  it('holds the margin mark at its first word while the voice arrives', () => {
    expect(paceOffset(CUES, 3_500, s2)).toBe(40);
    expect(paceOffset(CUES, 3_500)).toBeLessThan(40);
  });

  it('gives the clock back once the voice is in it, or somewhere else altogether', () => {
    expect(cueArriving(CUES, 5_000, s2).cue?.id).toBe('s2');
    // Rewound well before it: the clock's answer, not the tap's.
    expect(cueArriving(CUES, 1_500, s2).cue?.id).toBe('s1');
  });

  it('has arrived only once the voice is well inside it', () => {
    // The seek sets the clock to the start at once; the element's first
    // report can still land a frame short, so that is not arriving yet.
    expect(hasArrived(s2, 4_500)).toBe(false);
    expect(hasArrived(s2, 4_480)).toBe(false);
    expect(hasArrived(s2, 5_000)).toBe(true);
    expect(hasArrived(s2, 1_500)).toBe(true);
  });
});

describe('shouldFollow', () => {
  const cue = CUES[1]!;

  it('follows while the reader has not taken over', () => {
    expect(shouldFollow(true, cue, false)).toBe(true);
  });

  it('stops following when the reader has moved the page themselves', () => {
    expect(shouldFollow(false, cue, false)).toBe(false);
  });

  it('resumes on its own once the narration reaches the page they went to', () => {
    // Nothing to press: they turned ahead, the narration caught up, and the
    // spoken sentence is on screen again.
    expect(shouldFollow(false, cue, true)).toBe(true);
  });

  it('never follows nothing', () => {
    expect(shouldFollow(true, null, true)).toBe(false);
  });
});

describe('locateInTracks', () => {
  const tracks = [
    { durationMs: 60_000, startMsAbsolute: 0 },
    { durationMs: 90_000, startMsAbsolute: 60_000 },
    { durationMs: 30_000, startMsAbsolute: 150_000 },
  ];

  it('finds the file a book-absolute position falls in', () => {
    expect(locateInTracks(tracks, 0)).toEqual({ trackIdx: 0, positionMs: 0 });
    expect(locateInTracks(tracks, 59_999)).toEqual({ trackIdx: 0, positionMs: 59_999 });
    expect(locateInTracks(tracks, 60_000)).toEqual({ trackIdx: 1, positionMs: 0 });
    expect(locateInTracks(tracks, 155_000)).toEqual({ trackIdx: 2, positionMs: 5_000 });
  });

  it('clamps a position past the end of the book into the last file', () => {
    // An alignment that ran a little long must still be seekable, not silently
    // dropped on the floor.
    expect(locateInTracks(tracks, 999_999)).toEqual({ trackIdx: 2, positionMs: 30_000 });
  });

  it('never returns a negative position', () => {
    expect(locateInTracks(tracks, -5_000)).toEqual({ trackIdx: 0, positionMs: 0 });
  });

  it('survives a book whose tracks have not loaded yet', () => {
    expect(locateInTracks([], 4_000)).toEqual({ trackIdx: 0, positionMs: 4_000 });
  });
});

describe('nearestChapter', () => {
  const bounds = [
    { spineIdx: 1, firstMs: 10_000, lastMs: 20_000 },
    { spineIdx: 3, firstMs: 30_000, lastMs: 40_000 },
  ];
  it('names the chapter whose timed span holds the playhead', () => {
    expect(nearestChapter(bounds, 15_000)).toBe(1);
    expect(nearestChapter(bounds, 40_000)).toBe(3);
  });
  it('in the untimed stretch between two chapters, picks the closer edge, and forward on a tie', () => {
    expect(nearestChapter(bounds, 22_000)).toBe(1);
    expect(nearestChapter(bounds, 28_000)).toBe(3);
    expect(nearestChapter(bounds, 25_000)).toBe(3);
  });
  it('has no answer for a book with no timed chapters', () => {
    expect(nearestChapter([], 5)).toBeNull();
  });
});

describe('cueForTurn (a page turned with the voice)', () => {
  // Three 10-second sentences of 100 characters each.
  const c = (i: number) => ({
    id: `s${i}`,
    charStart: i * 100,
    charEnd: i * 100 + 100,
    startMs: i * 10000,
    endMs: i * 10000 + 10000,
    uncertaintyMs: 200,
  });
  const cues = [c(0), c(1), c(2)];
  const onPage = (from: number, to: number) => (off: number) => off >= from && off < to;

  it('starts at the first sentence on a page that begins with one', () => {
    expect(cueForTurn(cues, 100, onPage(100, 300))).toEqual({ cue: cues[1], hold: false });
  });
  it('gives a sentence the page begins in the middle of whole, when little of it is behind', () => {
    // 30 of its 100 characters on the page before: about three seconds.
    expect(cueForTurn(cues, 130, onPage(130, 300))).toEqual({ cue: cues[1], hold: true });
  });
  it('skips it for the next sentence when most of it is behind', () => {
    // 80 characters behind: about eight seconds, past the six allowed.
    expect(cueForTurn(cues, 180, onPage(180, 300))).toEqual({ cue: cues[2], hold: false });
  });
  it('holds on a page no sentence begins on', () => {
    expect(cueForTurn(cues, 180, onPage(180, 195))).toEqual({ cue: cues[1], hold: true });
  });
  it('has nothing to start after the last timed sentence', () => {
    expect(cueForTurn(cues, 320, onPage(320, 400))).toBeNull();
  });
});

describe('beyondTextAt', () => {
  // A minute and a half the ebook does not have, between two synced
  // sentences, and the narration's last minute after the text has ended.
  const middle: BeyondText = {
    fromMs: 300_000,
    toMs: 390_000,
    extraMs: 90_000,
    where: 'middle',
    resume: { spineIdx: 3, sentenceId: 's0', charOffset: 0 },
  };
  const end: BeyondText = {
    fromMs: 900_000,
    toMs: 960_000,
    extraMs: 60_000,
    where: 'end',
    resume: null,
  };
  const opening: BeyondText = {
    fromMs: 0,
    toMs: 45_000,
    extraMs: 45_000,
    where: 'start',
    resume: { spineIdx: 0, sentenceId: 's0', charOffset: 0 },
  };

  it('waits for the pause after the last sentence before saying anything', () => {
    expect(beyondTextAt([middle], 300_000)).toBeNull();
    expect(beyondTextAt([middle], 300_000 + BEYOND_TEXT_SETTLE_MS - 1)).toBeNull();
    expect(beyondTextAt([middle], 300_000 + BEYOND_TEXT_SETTLE_MS)?.stretch).toBe(middle);
  });

  it('counts down to where the text picks up, and lets go when it does', () => {
    const now = beyondTextAt([middle, end], 345_000)!;
    expect(now.remainingMs).toBe(45_000);
    expect(now.progress).toBeCloseTo(0.5, 5);
    expect(beyondTextAt([middle, end], 390_000)).toBeNull();
  });

  it('is said from the first moment of an opening the ebook does not have', () => {
    expect(beyondTextAt([opening], 0)?.stretch).toBe(opening);
  });

  it('knows the narration after the last page has nowhere to pick up', () => {
    const now = beyondTextAt([middle, end], 930_000)!;
    expect(now.stretch.resume).toBeNull();
    expect(now.remainingMs).toBe(30_000);
  });

  it('is nothing outside the stretches, or with none', () => {
    expect(beyondTextAt([middle, end], 500_000)).toBeNull();
    expect(beyondTextAt([], 345_000)).toBeNull();
  });
});
