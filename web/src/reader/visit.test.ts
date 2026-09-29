import { describe, expect, it } from 'vitest';
import { SETTLE_CHARS, SETTLE_MS, SETTLE_SLOW_MS, beginVisit, settles } from './visit';

const place = { spineIdx: 2, charOffset: 400, label: 'The Second Tide' };

describe('a look', () => {
  it('stays a look while the reader only reads the passage they were sent', () => {
    const v = beginVisit(null, place, 250_000, 0);
    expect(settles(v, 250_300, 20_000)).toBe(false);
    expect(settles(v, 250_600, 40_000)).toBe(false);
  });

  it('is reading once the reader has read on a couple of pages, over half a minute', () => {
    const v = beginVisit(null, place, 250_000, 0);
    expect(settles(v, 250_000 + SETTLE_CHARS, 10_000)).toBe(false);
    expect(settles(v, 250_000 + SETTLE_CHARS, SETTLE_MS)).toBe(true);
  });

  it('is reading when one dense page has held the reader a minute and a half', () => {
    const v = beginVisit(null, place, 250_000, 0);
    expect(settles(v, 250_200, SETTLE_SLOW_MS)).toBe(true);
  });

  it('does not count going back, only on', () => {
    const v = beginVisit(null, place, 250_000, 0);
    expect(settles(v, 249_000, SETTLE_SLOW_MS)).toBe(false);
  });

  it('keeps the reader’s place across a second jump, and starts counting again', () => {
    const first = beginVisit(null, place, 250_000, 0);
    const second = beginVisit(
      first,
      { spineIdx: 9, charOffset: 0, label: 'Elsewhere' },
      400_000,
      50_000,
    );
    expect(second.from).toBe(place);
    expect(settles(second, 400_000 + SETTLE_CHARS, 60_000)).toBe(false);
  });
});
