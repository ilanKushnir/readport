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
 * One bounded frame of continuous following; never run during takeover.
 *
 * Signed: the page glides up to meet the marker and, after a rewind or a
 * relocation that landed the line below the anchor, glides back down. It
 * used to move only one way, so any relocation left the text sitting a
 * viewport's fraction below the marker until the voice had read that far.
 */
export function autoScrollDelta(
  current: number,
  target: number,
  speed: number,
  elapsed: number,
  enabled: boolean,
  reducedMotion: boolean,
): number {
  if (!enabled || reducedMotion) return 0;
  const dt = Math.max(0, Math.min(64, elapsed));
  const drift = target - current;
  const cap = Math.min(speed * dt + (Math.abs(drift) * dt) / 3000, dt * 0.22, Math.abs(drift));
  return drift < 0 ? -cap : cap;
}

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
