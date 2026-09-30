/**
 * Where each library view was left, for the way back to it.
 *
 * The library is a page that scrolls inside its own pane, and every visit
 * to it is a new page: open a book halfway down the grid, come back - by
 * the back gesture, the back button or the Library tab - and it used to
 * start again at the top, with its search and its order forgotten and its
 * books fetched again behind skeleton cards. So each view (a shelf, a
 * grouping, a language; `viewKey`) keeps what it was left at for as long
 * as the app is open: the search, the format and the order, the answer it
 * last showed, and where it was scrolled to - held by the card the reader
 * tapped, or the one at the top of the pane, so the grid comes back with
 * that book where it was even when something above it arrives a moment
 * later (the week's figures, a cover). Memory only: a fresh start of the
 * app starts at the top.
 */

export interface Anchor {
  /** The book whose card holds the place. */
  id: string;
  /** How far below the pane's top that card's top was, in pixels. */
  offset: number;
}

export interface ScrollPlace {
  top: number;
  anchor: Anchor | null;
}

export interface ViewMemory<K extends string = string, S extends string = string> {
  query: string;
  kind: K;
  sort: S;
  place: ScrollPlace | null;
}

const views = new Map<string, ViewMemory>();

export function recallView<K extends string, S extends string>(
  key: string,
): ViewMemory<K, S> | undefined {
  return views.get(key) as ViewMemory<K, S> | undefined;
}

export function rememberView(key: string, memory: ViewMemory): void {
  views.set(key, memory);
}

/** Only where it was scrolled to, leaving the rest as it is. */
export function rememberPlace(key: string, place: ScrollPlace): void {
  const current = views.get(key);
  if (current) views.set(key, { ...current, place });
}

/**
 * The last answer for each request, so a view comes back drawn rather
 * than as skeletons while the fresh one loads. A handful is plenty: they
 * are for going back, not for browsing the whole library offline.
 */
const ANSWERS_KEPT = 12;
const answers = new Map<string, unknown>();

export function recallAnswer<T>(key: string): T | undefined {
  return answers.get(key) as T | undefined;
}

export function rememberAnswer<T>(key: string, answer: T): void {
  answers.delete(key);
  answers.set(key, answer);
  while (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value!);
}

/** Forget every view and answer (sign-out, tests). */
export function forgetLibraryMemory(): void {
  views.clear();
  answers.clear();
}

/* --------------------------------------------------------------- the DOM */

const CARD = '[data-book]';

/** A card's place: its book, and how far below the pane's top its card begins. */
export function anchorOf(card: Element, pane: HTMLElement): Anchor | null {
  const id = card.getAttribute('data-book');
  if (!id) return null;
  return { id, offset: card.getBoundingClientRect().top - pane.getBoundingClientRect().top };
}

/** The place the pane is at now: its offset, and the first card still in view. */
export function placeIn(pane: HTMLElement): ScrollPlace {
  const top = pane.getBoundingClientRect().top;
  let anchor: Anchor | null = null;
  for (const card of pane.querySelectorAll(CARD)) {
    if (card.getBoundingClientRect().bottom > top + 1) {
      anchor = anchorOf(card, pane);
      break;
    }
  }
  return { top: pane.scrollTop, anchor };
}

/**
 * Scroll the pane back to a place: the anchor's card where it was, or the
 * raw offset when that card is not on the page any more. Then hold it
 * there while what is above settles - for a second and a half, or until
 * the reader touches, scrolls or types anywhere (a tap on the tab bar that
 * sends the page to its top included), whichever comes first. Returns the
 * way to stop holding early.
 */
export function restorePlace(
  pane: HTMLElement,
  place: ScrollPlace,
  { holdMs = 1500, onDone }: { holdMs?: number; onDone?: () => void } = {},
): () => void {
  const put = () => {
    const card = place.anchor
      ? pane.querySelector(`[data-book="${CSS.escape(place.anchor.id)}"]`)
      : null;
    if (card && place.anchor) {
      const now = card.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      const delta = now - place.anchor.offset;
      if (Math.abs(delta) > 0.5) pane.scrollTop += delta;
    } else if (Math.abs(pane.scrollTop - place.top) > 0.5) {
      pane.scrollTop = place.top;
    }
  };
  put();
  let raf = 0;
  let stopped = false;
  const until = performance.now() + holdMs;
  const events = ['touchstart', 'wheel', 'keydown', 'pointerdown'] as const;
  const doc = pane.ownerDocument;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    for (const type of events) doc.removeEventListener(type, stop, true);
    onDone?.();
  };
  for (const type of events) doc.addEventListener(type, stop, { capture: true, passive: true });
  const hold = () => {
    if (stopped) return;
    if (performance.now() > until) return stop();
    put();
    raf = requestAnimationFrame(hold);
  };
  raf = requestAnimationFrame(hold);
  return stop;
}
