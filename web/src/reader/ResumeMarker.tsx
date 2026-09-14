import { useEffect, useState } from 'react';
import { rangeForSpan, type TextMap } from './textmap';
import { type ReadingPoint } from './continuity';
import './continuity.css';

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
      const range = rangeForSpan(m, target.charOffset, target.charOffset + 24);
      const r = range?.getClientRects()[0];
      const b = box.getBoundingClientRect();
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
      aria-label="Your resumed reading position"
    />
  ) : null;
}
