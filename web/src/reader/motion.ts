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
