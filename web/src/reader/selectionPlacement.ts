export type Rect = { left: number; top: number; right: number; bottom: number };
export type SelectionGeometry = {
  rects: Rect[];
  first: Rect;
  last: Rect;
  direction: 'ltr' | 'rtl';
};
export type PlacementMode = 'above' | 'below' | 'dock';
export type PlacementInput = {
  selection: SelectionGeometry;
  viewport: Rect;
  toolbar: { width: number; height: number };
  topBoundary: number;
  bottomBoundary: number;
  coarse: boolean;
  previous: PlacementMode | null;
};
export type ToolbarPlacement = { mode: PlacementMode; left: number; top: number };
/** Room the touch platform's own edit menu takes, above or below a selection. */
export const NATIVE_MENU_HEIGHT = 96;
/** Half of how wide that menu is on a tablet, centred on the selection. */
export const NATIVE_MENU_HALF_WIDTH = 220;

/**
 * Only the parts of a selection that are actually on the page.
 *
 * In paginated mode a range can run on into the next column - the clipped
 * one beyond the page box - and its rectangles there are real, just not
 * visible. Placing the toolbar "below the last line" of a line nobody can
 * see put it under an invisible line.
 */
export function clipRects(rects: Rect[], box: Rect | null | undefined): Rect[] {
  if (!box) return rects;
  return rects
    .map((r) => ({
      left: Math.max(r.left, box.left),
      right: Math.min(r.right, box.right),
      top: Math.max(r.top, box.top),
      bottom: Math.min(r.bottom, box.bottom),
    }))
    .filter((r) => r.right > r.left && r.bottom > r.top);
}
export function selectionGeometry(
  rects: Rect[],
  direction: 'ltr' | 'rtl',
): SelectionGeometry | null {
  const visible = rects
    .filter((r) => r.right > r.left && r.bottom > r.top)
    .map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
  if (!visible.length) return null;
  // Range rects are in DOM order, even when Selection anchor/focus are backward.
  // Merge adjacent bidi/inline runs, not the union of a multiline selection or
  // two page columns. The final range line is not necessarily lowest on screen.
  const lineAt = (index: number, step: number): Rect => {
    let line = { ...visible[index]! };
    for (let i = index + step; i >= 0 && i < visible.length; i += step) {
      const r = visible[i]!;
      if (
        Math.abs(r.top - line.top) > 3 ||
        Math.abs(r.bottom - line.bottom) > 3 ||
        r.left > line.right + 3 ||
        r.right < line.left - 3
      )
        break;
      line = {
        left: Math.min(line.left, r.left),
        right: Math.max(line.right, r.right),
        top: Math.min(line.top, r.top),
        bottom: Math.max(line.bottom, r.bottom),
      };
    }
    return line;
  };
  return { rects: visible, first: lineAt(0, 1), last: lineAt(visible.length - 1, -1), direction };
}
export function placeSelectionToolbar(input: PlacementInput): ToolbarPlacement | null {
  const {
    selection: s,
    viewport: v,
    toolbar: { width, height },
    coarse,
    previous,
  } = input;
  const left = v.left + 8;
  const right = v.right - 8;
  const top = Math.max(v.top, input.topBoundary) + 8;
  const bottom = Math.min(v.bottom, input.bottomBoundary) - 8;
  const intersects = (a: Rect, b: Rect) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  if (
    width <= 0 ||
    height <= 0 ||
    width > right - left ||
    height > bottom - top ||
    !s.rects.some((r) => intersects(r, v))
  )
    return null;
  const clamp = (x: number) => Math.max(left, Math.min(x, right - width));
  const exclusions = s.rects.map((r) => ({
    left: r.left - 16,
    right: r.right + 16,
    top: r.top - 12,
    bottom: r.bottom + 12,
  }));
  // The native edit menu on a touch screen. iOS centres it on the whole
  // selection's box - a menu of three to five items is 300-450pt wide
  // whatever the selected word is - and puts it above the first line, or
  // BELOW the last line when the first line is too close to the top of the
  // visible screen for it to fit above. Both places are kept clear, and
  // when the menu is below, "below" is not offered at all.
  const union = s.rects.reduce(
    (u, r) => ({
      left: Math.min(u.left, r.left),
      right: Math.max(u.right, r.right),
      top: Math.min(u.top, r.top),
      bottom: Math.max(u.bottom, r.bottom),
    }),
    { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
  );
  const menuCentre = (union.left + union.right) / 2;
  const nativeMenuBelow = coarse && s.first.top - top < NATIVE_MENU_HEIGHT + 14;
  if (coarse) {
    const band = {
      left: Math.min(s.first.left - 24, menuCentre - NATIVE_MENU_HALF_WIDTH),
      right: Math.max(s.first.right + 24, menuCentre + NATIVE_MENU_HALF_WIDTH),
    };
    exclusions.push(
      nativeMenuBelow
        ? { ...band, top: s.last.bottom, bottom: s.last.bottom + NATIVE_MENU_HEIGHT }
        : { ...band, top: s.first.top - NATIVE_MENU_HEIGHT, bottom: s.first.top },
    );
  }
  const safe = (x: number, y: number) =>
    y >= top &&
    y + height <= bottom &&
    !exclusions.some((r) =>
      intersects({ left: x, right: x + width, top: y, bottom: y + height }, r),
    );
  const below = {
    mode: 'below' as const,
    left: clamp((s.last.left + s.last.right - width) / 2),
    top: s.last.bottom + 14,
  };
  const above = {
    mode: 'above' as const,
    left: clamp((s.first.left + s.first.right - width) / 2),
    top: s.first.top - height - 14,
  };
  // Once docked, stay docked through handle jitter and chrome/viewport changes.
  // Reset only when the native selection clears; no floating/docked oscillation.
  if (previous !== 'dock') {
    const order = coarse ? (nativeMenuBelow ? [] : [below]) : [above, below];
    for (const p of order) if (safe(p.left, p.top)) return p;
  }
  const dockTop = bottom - height;
  const center = clamp((v.left + v.right - width) / 2);
  const candidates = [
    center,
    left,
    right - width,
    ...exclusions.flatMap((r) => [clamp(r.left - width), clamp(r.right)]),
  ];
  candidates.sort(
    (a, b) =>
      Math.abs(a - center) - Math.abs(b - center) || (s.direction === 'rtl' ? b - a : a - b),
  );
  for (const x of candidates) if (safe(x, dockTop)) return { mode: 'dock', left: x, top: dockTop };
  // A selection can fill the entire available viewport. Never obscure it or
  // suppress the native menu to force an impossible fit; the adapter can offer
  // a smaller measured dock before leaving the custom toolbar hidden.
  return null;
}
