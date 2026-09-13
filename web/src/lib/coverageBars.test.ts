import { describe, expect, it } from 'vitest';
import { bucketCoverage, MAX_COVERAGE_BARS } from './coverageBars';

/**
 * The strip has to fit its card whatever the book's length.
 *
 * Drawn one bar per audio minute, a ten-hour audiobook made the strip about
 * 2,400px wide inside a 309px card and gave the whole Pairing page two
 * thousand pixels of horizontal scroll.
 */

const bars = (n: number, f: (i: number) => number = () => 1) =>
  Array.from({ length: n }, (_, i) => ({ minute: i, confidence: f(i) }));

describe('bucketCoverage', () => {
  it('leaves a short book alone', () => {
    const out = bucketCoverage(bars(40));
    expect(out).toHaveLength(40);
    expect(out.every((b) => b.minutes === 1)).toBe(true);
  });

  it('caps a ten-hour audiobook at the bar limit', () => {
    expect(bucketCoverage(bars(600))).toHaveLength(MAX_COVERAGE_BARS);
  });

  it('covers every source minute exactly once', () => {
    // No minute may be dropped or double-counted: the strip claims to describe
    // the whole book.
    for (const n of [97, 150, 600, 1441]) {
      const out = bucketCoverage(bars(n));
      expect(out.reduce((a, b) => a + b.minutes, 0)).toBe(n);
    }
  });

  it('keeps buckets within one minute of each other in width', () => {
    const widths = bucketCoverage(bars(601)).map((b) => b.minutes);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });

  it('averages the confidences it merges', () => {
    // Second half of the book badly aligned: the right of the strip must show
    // it rather than being smoothed away to the overall mean.
    const out = bucketCoverage(bars(600, (i) => (i < 300 ? 1 : 0)));
    expect(out[0]!.confidence).toBe(1);
    expect(out[out.length - 1]!.confidence).toBe(0);
    const mid = out.reduce((a, b) => a + b.confidence, 0) / out.length;
    expect(mid).toBeCloseTo(0.5, 2);
  });

  it('preserves a single weak patch instead of losing it', () => {
    const out = bucketCoverage(bars(600, (i) => (i >= 200 && i < 210 ? 0 : 1)));
    expect(out.some((b) => b.confidence < 1)).toBe(true);
  });

  it('starts each bar at a real source minute, in order', () => {
    const out = bucketCoverage(bars(600));
    expect(out[0]!.minute).toBe(0);
    for (let i = 1; i < out.length; i++) expect(out[i]!.minute).toBeGreaterThan(out[i - 1]!.minute);
  });

  it('handles an empty strip and a silly limit without throwing', () => {
    expect(bucketCoverage([])).toEqual([]);
    expect(bucketCoverage(bars(10), 0)).toEqual([]);
    expect(bucketCoverage(bars(10), 1)).toHaveLength(1);
  });
});
