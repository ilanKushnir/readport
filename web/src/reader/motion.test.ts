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

import { easeInOutCubic, glidePosition, ScrollGlide, ScrollOwnership } from './motion';

describe('eased glide', () => {
  it('starts and ends where it should, and is slow at both ends', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });
  it('lands exactly on the target when the time is up', () => {
    expect(glidePosition(0, 300, 450, 450)).toBe(300);
    expect(glidePosition(0, 300, 900, 450)).toBe(300);
    expect(glidePosition(0, 300, 0, 450)).toBe(0);
    expect(glidePosition(100, 0, 225, 450)).toBe(50);
    expect(glidePosition(0, 300, 10, 0)).toBe(300);
  });
});

describe('ScrollGlide', () => {
  /** A scroller and a frame clock the test advances by hand. */
  function harness() {
    const el = { scrollTop: 0, scrollHeight: 5000, clientHeight: 800 };
    const frames: ((now: number) => void)[] = [];
    let now = 1000;
    const ownership = new ScrollOwnership();
    const glide = new ScrollGlide(
      ownership,
      (cb) => frames.push(cb),
      (id) => frames.splice(id - 1, 1),
      () => now,
    );
    const tick = (ms: number) => {
      now += ms;
      const cb = frames.shift();
      cb?.(now);
    };
    return { el, glide, tick, ownership, frames, set: (ms: number) => (now += ms) };
  }
  it('moves through the frames and lands on the target, writing through the ownership', () => {
    const { el, glide, tick, ownership } = harness();
    glide.start(el, 600, 450);
    expect(glide.active).toBe(true);
    tick(0);
    tick(112);
    expect(el.scrollTop).toBeGreaterThan(0);
    expect(el.scrollTop).toBeLessThan(300);
    expect(ownership.matches(el)).toBe(true);
    tick(113);
    expect(el.scrollTop).toBeCloseTo(300, 0);
    tick(300);
    expect(el.scrollTop).toBe(600);
    expect(glide.active).toBe(false);
  });
  it('is instant when there is no time to ease, and clamps to the scrollable range', () => {
    const { el, glide } = harness();
    glide.start(el, 600, 0);
    expect(el.scrollTop).toBe(600);
    expect(glide.active).toBe(false);
    glide.start(el, 99999, 0);
    expect(el.scrollTop).toBe(4200);
  });
  it('gives up the moment the reader takes the wheel', () => {
    const { el, glide, tick } = harness();
    glide.start(el, 600, 450);
    tick(0);
    tick(100);
    const before = el.scrollTop;
    el.scrollTop = before + 40; // a flick, not one of ours
    tick(100);
    expect(el.scrollTop).toBe(before + 40);
    expect(glide.active).toBe(false);
  });
  it('can be cancelled, and a new glide replaces the old one', () => {
    const { el, glide, tick, frames } = harness();
    glide.start(el, 600, 450);
    glide.cancel();
    expect(glide.active).toBe(false);
    expect(frames).toHaveLength(0);
    glide.start(el, 200, 450);
    tick(0);
    tick(450);
    expect(el.scrollTop).toBe(200);
  });
});
