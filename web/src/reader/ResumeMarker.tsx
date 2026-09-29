import { useLayoutEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { rangeForSpan, wordEdge, type TextMap } from './textmap';
import {
  fadeAlong,
  hostOrigin,
  lineBoxes,
  relativeTo,
  sameBoxes,
  type LineBox,
  type Rect,
} from './overlay';
import { pageTurning } from './LineOverlay';
import { resumeSpans, type ReadingPoint, type TextSpan } from './continuity';
import './continuity.css';

/** The ember beside the line: how wide it is, and how far out from the text. */
const TICK_W = 3;
const TICK_GAP = 9;
/**
 * How much of the sentence is lit, in column widths: about a line from where
 * it starts, and never more than two lines. A glow that ran the length of a
 * long sentence read as a highlight the reader had made.
 */
const LIGHT_LINES = 0.6;
const LIGHT_MAX_LINES = 2;

interface Drawn {
  start: number;
  boxes: LineBox[];
  stops: { from: number; to: number }[];
  tick: { left: number; top: number; height: number } | null;
  rtl: boolean;
}

/**
 * Where the reader left off: the sentence they were in, lit from its first
 * word and gone by the end of about a line, and a short ember in the margin
 * beside the line it begins on - the eye finds the line before the word.
 *
 * A place is kept to the character, and the marker used to begin exactly
 * there: a bar and a dotted rule dropped into the middle of a word. It now
 * begins where reading picks up, the start of the sentence (see
 * `resumeSpans`), or the start of the word when that sentence began on the
 * page before. The place itself is untouched; `data-offset` still says it.
 */
export function ResumeMarker({
  target,
  sentences,
  map,
  container,
  clip,
  scroller,
  content,
  layoutKey,
}: {
  target: ReadingPoint & { opacity: number };
  /** The chapter's sentence index; empty for a book that has none. */
  sentences: readonly TextSpan[];
  map: () => TextMap | null;
  /** The box the text moves in - the scroller, or the page box. */
  container: () => HTMLElement | null;
  /** The box the lines are cut to: the page box, or the scroller's window. */
  clip: () => Rect | null;
  scroller: () => HTMLElement | null;
  /** The element a page turn moves; nothing is drawn while it is moving. */
  content: () => HTMLElement | null;
  layoutKey: string;
}) {
  const t = useT();
  const [drawn, setDrawn] = useState<Drawn | null>(null);

  // What may be lit, best first. The chapter's map is rebuilt with every
  // load, which `layoutKey` follows.
  const spans = useMemo(() => {
    const m = map();
    if (!m) return [];
    return resumeSpans(sentences, target.charOffset, {
      start: (at) => wordEdge(m, at, 'start'),
      end: (at) => wordEdge(m, at, 'end'),
    });
  }, [sentences, target.charOffset, map, layoutKey]);

  useLayoutEffect(() => {
    let raf = 0;
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const m = map();
      const box = container();
      const el = content();
      if (!m || !box || spans.length === 0 || (el && pageTurning(el))) {
        setDrawn(null);
        return;
      }
      const cut = clip();
      // A page box shows one page: a span is drawn only if it begins on it.
      // A scrolling host keeps the first choice, scrolled away or not - the
      // landing put its first line in view.
      const scrolls = box.scrollHeight > box.clientHeight + 1;
      const span = scrolls ? spans[0]! : spans.find((s) => beginsInside(m, s.start, cut));
      const range = span ? rangeForSpan(m, span.start, span.end) : null;
      if (!span || !range) {
        setDrawn(null);
        return;
      }
      const all = lineBoxes(range.getClientRects(), cut);
      if (all.length === 0) {
        setDrawn(null);
        return;
      }
      const origin = hostOrigin(box);
      const edge = columnEdge(range, el, all[0]!);
      // About a line's worth from the start: the first line of the sentence,
      // and the next as well when the sentence begins near a line's end.
      const lines: LineBox[] = [];
      let lit = 0;
      for (const line of all) {
        lines.push(line);
        lit += line.width;
        if (!edge || lit >= edge.width * LIGHT_LINES || lines.length >= LIGHT_MAX_LINES) break;
      }
      const rtl = edge?.rtl ?? false;
      let tick: Drawn['tick'] = null;
      if (edge) {
        const first = lines[0]!;
        const room = rtl
          ? box.getBoundingClientRect().right - edge.x
          : edge.x - box.getBoundingClientRect().left;
        // In a margin too narrow for it, the wash says enough on its own.
        if (room >= TICK_W + 4) {
          const gap = Math.min(TICK_GAP, (room - TICK_W) / 2);
          const height = Math.max(8, first.height * 0.78);
          tick = {
            left: (rtl ? edge.x + gap : edge.x - gap - TICK_W) - origin.left,
            top: first.top + (first.height - height) / 2 - origin.top,
            height,
          };
        }
      }
      const boxes = relativeTo(lines, origin);
      setDrawn((prev) =>
        prev &&
        prev.start === span.start &&
        prev.rtl === rtl &&
        sameBoxes(prev.boxes, boxes) &&
        sameTick(prev.tick, tick)
          ? prev
          : { start: span.start, boxes, stops: fadeAlong(boxes), tick, rtl },
      );
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
    // A turn in flight hides the marker; its end measures it where it lands.
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
  }, [spans, map, container, clip, scroller, content, layoutKey]);

  if (!drawn) return null;
  return (
    <div
      className="line-overlay resume-marker"
      data-offset={target.charOffset}
      data-start={drawn.start}
      data-rtl={drawn.rtl ? '' : undefined}
      style={{ opacity: target.opacity }}
      role="note"
      aria-label={t('reader.resumeMarker')}
    >
      {drawn.boxes.map((b, i) => (
        <span
          key={i}
          style={
            {
              left: b.left,
              top: b.top,
              width: b.width,
              height: b.height,
              '--rd-fade-from': drawn.stops[i]!.from,
              '--rd-fade-to': drawn.stops[i]!.to,
            } as React.CSSProperties
          }
        />
      ))}
      {drawn.tick && (
        <i
          className="resume-marker__tick"
          style={{ left: drawn.tick.left, top: drawn.tick.top, height: drawn.tick.height }}
        />
      )}
    </div>
  );
}

/** Whether a span's first character is inside the box shown - on this page, not the last one. */
function beginsInside(map: TextMap, start: number, cut: Rect | null): boolean {
  const range = rangeForSpan(map, start, start + 1);
  const r = range ? [...range.getClientRects()].find((x) => x.width > 0 && x.height > 0) : null;
  if (!r) return false;
  if (!cut) return true;
  const x = (r.left + r.right) / 2;
  const y = (r.top + r.bottom) / 2;
  return x >= cut.left && x <= cut.right && y >= cut.top && y <= cut.bottom;
}

/**
 * The edge of the column the marked line sits in, on the side reading starts
 * from: the block the span begins in, in the fragment of it (a paragraph
 * split across two pages has two) that holds the line. Null for text that
 * sits in no block of its own.
 */
function columnEdge(
  range: Range,
  root: HTMLElement | null,
  line: LineBox,
): { x: number; width: number; rtl: boolean } | null {
  let block: Element | null =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  while (block && block !== root && getComputedStyle(block).display.startsWith('inline'))
    block = block.parentElement;
  if (!block || block === root) return null;
  const mid = line.top + line.height / 2;
  const frags = [...block.getClientRects()];
  const frag = frags.find((r) => r.top <= mid && r.bottom >= mid) ?? null;
  if (!frag) return null;
  const rtl = getComputedStyle(block).direction === 'rtl';
  return { x: rtl ? frag.right : frag.left, width: frag.width, rtl };
}

function sameTick(a: Drawn['tick'], b: Drawn['tick']): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}
