import { type PageLayout } from './prefs';
import { type FollowState } from './readalong';

type Box = { left: number; right: number; top: number; bottom: number };

/** A paused walker can relocate inside this chapter, but cannot repair a chapter mismatch. */
export function canResumeAt(state: FollowState, bookMs: number, playing: boolean): boolean {
  return (
    Number.isFinite(bookMs) && (playing || state === 'on' || state === 'hold' || state === 'gap')
  );
}

/** Track actual (clamped/rounded) writes, not a timeout during which input is ignored. */
export class ScrollOwnership {
  private expected = new WeakMap<{ scrollTop: number }, number>();

  write(el: { scrollTop: number }, top: number): void {
    el.scrollTop = top;
    this.expected.set(el, el.scrollTop);
  }

  matches(el: { scrollTop: number }): boolean {
    return this.expected.get(el) === el.scrollTop;
  }
}

/** Physical coordinates relative to the marker's containing viewport. */
export function markerPosition(
  rect: Box & { height: number },
  clip: Box,
  origin: Box,
  textBox: Box,
  rtl: boolean,
  layout: Pick<PageLayout, 'columns' | 'pad' | 'columnGap'>,
): { left: number; top: number } | null {
  if (
    rect.height <= 0 ||
    rect.right <= clip.left ||
    rect.left >= clip.right ||
    rect.bottom <= clip.top ||
    rect.top >= clip.bottom
  )
    return null;
  const width =
    (textBox.right - textBox.left - 2 * layout.pad - (layout.columns - 1) * layout.columnGap) /
    layout.columns;
  const pitch = width + layout.columnGap;
  if (width <= 0) return null;
  const column = Math.max(
    0,
    Math.min(
      layout.columns - 1,
      Math.floor(((rect.left + rect.right) / 2 - textBox.left - layout.pad) / pitch),
    ),
  );
  const start = textBox.left + layout.pad + column * pitch;
  return {
    left: (rtl ? start + width + 9 : start - 12) - origin.left,
    top: rect.top + rect.height / 2 - origin.top,
  };
}

/**
 * Where auto-scroll wants the page: it moves only when the voice moves on.
 *
 * The page used to drift up at the narrator's pace, a pixel a frame, so the
 * line being read was always sliding under the eye. Now it holds still
 * while an aligned chunk is read and moves once, in one short glide, when
 * the voice reaches the next: the new chunk's first line comes to the
 * reading line, `anchor` of the way down. A chunk too long to read from
 * there - the voice would run off the foot of the screen - moves again the
 * same way when the voice nears the foot, and a voice that is somehow above
 * the screen (a seek inside a long chunk) is brought back to the line too.
 *
 * Every position is in the scroller's content coordinates, the units of
 * `scrollTop`.
 *
 * @param held where the page has been held for this chunk, or null when the
 *   chunk has just begun.
 */
export function autoScrollTarget({
  held,
  chunkTop,
  voiceTop,
  voiceBottom,
  clientHeight,
  anchor,
  foot = AUTO_SCROLL_FOOT,
}: {
  held: number | null;
  chunkTop: number;
  voiceTop: number;
  voiceBottom: number;
  clientHeight: number;
  anchor: number;
  foot?: number;
}): number {
  const toLine = (y: number) => Math.max(0, y - clientHeight * anchor);
  if (held === null) {
    // A chunk that starts far above where the voice already is (a long one,
    // picked up half way) is placed by the voice, or the voice would open
    // below the screen.
    const at = toLine(chunkTop);
    return voiceBottom - at > clientHeight * foot ? toLine(voiceTop) : at;
  }
  if (voiceBottom - held > clientHeight * foot || voiceTop - held < 0) return toLine(voiceTop);
  return held;
}

/** How far down the screen the voice may read before the page moves anyway. */
export const AUTO_SCROLL_FOOT = 0.82;

/**
 * How long one auto-scroll step takes: longer than a relocation, because it
 * happens while somebody is reading and the eye has to be able to ride it.
 */
export const AUTO_SCROLL_STEP_MS = 650;

/**
 * How long a relocation glide takes.
 *
 * Short: a page that takes a second to arrive is a page you sit and wait
 * for, and one that arrives in a frame is a page that jumped. Under half a
 * second the eye follows the text to where it lands.
 */
export const GLIDE_MS = 450;

/** Ease in and out: the page starts gently and settles gently. */
export function easeInOutCubic(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Where a glide from `from` to `to` has got to, `elapsed` ms into `duration`. */
export function glidePosition(from: number, to: number, elapsed: number, duration: number): number {
  if (duration <= 0 || elapsed >= duration) return to;
  return from + (to - from) * easeInOutCubic(elapsed / duration);
}

type Scroller = { scrollTop: number; scrollHeight: number; clientHeight: number };

/**
 * One eased scroll at a time, cancelable.
 *
 * Every frame is written through the ownership, so the scroll events the
 * glide raises read as the page's own movement and not as the reader taking
 * the wheel. A reader who does take it - a flick, a wheel, the scrollbar -
 * ends the glide on its next frame, because the ownership no longer
 * matches; the caller's detach cancels it outright.
 */
export class ScrollGlide {
  private frame = 0;

  constructor(
    private readonly ownership: ScrollOwnership,
    private readonly schedule: (cb: (now: number) => void) => number = (cb) =>
      requestAnimationFrame(cb),
    private readonly unschedule: (id: number) => void = (id) => cancelAnimationFrame(id),
    private readonly clock: () => number = () => performance.now(),
  ) {}

  get active(): boolean {
    return this.frame !== 0;
  }

  /** Glide `el` to `to` over `duration` ms; instantly when there is nothing to ease. */
  start(el: Scroller, to: number, duration: number): void {
    this.cancel();
    const from = el.scrollTop;
    const end = Math.max(0, Math.min(to, Math.max(0, el.scrollHeight - el.clientHeight)));
    if (duration <= 0 || Math.abs(end - from) < 1) {
      this.ownership.write(el, end);
      return;
    }
    // Claimed from the first frame: an ownership that still remembers an
    // older position would read the glide's own first write as the reader's.
    this.ownership.write(el, from);
    const started = this.clock();
    const step = (now: number) => {
      this.frame = 0;
      if (!this.ownership.matches(el)) return;
      const elapsed = now - started;
      this.ownership.write(el, glidePosition(from, end, elapsed, duration));
      if (elapsed < duration) this.frame = this.schedule(step);
    };
    this.frame = this.schedule(step);
  }

  cancel(): void {
    if (this.frame) this.unschedule(this.frame);
    this.frame = 0;
  }
}
