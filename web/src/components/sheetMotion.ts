/**
 * How a bottom sheet moves: in from the bottom edge, away the same way, and
 * down with a finger on its handle. The numbers are here, apart from the
 * component, so the one judgement in it - was that drag a dismissal - can be
 * tested without a browser.
 */

/** A sheet is a bottom sheet (rather than a floating card) below this width. */
export const NARROW_SHEET = '(max-width: 743.98px)';

/** Arriving: fast out of the edge, settling slowly - the curve iOS sheets use. */
export const SHEET_EASE_IN = 'cubic-bezier(0.32, 0.72, 0, 1)';
/** Leaving: gathering speed as it goes. */
export const SHEET_EASE_OUT = 'cubic-bezier(0.4, 0, 1, 1)';
export const SHEET_EXIT_MS = 240;
export const SHEET_SETTLE_MS = 300;

/** A drag that ends this far down, as a share of the sheet's height, closes it. */
const DISMISS_SHARE = 0.25;
/** So does a flick at least this fast (px per ms), however short. */
const DISMISS_SPEED = 0.5;
/** Less than this is a tap that wobbled, not a drag. */
const MIN_TRAVEL = 12;

/** Whether letting go of a sheet dragged `dy` px down, moving at `speed`, closes it. */
export function dragDismisses(dy: number, height: number, speed: number): boolean {
  if (dy < MIN_TRAVEL) return false;
  return dy > height * DISMISS_SHARE || speed > DISMISS_SPEED;
}

/**
 * Where the sheet is drawn for a finger `raw` px below where it started:
 * with it on the way down, and grudgingly on the way up - it is already as
 * high as it goes, and says so by giving a little and no more.
 */
export function dragOffset(raw: number): number {
  return raw >= 0 ? raw : -Math.min(24, Math.sqrt(-raw) * 2);
}
