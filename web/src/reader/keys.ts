/**
 * The reader's keys, in each way of reading.
 *
 * Reading on its own, every key that goes on goes on by a page: the arrows
 * (the one pointing the way the book reads), Space, Page Down - and in page
 * view, where there is nothing to scroll, the down arrow too. In scroll view
 * a "page" is a screen, and past the end of a chapter the next one begins.
 *
 * Reading along, the narration has the keys: Space plays and pauses it, the
 * arrows move it a sentence on or back - Shift and an arrow by fifteen
 * seconds - and the page follows wherever it goes. Page Up and Page Down
 * still turn the page on its own, to look ahead while the voice reads on (a
 * swipe does the same), and the up and down arrows stay the page's too.
 *
 * The arrows follow the book's direction, as page turns always have: in a
 * right-to-left book the left arrow is the one that goes on.
 *
 * Pure: the page decides whether a key is its to take at all (keys.ts in
 * lib - typing, a modifier, a control reached from the keyboard); this
 * only says what it means.
 */

export type ReaderKeyAction =
  /** Play or pause the narration. */
  | { kind: 'voice' }
  /** The narration to the next sentence, or back to the start of this one or the one before. */
  | { kind: 'sentence'; dir: 'next' | 'prev' }
  /** The narration on or back by the skip length. */
  | { kind: 'skip'; dir: 'next' | 'prev' }
  /** A page on or back - a screen in scroll view, into the next chapter at the end of one. */
  | { kind: 'page'; dir: 'next' | 'prev' };

export interface ReaderKeyContext {
  readAlong: boolean;
  /** The book reads right to left. */
  rtl: boolean;
  /** Page view, or scroll view - including a chapter that would not divide into pages. */
  view: 'paginated' | 'scroll';
}

export function readerKeyAction(
  e: { key: string; shiftKey: boolean },
  ctx: ReaderKeyContext,
): ReaderKeyAction | null {
  const on = ctx.rtl ? 'ArrowLeft' : 'ArrowRight';
  const back = ctx.rtl ? 'ArrowRight' : 'ArrowLeft';
  const dir = e.key === on ? 'next' : e.key === back ? 'prev' : null;

  if (ctx.readAlong) {
    if (e.key === ' ') return e.shiftKey ? null : { kind: 'voice' };
    if (dir) return { kind: e.shiftKey ? 'skip' : 'sentence', dir };
    if (e.key === 'PageDown') return { kind: 'page', dir: 'next' };
    if (e.key === 'PageUp') return { kind: 'page', dir: 'prev' };
    return null;
  }

  if (e.shiftKey && e.key === ' ') return { kind: 'page', dir: 'prev' };
  if (e.shiftKey) return null;
  if (dir) return { kind: 'page', dir };
  if (e.key === ' ' || e.key === 'PageDown') return { kind: 'page', dir: 'next' };
  if (e.key === 'PageUp') return { kind: 'page', dir: 'prev' };
  // Page view has nothing to scroll: the down arrow means the next page.
  if (ctx.view === 'paginated' && e.key === 'ArrowDown') return { kind: 'page', dir: 'next' };
  if (ctx.view === 'paginated' && e.key === 'ArrowUp') return { kind: 'page', dir: 'prev' };
  return null;
}
