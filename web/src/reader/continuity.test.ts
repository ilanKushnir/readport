import { describe, expect, it } from 'vitest';
import {
  landingOffset,
  markerOpacity,
  checkpointDue,
  audioReturnAfterJump,
  audioContinued,
  resumeSpans,
  sentenceAround,
  sentenceStartNear,
  SENTENCE_REACH,
} from './continuity';

describe('exact landing', () => {
  const sentences = [{ id: 's1', start: 100, end: 200 }];
  it('retains the exact charOffset inside the sentence, not its beginning', () => {
    expect(landingOffset({ charOffset: 173, sentenceId: 's1' }, sentences)).toBe(173);
  });
  it('uses sentence start only when no character locator exists', () => {
    expect(landingOffset({ sentenceId: 's1' }, sentences)).toBe(100);
  });
});
describe('where a place is shown', () => {
  // "The harbour was quiet. Once you start practicing this technique you will
  // be pleasantly surprised." - a heading gap before it, a run-on after.
  const text =
    'The harbour was quiet. Once you start practicing this technique you will be pleasantly surprised.';
  const sentences = [
    { start: 0, end: 23 },
    { start: 23, end: text.length },
    { start: 300, end: 300 + SENTENCE_REACH + 400 },
  ];
  // Word edges over the text above, the way textmap's wordEdge finds them;
  // past its end, every offset is an edge of its own.
  const word = {
    start: (at: number) => {
      if (at >= text.length) return at;
      let i = at;
      while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
      return i;
    },
    end: (at: number) => {
      let i = at;
      while (i < text.length && !/\s/.test(text[i]!)) i++;
      return i;
    },
  };
  const practicing = text.indexOf('practicing') + 1; // "p|racticing"

  it('finds the sentence a place is in, or the one just after a gap', () => {
    expect(sentenceAround(sentences, practicing)).toEqual(sentences[1]);
    expect(sentenceAround(sentences, 99)).toBeNull();
    expect(sentenceAround(sentences, 250)).toEqual(sentences[2]);
  });
  it('lights from the start of the sentence, then from the start of the word - never mid-word', () => {
    const spans = resumeSpans(sentences, practicing, word);
    expect(spans[0]).toEqual({ start: 23, end: text.length });
    expect(spans[1]!.start).toBe(text.indexOf('practicing'));
    expect(spans[1]!.end).toBe(text.length);
  });
  it('offers one span when the place already is the start of its sentence', () => {
    expect(resumeSpans(sentences, 23, word)).toEqual([{ start: 23, end: text.length }]);
  });
  it('does not carry a place back through a run-on "sentence"', () => {
    const deep = 300 + SENTENCE_REACH + 50;
    const spans = resumeSpans(sentences, deep, word);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBe(word.start(deep));
    expect(sentenceStartNear(sentences, deep)).toBe(deep);
  });
  it('brings the sentence start into view, and leaves a gap where it is', () => {
    expect(sentenceStartNear(sentences, practicing)).toBe(23);
    expect(sentenceStartNear(sentences, 250)).toBe(250);
    expect(sentenceStartNear([], 42)).toBe(42);
  });
  it('without a sentence index, lights about a line from the start of the word', () => {
    const spans = resumeSpans([], practicing, word);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBe(text.indexOf('practicing'));
    expect(spans[0]!.end).toBeGreaterThan(spans[0]!.start);
  });
});

// Where a jump left from, and where it landed.
const origin = { spineIdx: 1, charOffset: 173, label: 'The beginning' };
const destination = { spineIdx: 3, charOffset: 0 };
describe('resume marker lifecycle', () => {
  it('layout ticks and small movement cannot erase the marker; reading fades it progressively', () => {
    expect(markerOpacity(origin, origin)).toBe(1);
    expect(markerOpacity(origin, { ...origin, charOffset: 174 })).toBe(1);
    const halfway = markerOpacity(origin, { ...origin, charOffset: 473 });
    expect(halfway).toBeGreaterThan(0);
    expect(halfway).toBeLessThan(1);
    expect(markerOpacity(origin, { ...origin, charOffset: 1173 })).toBe(0);
    expect(markerOpacity(origin, destination)).toBe(0);
  });
});
describe('live read-along cadence', () => {
  it('audio return policy ignores progression, resume, narration and small seeks; expires after listening on', () => {
    for (const reason of ['progression', 'resume', 'narration', 'return'] as const)
      expect(audioReturnAfterJump(120000, 600000, reason)).toBeNull();
    for (const reason of ['toc', 'bookmark', 'slider', 'search'] as const) {
      expect(audioReturnAfterJump(120000, 140000, reason)).toBeNull();
      expect(audioReturnAfterJump(120000, 600000, reason)).toEqual({
        originMs: 120000,
        destinationMs: 600000,
      });
    }
    expect(audioReturnAfterJump(Number.NaN, 600000, 'toc')).toBeNull();
    const point = audioReturnAfterJump(120000, 600000, 'toc')!;
    expect(audioContinued(point, 610000)).toBe(false);
    expect(audioContinued(point, 631000)).toBe(true);
    expect(audioContinued(point, 120000)).toBe(true);
  });
  it('checkpoints changed exact locators every three seconds, not render ticks', () => {
    expect(checkpointDue(1000, 3999, true)).toBe(false);
    expect(checkpointDue(1000, 4000, true)).toBe(true);
    expect(checkpointDue(1000, 9000, false)).toBe(false);
  });
});
