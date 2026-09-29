import { describe, expect, it } from 'vitest';
import {
  landingOffset,
  markerOpacity,
  checkpointDue,
  audioReturnAfterJump,
  audioContinued,
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
