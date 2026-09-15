import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { offsetToDom, rangeForSpan, type TextMap } from './textmap';
import { type ReadingPoint } from './continuity';
import './continuity.css';

/**
 * The line box of the resumed character, never the block around it.
 *
 * A span that runs from a chapter's first character into the next paragraph
 * selects the heading whole, and the first rectangle of such a range is the
 * heading's box - the full column width, underlined edge to edge. So the
 * span is kept inside the text node the character sits in, and a rectangle
 * as wide as the column is skipped in favour of the first one that is not.
 */
function markerRect(map: TextMap, offset: number, columnWidth: number): DOMRect | null {
  const at = offsetToDom(map, offset);
  if (!at) return null;
  const same = document.createRange();
  same.setStart(at.node, at.offset);
  same.setEnd(at.node, Math.min(at.node.data.length, at.offset + 24));
  const rects = [...same.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (rects.length > 0) return rects[0]!;
  // The character is the last in its node: span onward, but not a whole block.
  const onward = rangeForSpan(map, offset, offset + 24);
  if (!onward) return null;
  const line = [...onward.getClientRects()].filter(
    (r) => r.width > 0 && r.height > 0 && r.width < columnWidth - 1,
  );
  return line[0] ?? onward.getClientRects()[0] ?? null;
}

/** An underline at the exact resumed character, not a stored annotation. */
export function ResumeMarker({
  target,
  map,
  container,
  scroller,
  layoutKey,
}: {
  target: ReadingPoint & { opacity: number };
  map: () => TextMap | null;
  container: () => HTMLElement | null;
  scroller: () => HTMLElement | null;
  layoutKey: string;
}) {
  const t = useT();
  const [rect, setRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  useEffect(() => {
    const measure = () => {
      const m = map();
      const box = container();
      if (!m || !box) return;
      const b = box.getBoundingClientRect();
      const r = markerRect(m, target.charOffset, b.width);
      if (!r || r.bottom < b.top || r.top > b.bottom || r.right < b.left || r.left > b.right) {
        setRect(null);
        return;
      }
      setRect({
        left: r.left - b.left,
        top: r.top - b.top,
        width: Math.max(8, r.width),
        height: r.height,
      });
    };
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    const box = container();
    if (box) observer.observe(box);
    const scroll = scroller();
    scroll?.addEventListener('scroll', measure, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroll?.removeEventListener('scroll', measure);
    };
  }, [target.charOffset, map, container, scroller, layoutKey]);
  return rect ? (
    <span
      className="resume-marker"
      data-offset={target.charOffset}
      style={{ ...rect, opacity: target.opacity }}
      role="note"
      aria-label={t('reader.resumeMarker')}
    />
  ) : null;
}
