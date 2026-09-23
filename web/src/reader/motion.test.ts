import { describe, expect, it } from 'vitest';
import { autoScrollTarget, markerPosition } from './motion';

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

describe('auto-scroll, a chunk at a time', () => {
  const base = { clientHeight: 1000, anchor: 0.3 };
  it('brings a new chunk to the reading line', () => {
    expect(
      autoScrollTarget({ ...base, held: null, chunkTop: 2000, voiceTop: 2000, voiceBottom: 2030 }),
    ).toBe(1700);
  });
  it('holds still while the chunk is read', () => {
    expect(
      autoScrollTarget({ ...base, held: 1700, chunkTop: 2000, voiceTop: 2300, voiceBottom: 2330 }),
    ).toBe(1700);
  });
  it('moves again in a chunk too long to read from the line, when the voice nears the foot', () => {
    expect(
      autoScrollTarget({ ...base, held: 1700, chunkTop: 2000, voiceTop: 2600, voiceBottom: 2630 }),
    ).toBe(2300);
  });
  it('places a long chunk picked up half way by the voice, not by its first line', () => {
    expect(
      autoScrollTarget({ ...base, held: null, chunkTop: 2000, voiceTop: 3500, voiceBottom: 3530 }),
    ).toBe(3200);
  });
  it('brings back a voice that is above the screen', () => {
    expect(
      autoScrollTarget({ ...base, held: 1700, chunkTop: 1000, voiceTop: 1500, voiceBottom: 1530 }),
    ).toBe(1200);
  });
  it('never asks for a place above the top of the book', () => {
    expect(
      autoScrollTarget({ ...base, held: null, chunkTop: 40, voiceTop: 40, voiceBottom: 70 }),
    ).toBe(0);
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
