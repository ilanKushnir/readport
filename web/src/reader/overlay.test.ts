import { describe, expect, it } from 'vitest';
import { fadeAlong, lineBoxes, outlinePath, outlineRuns, relativeTo, sameBoxes } from './overlay';

const rect = (left: number, top: number, width = 100, height = 24) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe('lineBoxes', () => {
  it('merges the fragments of one line and keeps separate lines apart', () => {
    const boxes = lineBoxes([rect(20, 100, 80), rect(100, 100, 60), rect(20, 130, 200)]);
    expect(boxes).toEqual([
      { left: 20, top: 100, width: 140, height: 24 },
      { left: 20, top: 130, width: 200, height: 24 },
    ]);
  });
  it('keeps a superscript on the line of the words beside it', () => {
    const boxes = lineBoxes([rect(20, 100, 80), rect(100, 94, 8, 14), rect(108, 100, 40)]);
    expect(boxes).toEqual([{ left: 20, top: 94, width: 128, height: 30 }]);
  });
  it('never bridges the gutter between two columns', () => {
    const boxes = lineBoxes([rect(20, 100, 300), rect(400, 100, 300)]);
    expect(boxes).toHaveLength(2);
  });
  it('drops rectangles beyond the page box and cuts the ones on its edge', () => {
    const clip = { left: 0, right: 500, top: 0, bottom: 800 };
    const boxes = lineBoxes([rect(20, 100, 300), rect(320, 100, 300), rect(700, 130, 100)], clip);
    expect(boxes).toEqual([{ left: 20, top: 100, width: 480, height: 24 }]);
  });
  it('ignores empty rectangles', () => {
    expect(lineBoxes([rect(20, 100, 0), rect(20, 100, 10, 0)])).toEqual([]);
  });
});

describe('relativeTo', () => {
  it('moves boxes into the container', () => {
    expect(relativeTo([{ left: 50, top: 60, width: 1, height: 2 }], { left: 10, top: 20 })).toEqual(
      [{ left: 40, top: 40, width: 1, height: 2 }],
    );
  });
});

describe('fadeAlong', () => {
  it('spreads one fade across the lines of a sentence by width', () => {
    const stops = fadeAlong([
      { left: 0, top: 0, width: 300, height: 20 },
      { left: 0, top: 20, width: 100, height: 20 },
    ]);
    expect(stops[0]).toEqual({ from: 1, to: 0.25 });
    expect(stops[1]).toEqual({ from: 0.25, to: 0 });
  });
  it('gives a widthless sentence a full-to-nothing fade rather than a division by zero', () => {
    expect(fadeAlong([{ left: 0, top: 0, width: 0, height: 20 }])).toEqual([{ from: 1, to: 0 }]);
  });
});

describe('sameBoxes', () => {
  const a = [{ left: 1, top: 2, width: 3, height: 4 }];
  it('treats sub-pixel jitter as the same picture', () => {
    expect(sameBoxes(a, [{ left: 1.2, top: 2, width: 3, height: 4.3 }])).toBe(true);
    expect(sameBoxes(a, [{ left: 2, top: 2, width: 3, height: 4 }])).toBe(false);
    expect(sameBoxes(a, null)).toBe(false);
    expect(sameBoxes(null, null)).toBe(true);
  });
});

describe('outlineRuns', () => {
  it('keeps lines that stack downward in one run and starts another at a column jump', () => {
    const a = { left: 10, top: 0, width: 100, height: 20 };
    const b = { left: 10, top: 20, width: 60, height: 20 };
    const c = { left: 200, top: 0, width: 100, height: 20 };
    expect(outlineRuns([a, b, c])).toEqual([[a, b], [c]]);
  });
});

describe('outlinePath', () => {
  it('draws one closed polygon around a run, stepping at the seams', () => {
    const d = outlinePath([
      { left: 10, top: 0, width: 100, height: 20 },
      { left: 10, top: 20, width: 60, height: 20 },
    ]);
    expect(d).toBe('M10 0 L110 0 L110 20 L70 20 L70 40 L10 40 L10 20 L10 20 L10 0 Z');
  });
  it('is empty for no lines', () => {
    expect(outlinePath([])).toBe('');
  });
});
