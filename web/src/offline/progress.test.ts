import { describe, expect, it } from 'vitest';
import { downloadFraction, downloadPercent } from './downloads';

/**
 * Why progress is measured in bytes.
 *
 * A downloaded audiobook is a handful of very large files. Counting finished
 * URLs leaves the bar on zero for the whole of the first track - minutes, over
 * a phone connection - and then jumps it to a third. `storedBytes` is written
 * once per 8 MB chunk, so it actually moves while you watch it.
 */

const state = (o: Partial<Parameters<typeof downloadFraction>[0]>) => ({
  storedBytes: 0,
  estimatedBytes: 0,
  doneUrls: 0,
  totalUrls: 0,
  ...o,
});

describe('downloadFraction', () => {
  it('moves partway through a single huge file', () => {
    // Three 100 MB tracks, one third of the first one done. By URL count this
    // is still 0%.
    const dl = state({ storedBytes: 33_000_000, estimatedBytes: 300_000_000, totalUrls: 3 });
    expect(downloadPercent(dl)).toBe(11);
  });

  it('falls back to file count before the size is known', () => {
    // The manifest has not been read yet, so there is no byte total to divide
    // by; the file count is better than showing nothing.
    expect(downloadPercent(state({ doneUrls: 1, totalUrls: 4 }))).toBe(25);
  });

  it('reports zero when it knows nothing at all', () => {
    expect(downloadFraction(state({}))).toBe(0);
  });

  it('never exceeds 100% when more arrives than was estimated', () => {
    // The estimate is the server's; a re-encoded or resumed file can overshoot
    // it, and a bar past its own end looks broken.
    const dl = state({ storedBytes: 120, estimatedBytes: 100, totalUrls: 1 });
    expect(downloadFraction(dl)).toBe(1);
    expect(downloadPercent(dl)).toBe(100);
  });

  it('reads 100% exactly when the last byte lands', () => {
    expect(downloadPercent(state({ storedBytes: 500, estimatedBytes: 500, totalUrls: 2 }))).toBe(
      100,
    );
  });

  it('prefers bytes over the file count when it has both', () => {
    // Two of three files done but only a tenth of the bytes: report the tenth.
    const dl = state({
      storedBytes: 10,
      estimatedBytes: 100,
      doneUrls: 2,
      totalUrls: 3,
    });
    expect(downloadPercent(dl)).toBe(10);
  });

  it('survives a zero-byte estimate without dividing by zero', () => {
    const dl = state({ storedBytes: 0, estimatedBytes: 0, doneUrls: 0, totalUrls: 0 });
    expect(Number.isFinite(downloadFraction(dl))).toBe(true);
    expect(downloadPercent(dl)).toBe(0);
  });
});
