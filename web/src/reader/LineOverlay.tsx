import { useLayoutEffect, useState } from 'react';
import { rangeForSpan, type TextMap } from './textmap';
import {
  fadeAlong,
  hostOrigin,
  lineBoxes,
  relativeTo,
  sameBoxes,
  type LineBox,
  type Rect,
} from './overlay';

/**
 * Boxes over the lines of a chapter span, kept in step with the text.
 *
 * The sentence being spoken and the blink where the voice starts again are
 * both this: a span, measured into one box per line in the viewport's own
 * coordinates, and measured again whenever the text can have moved - a
 * scroll, a relayout, a font arriving, a page turning. It draws nothing
 * while a page is mid-turn, because boxes measured against a sliding page
 * are right for one frame and wrong for the rest.
 *
 * Positioned from `Range.getClientRects()` at draw time rather than from a
 * rectangle remembered earlier, which is what used to put the mark on the
 * wrong line: a rectangle is only true of the layout it was measured in.
 */
export function LineOverlay({
  span,
  map,
  container,
  clip,
  scroller,
  content,
  layoutKey,
  className,
  fade = false,
  data,
}: {
  /** Chapter character span to draw. */
  span: { start: number; end: number };
  map: () => TextMap | null;
  /** The element the boxes are positioned in: the scrolling host, so they scroll with the text. */
  container: () => HTMLElement | null;
  /** The box the lines are cut to: the page box, or the scroller's window. */
  clip: () => Rect | null;
  /** The scrolling element, when there is one, so the boxes follow the text. */
  scroller: () => HTMLElement | null;
  /** The element a page turn moves; nothing is drawn while it is moving. */
  content: () => HTMLElement | null;
  /** Anything that can move the text without any of the above noticing. */
  layoutKey: string;
  className: string;
  /** Fade the wash along the span, from its first character to its last. */
  fade?: boolean;
  /** Data attributes for the stylesheet and for tests. */
  data?: Record<string, string | undefined>;
}) {
  const [boxes, setBoxes] = useState<LineBox[] | null>(null);

  useLayoutEffect(() => {
    let raf = 0;
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const m = map();
      const box = container();
      const el = content();
      const range = m && box ? rangeForSpan(m, span.start, span.end) : null;
      if (!range || !box || (el && pageTurning(el))) {
        setBoxes(null);
        return;
      }
      // Against the host's content origin: drawn inside a scrolling host,
      // the boxes then move with the text and never lag it.
      const next = relativeTo(lineBoxes(range.getClientRects(), clip()), hostOrigin(box));
      setBoxes((prev) => (sameBoxes(prev, next) ? prev : next.length > 0 ? next : null));
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    measure();
    const observer = new ResizeObserver(schedule);
    const box = container();
    if (box) observer.observe(box);
    const scroll = scroller();
    scroll?.addEventListener('scroll', schedule, { passive: true });
    const el = content();
    // A turn in flight hides the boxes; its end measures them where they land.
    el?.addEventListener('transitionrun', measure);
    el?.addEventListener('transitionend', measure);
    el?.addEventListener('transitioncancel', measure);
    void document.fonts?.ready.then(schedule);
    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      scroll?.removeEventListener('scroll', schedule);
      el?.removeEventListener('transitionrun', measure);
      el?.removeEventListener('transitionend', measure);
      el?.removeEventListener('transitioncancel', measure);
    };
  }, [span.start, span.end, map, container, clip, scroller, content, layoutKey]);

  if (!boxes) return null;
  const stops = fade ? fadeAlong(boxes) : null;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) if (v !== undefined) attrs[`data-${k}`] = v;
  return (
    <div className={`line-overlay ${className}`} aria-hidden="true" {...attrs}>
      {boxes.map((b, i) => (
        <span
          key={i}
          data-first={i === 0 ? '' : undefined}
          data-last={i === boxes.length - 1 ? '' : undefined}
          style={
            {
              left: b.left,
              top: b.top,
              width: b.width,
              height: b.height,
              ...(stops ? { '--rd-fade-from': stops[i]!.from, '--rd-fade-to': stops[i]!.to } : {}),
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

/**
 * Whether a page turn is still travelling: the transform the style asks for
 * is not yet the one being rendered. True for the whole of a slide and for
 * none of an instant turn.
 */
export function pageTurning(el: HTMLElement): boolean {
  const asked = /translateX\((-?[\d.]+)px\)/.exec(el.style.transform);
  if (!asked) return false;
  const shown = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform);
  const tx = shown ? parseFloat(shown[1]!.split(',')[4] ?? '0') : 0;
  return Math.abs(parseFloat(asked[1]!) - tx) > 0.5;
}
