export interface ReadingPoint {
  spineIdx: number;
  charOffset: number;
}
export type JumpReason =
  | 'toc'
  | 'search'
  | 'bookmark'
  | 'slider'
  | 'link'
  | 'progression'
  | 'resume'
  | 'narration'
  | 'return';
export function landingOffset(
  target: { charOffset?: number; sentenceId?: string },
  sentences: { id: string; start: number }[],
): number {
  return target.charOffset ?? sentences.find((s) => s.id === target.sentenceId)?.start ?? 0;
}
/* ------------------------------------------------ where a place is shown */

/** A span of a chapter's text, in character offsets. */
export interface TextSpan {
  start: number;
  end: number;
}

/**
 * How far back a place is carried to the start of its sentence.
 *
 * A place is kept to the character - the first one on the page, or wherever
 * the voice stopped - and that is as often inside a word as between two.
 * Reading picks up at a sentence, so that is where a place is shown. A
 * "sentence" longer than this is a paragraph the index could not split, and
 * going back to its start would be rereading half a page: the word will do.
 */
export const SENTENCE_REACH = 500;
/** From a gap between sentences - a heading, a picture - how far ahead the next one may begin. */
export const GAP_REACH = 200;
/** The most of a sentence the marker lights, from where it starts. */
export const MARK_REACH = 400;
/** Where a book has no sentence index: about a line's worth. */
const WORD_REACH = 90;

/**
 * The sentence an offset is in or, from a gap between two, the one that
 * begins soon after it. Null where there is none near.
 */
export function sentenceAround(sentences: readonly TextSpan[], offset: number): TextSpan | null {
  let next: TextSpan | null = null;
  for (const s of sentences) {
    if (s.start <= offset && offset < s.end) return s;
    if (s.start > offset && s.start - offset <= GAP_REACH && (!next || s.start < next.start))
      next = s;
  }
  return next;
}

/**
 * Where to bring a place into view: the start of its sentence when that is
 * near, so the line the marker begins on is the line the page shows first.
 * The place itself is untouched - it is still the one kept and sent on.
 */
export function sentenceStartNear(sentences: readonly TextSpan[], offset: number): number {
  const s = sentenceAround(sentences, offset);
  if (!s || s.start > offset) return offset;
  return offset - s.start <= SENTENCE_REACH ? s.start : offset;
}

/**
 * What the marker may light, best first: from the start of the place's
 * sentence, then from the start of the word the place is in. The marker
 * draws the first whose beginning is on the page - a sentence that began
 * on the page before is not shown by a mark starting mid-page - and so it
 * never begins inside a word. Each runs to the end of the sentence, or a
 * line's worth where the book has no sentence index.
 */
export function resumeSpans(
  sentences: readonly TextSpan[],
  offset: number,
  word: { start: (at: number) => number; end: (at: number) => number },
): TextSpan[] {
  const s = sentenceAround(sentences, offset);
  const until = (from: number): TextSpan => {
    const end = s ? Math.min(s.end, word.end(from + MARK_REACH)) : word.end(from + WORD_REACH);
    return { start: from, end: Math.max(end, from + 1) };
  };
  if (s && s.start > offset) return [until(s.start)];
  const w = s ? Math.max(s.start, word.start(offset)) : word.start(offset);
  if (!s || offset - s.start > SENTENCE_REACH) return [until(w)];
  return w === s.start ? [until(s.start)] : [until(s.start), until(w)];
}

export function markerOpacity(origin: ReadingPoint, current: ReadingPoint): number {
  if (origin.spineIdx !== current.spineIdx) return 0;
  return Math.max(0, 1 - Math.max(0, Math.abs(origin.charOffset - current.charOffset) - 80) / 600);
}
export function checkpointDue(last: number, now: number, changed: boolean): boolean {
  return changed && now - last >= 3000;
}

export interface AudioReturnPoint {
  originMs: number;
  destinationMs: number;
}
export function audioReturnAfterJump(
  originMs: number,
  destinationMs: number,
  reason: JumpReason,
): AudioReturnPoint | null {
  if (!['toc', 'search', 'bookmark', 'slider', 'link'].includes(reason)) return null;
  if (
    !Number.isFinite(originMs) ||
    originMs < 0 ||
    !Number.isFinite(destinationMs) ||
    Math.abs(destinationMs - originMs) <= 90000
  )
    return null;
  return { originMs, destinationMs };
}
export function audioContinued(point: AudioReturnPoint, currentMs: number): boolean {
  return Math.abs(currentMs - point.destinationMs) >= 30000;
}
