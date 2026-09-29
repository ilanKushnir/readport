import { useLayoutEffect, useRef, useState } from 'react';
import { type LineBox, lineBoxes, relativeTo } from './overlay';
import { type ReaderPrefs, type ReaderTheme, readerTypeVars } from './prefs';
import { type TextMap, buildTextMap, offsetToDom, rangeForSpan, wordEdge } from './textmap';

/** About how much of the chapter the preview takes: a few lines at any size. */
const SAMPLE_CHARS = 480;

/** The words the preview shows, and which of them the voice is on. */
export interface PreviewSample {
  /** Cloned from the page, with the book's own inline markup. */
  fragment: DocumentFragment;
  /** The voice's sentence, in the sample's own character offsets. */
  mark: { start: number; end: number } | null;
}

/** A heading: its own size and weight, so not what the settings are seen on. */
function inHeading(map: TextMap, offset: number): boolean {
  const at = offsetToDom(map, offset);
  return !!at?.node.parentElement?.closest('h1, h2, h3, h4, h5, h6');
}

/**
 * A few lines of the chapter, from the sentence the voice is on - or, with
 * no voice, the first sentence of running text from the top of the page -
 * to a little past it.
 *
 * Copied from the page rather than written for the occasion, so the preview
 * shows the reader's own book in its own markup: its italics, its dialogue,
 * its paragraphs. What belongs only on the page is hidden, not removed, so
 * the characters are still where the offsets say: an id would answer for
 * the page's element, and a picture is not what the preview is for.
 */
export function previewSample(
  map: TextMap | null,
  sentences: readonly { start: number; end: number }[],
  at: number,
  spoken: { start: number; end: number } | null,
): PreviewSample | null {
  if (!map || map.nodes.length === 0) return null;
  const here = sentences.findIndex((s) => s.end > at);
  // Past a chapter's title to its first words, a few sentences at most.
  const body =
    here < 0
      ? undefined
      : (sentences.slice(here, here + 4).find((s) => !inHeading(map, s.start)) ?? sentences[here]);
  const sentence = spoken ?? body ?? null;
  const start = sentence ? sentence.start : wordEdge(map, at, 'start');
  const end = Math.min(map.totalChars, wordEdge(map, start + SAMPLE_CHARS, 'end'));
  const range = end > start ? rangeForSpan(map, start, end) : null;
  if (!range) return null;
  const fragment = range.cloneContents();
  if (!fragment.textContent?.trim()) return null;
  for (const el of Array.from(fragment.querySelectorAll('[id]'))) el.removeAttribute('id');
  for (const el of Array.from(
    fragment.querySelectorAll<HTMLElement | SVGElement>(
      'img, svg, video, audio, picture, figure, iframe, object, table',
    ),
  )) {
    el.style.display = 'none';
  }
  return {
    fragment,
    mark: sentence ? { start: 0, end: Math.min(sentence.end, end) - start } : null,
  };
}

/**
 * The page, a few lines of it, above the settings that change it.
 *
 * The reader's own words at their size, weight, leading and margins, in the
 * page's colours and at its brightness, with the voice's mark drawn the way
 * the page draws it - the wash from the same line boxes, the margin mark in
 * the same place beside the line. A phone's settings sheet covers the page
 * it is changing; this is the page, where it can be seen.
 */
export function ReadingPreview({
  prefs,
  theme,
  sample,
  rtl,
  lang,
}: {
  prefs: ReaderPrefs;
  theme: ReaderTheme;
  sample: PreviewSample;
  rtl: boolean;
  lang: string | null;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<LineBox[] | null>(null);
  const [marker, setMarker] = useState<{ left: number; top: number } | null>(null);

  // The words go in once; the settings only restyle them.
  useLayoutEffect(() => {
    textRef.current?.replaceChildren(sample.fragment.cloneNode(true));
  }, [sample]);

  const layout = [
    prefs.font,
    prefs.size,
    prefs.weight,
    prefs.lineHeight,
    prefs.margin,
    prefs.align,
    prefs.hyphens,
  ].join('|');
  useLayoutEffect(() => {
    const box = boxRef.current;
    const text = textRef.current;
    const mark = sample.mark;
    if (!box || !text || !mark) return;
    let alive = true;
    let raf = 0;
    const measure = () => {
      if (!alive) return;
      const range = rangeForSpan(buildTextMap(text), mark.start, mark.end);
      const frame = box.getBoundingClientRect();
      const next = range ? relativeTo(lineBoxes(range.getClientRects(), frame), frame) : [];
      setLines(next.length > 0 ? next : null);
      const first = next[0];
      if (!first) {
        setMarker(null);
        return;
      }
      // Where the page puts it (markerPosition in motion.ts): 12px before
      // the column's first character, or 9px past its end in a book read
      // right to left, level with the middle of the line.
      const column = text.getBoundingClientRect();
      const style = getComputedStyle(text);
      const left = rtl
        ? column.right - parseFloat(style.paddingRight) + 9
        : column.left + parseFloat(style.paddingLeft) - 12;
      setMarker({ left: left - frame.left, top: first.top + first.height / 2 });
    };
    measure();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    observer.observe(text);
    void document.fonts?.ready.then(measure);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [sample, layout, rtl]);

  return (
    <div
      ref={boxRef}
      className="rs-preview"
      data-reader-theme={theme}
      dir={rtl ? 'rtl' : 'ltr'}
      style={readerTypeVars(prefs) as React.CSSProperties}
      aria-hidden="true"
    >
      <div ref={textRef} className="reader-content rs-preview__text" lang={lang ?? undefined} />
      {prefs.voiceMark === 'wash' && lines && (
        <div className="line-overlay spoken-mark">
          {lines.map((b, i) => (
            <span
              key={i}
              data-first={i === 0 ? '' : undefined}
              data-last={i === lines.length - 1 ? '' : undefined}
              style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
            />
          ))}
        </div>
      )}
      {prefs.voiceMark === 'margin' && marker && (
        <span className="pace-marker" style={{ left: marker.left, top: marker.top }} />
      )}
      {prefs.brightness < 1 && (
        <div className="reader-dim" style={{ opacity: 1 - prefs.brightness }} />
      )}
    </div>
  );
}
