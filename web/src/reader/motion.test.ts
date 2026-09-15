import { describe, expect, it } from 'vitest';
import { autoScrollDelta, markerPosition } from './motion';

const box = { left: 100, right: 1100, top: 50, bottom: 800 };
const layout = { columns: 2 as const, pad: 24, columnGap: 48 };
const rect = (left: number) => ({ left, right: left + 8, top: 200, bottom: 222, height: 22 });

describe('marker geometry', () => {
  it('uses the physical column start for LTR', () => {
    expect(markerPosition(rect(650), box, box, box, false, layout)).toEqual({
      left: 512,
      top: 161,
    });
  });
  it('uses the physical column end for RTL', () => {
    expect(markerPosition(rect(200), box, box, box, true, layout)).toEqual({ left: 485, top: 161 });
  });
  it('hides an off-spread or unmeasurable cue', () => {
    expect(markerPosition(rect(1400), box, box, box, false, layout)).toBeNull();
    expect(markerPosition({ ...rect(200), height: 0 }, box, box, box, false, layout)).toBeNull();
  });
});

describe('continuous scroll step', () => {
  it('does not move after takeover or under reduced motion', () => {
    expect(autoScrollDelta(0, 1000, 0.1, 16, false, false)).toBe(0);
    expect(autoScrollDelta(0, 1000, 0.1, 16, true, true)).toBe(0);
  });
  it('caps catch-up and background-frame movement, and glides back when the line is above', () => {
    expect(autoScrollDelta(0, 10000, 1, 16, true, false)).toBeCloseTo(3.52);
    expect(autoScrollDelta(0, 10000, 1, 10000, true, false)).toBeCloseTo(14.08);
    // Nothing measured yet (speed 0): the drift term alone moves it, gently.
    expect(autoScrollDelta(100, 0, 0, 16, true, false)).toBeCloseTo(-(100 * 16) / 3000);
  });
  it('does not overshoot a stationary target', () => {
    expect(autoScrollDelta(99, 100, 0.2, 16, true, false)).toBe(1);
  });
});

describe('autoScrollDelta direction', () => {
  it('glides back up when the target is above the current position', () => {
    const d = autoScrollDelta(1000, 800, 0.1, 16, true, false);
    expect(d).toBeLessThan(0);
    expect(Math.abs(d)).toBeLessThanOrEqual(16 * 0.22);
  });
  it('never overshoots the target in either direction', () => {
    expect(autoScrollDelta(1000, 1002, 5, 16, true, false)).toBe(2);
    expect(autoScrollDelta(1000, 998, 5, 16, true, false)).toBe(-2);
  });
});
