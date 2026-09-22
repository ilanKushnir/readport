/**
 * Boxes drawn over the text: the frame around a settled selection, the wash
 * on the sentence being spoken, the blink where the voice starts again.
 *
 * All three are the same thing underneath - a chapter span, its
 * `Range.getClientRects()`, and one rounded box per line - so the geometry
 * lives here, pure and tested, and the components only decide what to paint.
 * A range's rectangles come one per text-node fragment per line, in DOM
 * order; a line of prose with an emphasised word in it is three of them, and
 * a box drawn per fragment shows its seams. Merged per line they are the
 * line box the reader actually sees.
 */

export type Rect = { left: number; top: number; right: number; bottom: number };
export type LineBox = { left: number; top: number; width: number; height: number };

/**
 * Fragments of one line abut, or nearly: a hairline of rounding between two
 * text nodes is normal. The gap between two columns of a spread is tens of
 * pixels, and that is the gap that must never be bridged.
 */
const SEAM_PX = 6;

/**
 * Merge a range's rectangles into one box per line, in reading order.
 *
 * Two rectangles belong to the same line when they overlap vertically by
 * most of the shorter one - a superscript sits higher than the words beside
 * it and is still on their line - and sit within a seam of each other
 * horizontally. Rectangles outside `clip` (the page box, in paginated mode:
 * the next page's lines are real and invisible) are dropped, and the ones
 * that straddle its edge are cut to it.
 */
export function lineBoxes(rects: Iterable<Rect>, clip?: Rect | null): LineBox[] {
  const lines: Rect[] = [];
  for (const raw of rects) {
    const r = clip
      ? {
          left: Math.max(raw.left, clip.left),
          right: Math.min(raw.right, clip.right),
          top: Math.max(raw.top, clip.top),
          bottom: Math.min(raw.bottom, clip.bottom),
        }
      : raw;
    if (r.right - r.left <= 0 || r.bottom - r.top <= 0) continue;
    const line = lines.find((l) => {
      const overlap = Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top);
      const shorter = Math.min(l.bottom - l.top, r.bottom - r.top);
      return overlap > shorter * 0.5 && r.left <= l.right + SEAM_PX && r.right >= l.left - SEAM_PX;
    });
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ ...r });
    }
  }
  return lines.map((l) => ({
    left: l.left,
    top: l.top,
    width: l.right - l.left,
    height: l.bottom - l.top,
  }));
}

/**
 * Where a host's content begins, in viewport pixels: its box, less however
 * far it has scrolled. Boxes measured against this stay put while the host
 * scrolls, which is what lets them be drawn INSIDE it and move with the
 * text natively rather than chase it a frame behind.
 */
export function hostOrigin(host: {
  getBoundingClientRect: () => { left: number; top: number };
  scrollLeft: number;
  scrollTop: number;
}): { left: number; top: number } {
  const r = host.getBoundingClientRect();
  return { left: r.left - host.scrollLeft, top: r.top - host.scrollTop };
}

/** The same boxes, moved into a container's coordinate space. */
export function relativeTo(boxes: LineBox[], origin: { left: number; top: number }): LineBox[] {
  return boxes.map((b) => ({ ...b, left: b.left - origin.left, top: b.top - origin.top }));
}

/**
 * How much of a wash each line gets when the wash fades along the sentence.
 *
 * The blink is full at the first character and gone at the last, across the
 * whole sentence rather than restarting on every line - so each line's box
 * gets the stretch of that fade that its width covers. `from` and `to` are
 * the strength at the start and end of the line, in reading order; the
 * caller points the gradient in the reading direction.
 */
export function fadeAlong(boxes: LineBox[]): { from: number; to: number }[] {
  const total = boxes.reduce((sum, b) => sum + b.width, 0);
  if (total <= 0) return boxes.map(() => ({ from: 1, to: 0 }));
  let covered = 0;
  return boxes.map((b) => {
    const from = 1 - covered / total;
    covered += b.width;
    return { from, to: 1 - covered / total };
  });
}

/** Whether two sets of boxes are the same to the eye, so nothing is redrawn for nothing. */
export function sameBoxes(a: LineBox[] | null, b: LineBox[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return (
      Math.abs(x.left - y.left) < 0.5 &&
      Math.abs(x.top - y.top) < 0.5 &&
      Math.abs(x.width - y.width) < 0.5 &&
      Math.abs(x.height - y.height) < 0.5
    );
  });
}

/**
 * One outline around a run of lines, rather than a box per line.
 *
 * A selection is one thing to the eye, and a border between its lines
 * says otherwise. The lines of one column stack top to bottom, each with
 * its own left and right; the outline runs down the right-hand edges,
 * stepping sideways between lines, back along the bottom, and up the
 * left-hand edges - a rectilinear polygon, corners softened by the stroke
 * that draws it. Lines that jump upward begin another run, which is what
 * the second column of a spread looks like, and get an outline of their own.
 */
export function outlineRuns(boxes: LineBox[]): LineBox[][] {
  const runs: LineBox[][] = [];
  for (const b of boxes) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    // A next line sits below the last one (or beside it, on a spread's
    // seam); one that sits above it is another column.
    if (run && prev && b.top >= prev.top - 2) run.push(b);
    else runs.push([b]);
  }
  return runs;
}

/** The SVG path of one run's outline, in the boxes' own pixels. */
export function outlinePath(run: LineBox[], inset = 0): string {
  if (run.length === 0) return '';
  const l = (b: LineBox) => b.left - inset;
  const r = (b: LineBox) => b.left + b.width + inset;
  const t = (b: LineBox) => b.top - inset;
  const btm = (b: LineBox) => b.top + b.height + inset;
  const pts: [number, number][] = [];
  const first = run[0]!;
  pts.push([l(first), t(first)], [r(first), t(first)]);
  // Down the right-hand side, stepping at each line's seam to the next
  // line's right edge; the seam is drawn where the two lines meet.
  for (let i = 0; i < run.length; i++) {
    const b = run[i]!;
    const next = run[i + 1];
    const y = next ? (btm(b) + t(next)) / 2 : btm(b);
    pts.push([r(b), y]);
    if (next) pts.push([r(next), y]);
  }
  const last = run[run.length - 1]!;
  pts.push([l(last), btm(last)]);
  // And up the left-hand side.
  for (let i = run.length - 1; i >= 0; i--) {
    const b = run[i]!;
    const prev = run[i - 1];
    const y = prev ? (btm(prev) + t(b)) / 2 : t(b);
    pts.push([l(b), y]);
    if (prev) pts.push([l(prev), y]);
  }
  const n = (v: number) => Math.round(v * 2) / 2;
  return pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n(x)} ${n(y)}`).join(' ') + ' Z';
}
