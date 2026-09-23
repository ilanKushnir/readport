/**
 * Painting ranges through the CSS Custom Highlight API, in the one way every
 * engine repaints.
 *
 * Each name gets one Highlight for the life of the page. It is registered
 * once and changed in place after that: emptied, then refilled. WebKit
 * repaints a range whenever one is added to or deleted from a Highlight, but
 * until 2026 it did not repaint when a registry entry was replaced with
 * CSS.highlights.set() or dropped with CSS.highlights.delete() (WebKit bugs
 * 306396 and 321567). On an iPad that left a highlight the reader had just
 * removed on the page, until something else happened to repaint its line -
 * selecting some text, say.
 */

const owned = new Map<string, Highlight>();

function registry(): HighlightRegistry | null {
  if (typeof CSS === 'undefined' || typeof Highlight === 'undefined') return null;
  return (CSS as { highlights?: HighlightRegistry }).highlights ?? null;
}

/** Whether this browser can paint highlights at all. */
export function canPaint(): boolean {
  return registry() !== null;
}

/** Paint exactly these ranges under `name`, and nothing else; an empty list clears it. */
export function paintRanges(name: string, ranges: readonly AbstractRange[]): void {
  const reg = registry();
  if (!reg) return;
  let mine = owned.get(name);
  if (!mine) {
    // Registered empty: every range then goes in through add(), which repaints.
    mine = new Highlight();
    owned.set(name, mine);
  }
  const current = reg.get(name);
  if (current !== mine) {
    // Something else holds the name - this module's previous copy, after a
    // reload in development. Emptying it is what gets its ranges repainted.
    current?.clear();
    reg.set(name, mine);
  }
  if (mine.size > 0) mine.clear();
  for (const range of ranges) mine.add(range);
}
