import { describe, expect, it } from 'vitest';
import {
  placeSelectionToolbar,
  selectionGeometry,
  type PlacementInput,
} from './selectionPlacement';
const rect = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});
const input = (overrides: Partial<PlacementInput> = {}): PlacementInput => ({
  selection: selectionGeometry([rect(200, 300, 420, 330)], 'ltr')!,
  viewport: rect(0, 0, 1024, 768),
  toolbar: { width: 320, height: 52 },
  topBoundary: 64,
  bottomBoundary: 650,
  coarse: true,
  previous: null,
  ...overrides,
});
describe('selection toolbar placement', () => {
  it('copies DOMRect prototype accessors rather than spreading enumerable fields', () => {
    const domRect = Object.create({ left: 200, top: 300, right: 420, bottom: 330 });
    expect(
      placeSelectionToolbar(input({ selection: selectionGeometry([domRect], 'ltr')! })),
    ).toEqual({ mode: 'below', left: 150, top: 344 });
  });
  it('leaves a 14px handle gap below a short coarse selection', () => {
    expect(placeSelectionToolbar(input())).toEqual({ mode: 'below', left: 150, top: 344 });
  });
  it('anchors multiline to the final logical visual line, not the union centre', () => {
    const selection = selectionGeometry(
      [rect(100, 200, 800, 230), rect(100, 240, 800, 270), rect(100, 280, 240, 310)],
      'ltr',
    )!;
    expect(placeSelectionToolbar(input({ selection }))).toEqual({
      mode: 'below',
      left: 10,
      top: 324,
    });
  });
  it('merges inline fragments of the final line without merging other columns', () => {
    const selection = selectionGeometry(
      [rect(100, 200, 800, 230), rect(100, 240, 200, 270), rect(200, 241, 280, 269)],
      'ltr',
    )!;
    expect(selection.last).toEqual(rect(100, 240, 280, 270));
    const columns = selectionGeometry([rect(100, 600, 400, 630), rect(600, 100, 750, 130)], 'ltr')!;
    expect(columns.last).toEqual(rect(600, 100, 750, 130));
  });
  it('uses range document order for forward/backward selection and RTL bidi runs', () => {
    // Range order is normalized by the DOM, independent of anchor/focus direction.
    const selection = selectionGeometry(
      [rect(400, 200, 800, 230), rect(600, 240, 800, 270), rect(560, 240, 600, 270)],
      'rtl',
    )!;
    expect(selection.last).toEqual(rect(560, 240, 800, 270));
    expect(placeSelectionToolbar(input({ selection }))).toEqual({
      mode: 'below',
      left: 520,
      top: 284,
    });
  });
  it.each([
    [-30, 30, 8],
    [990, 1020, 696],
  ])('clamps measured width at an edge %s', (left, right, expected) => {
    expect(
      placeSelectionToolbar(
        input({ selection: selectionGeometry([rect(left, 300, right, 330)], 'ltr')! }),
      )?.left,
    ).toBe(expected);
  });
  it('uses offset/zoomed visual viewport and measured chrome boundaries', () => {
    const p = placeSelectionToolbar(
      input({
        viewport: rect(130, 160, 730, 660),
        topBoundary: 64,
        bottomBoundary: 700,
        selection: selectionGeometry([rect(650, 300, 710, 330)], 'ltr')!,
      }),
    );
    expect(p).toEqual({ mode: 'below', left: 402, top: 344 });
  });
  it('docks beside the final line above Read Along without touching text or handles', () => {
    const p = placeSelectionToolbar(
      input({
        selection: selectionGeometry([rect(50, 540, 350, 570), rect(50, 580, 350, 610)], 'ltr')!,
        bottomBoundary: 650,
      }),
    );
    expect(p).toEqual({ mode: 'dock', left: 366, top: 590 });
  });
  it('preserves handle clearance at the 44px portrait dock boundary', () => {
    const nearBottom = (bottom: number) =>
      input({
        viewport: rect(0, 0, 820, 1180),
        toolbar: { width: 400, height: 44 },
        bottomBoundary: 994,
        selection: selectionGeometry(
          [rect(24, bottom - 71, 788, bottom - 42), rect(24, bottom - 29, 577, bottom)],
          'ltr',
        )!,
      });
    // The former 40px dock fitted at 932.48. A 44px target cannot fit
    // there without violating handle clearance; never weaken that exclusion.
    expect(placeSelectionToolbar(nearBottom(932.48))).toBeNull();
    expect(placeSelectionToolbar(nearBottom(928.48))).toEqual({
      mode: 'dock',
      left: 210,
      top: 942,
    });
  });
  it('retains safe dock mode across small geometry changes', () => {
    const p = placeSelectionToolbar(input({ previous: 'dock' }));
    expect(p?.mode).toBe('dock');
    expect(placeSelectionToolbar(input({ previous: 'dock', bottomBoundary: 651 }))?.mode).toBe(
      'dock',
    );
  });
  it('fine pointers prefer above, then below when top chrome excludes above', () => {
    expect(placeSelectionToolbar(input({ coarse: false }))).toEqual({
      mode: 'above',
      left: 150,
      top: 234,
    });
    expect(placeSelectionToolbar(input({ coarse: false, topBoundary: 280 }))?.mode).toBe('below');
  });
  it('never flips coarse pointers above when dock is completely occupied', () => {
    const p = placeSelectionToolbar(
      input({ selection: selectionGeometry([rect(0, 100, 1024, 640)], 'ltr')! }),
    );
    expect(p).toBeNull();
  });
  it('ignores zero area rects and refuses empty or offscreen selections', () => {
    expect(selectionGeometry([rect(0, 0, 0, 0)], 'ltr')).toBeNull();
    expect(
      placeSelectionToolbar(
        input({ selection: selectionGeometry([rect(1100, 300, 1400, 330)], 'ltr')! }),
      ),
    ).toBeNull();
  });
});
