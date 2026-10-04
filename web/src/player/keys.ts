/**
 * The player's keys.
 *
 * Space (or K) plays and pauses. The arrows move fifteen seconds either way -
 * the same both ways, so a press and its opposite cancel out - and with
 * Shift a whole chapter. J and L keep the player's own skip lengths, the ones
 * its buttons use.
 *
 * The arrows follow the timeline on screen: it runs from the start of the
 * interface's writing direction, so in a right-to-left interface the left
 * arrow is the one that goes on.
 *
 * Pure: the page decides whether a key is its to take at all (lib/keys.ts).
 */

export type PlayerKeyAction =
  | { kind: 'toggle' }
  /** Move by this many milliseconds, back when negative. */
  | { kind: 'seek'; byMs: number }
  /** The next chapter (1) or this one's start, then the one before (-1). */
  | { kind: 'chapter'; dir: 1 | -1 };

/** How far an arrow moves the narration. */
export const ARROW_SKIP_MS = 15_000;

export function playerKeyAction(
  e: { key: string; shiftKey: boolean },
  ctx: { rtl: boolean; skipBackS: number; skipFwdS: number },
): PlayerKeyAction | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === ' ' || key === 'k') return e.shiftKey ? null : { kind: 'toggle' };
  const on = ctx.rtl ? 'ArrowLeft' : 'ArrowRight';
  const back = ctx.rtl ? 'ArrowRight' : 'ArrowLeft';
  if (key === on)
    return e.shiftKey ? { kind: 'chapter', dir: 1 } : { kind: 'seek', byMs: ARROW_SKIP_MS };
  if (key === back)
    return e.shiftKey ? { kind: 'chapter', dir: -1 } : { kind: 'seek', byMs: -ARROW_SKIP_MS };
  if (e.shiftKey) return null;
  if (key === 'j') return { kind: 'seek', byMs: -ctx.skipBackS * 1000 };
  if (key === 'l') return { kind: 'seek', byMs: ctx.skipFwdS * 1000 };
  return null;
}
