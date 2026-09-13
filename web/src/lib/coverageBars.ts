/** One bar of the alignment coverage strip. */
export interface CoverageBar {
  /** Audio minute this bar starts at. */
  minute: number;
  /** 0–1 alignment confidence across the span the bar covers. */
  confidence: number;
  /** How many source minutes this bar stands for (1 unless downsampled). */
  minutes: number;
}

/**
 * The strip is drawn one bar per minute of audio, straight from the server.
 *
 * A ten-hour audiobook is six hundred of them. Each bar needs a pixel or two
 * plus a gap, so the strip grew to roughly 2,400px inside a 309px card and
 * took the whole Pairing page with it — the reader could swipe the page two
 * thousand pixels sideways into empty space, dragging every other pair card
 * off screen. Nothing in the ancestor chain clipped it.
 *
 * Averaging neighbouring minutes into a fixed number of buckets keeps the
 * shape of the data — where the alignment is weak is still visible — while
 * making the strip's width independent of how long the book is.
 */
export const MAX_COVERAGE_BARS = 96;

export function bucketCoverage(
  bars: readonly { minute: number; confidence: number }[],
  max: number = MAX_COVERAGE_BARS,
): CoverageBar[] {
  if (max < 1) return [];
  if (bars.length <= max) {
    return bars.map((b) => ({ minute: b.minute, confidence: b.confidence, minutes: 1 }));
  }
  // Spread the remainder across the buckets instead of giving it all to the
  // last one, so no bar stands for a wildly longer stretch than its neighbours.
  const out: CoverageBar[] = [];
  for (let i = 0; i < max; i++) {
    const from = Math.floor((i * bars.length) / max);
    const to = Math.floor(((i + 1) * bars.length) / max);
    const slice = bars.slice(from, Math.max(to, from + 1));
    out.push({
      minute: slice[0]!.minute,
      confidence: slice.reduce((a, b) => a + b.confidence, 0) / slice.length,
      minutes: slice.length,
    });
  }
  return out;
}
