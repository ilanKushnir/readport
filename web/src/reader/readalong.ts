import { type SentenceIndexEntry } from '../lib/types';

/**
 * Read-along: the arithmetic that lets the narration drive the page and the
 * page drive the narration.
 *
 * A chapter gives us sentences with character spans; an alignment gives us
 * the same sentences with time spans. Joined by sentence id they become
 * *cues* - the one object that knows both where a sentence is on the page and
 * when it is spoken. Everything the feature does is a lookup in that list, so
 * it lives here, pure and tested, rather than inside a component.
 *
 * The hard part is not the lookup. It is being honest about the places where
 * the alignment has nothing to say: unaligned stretches, sentences the aligner
 * skipped, and the silence between two sentences. A karaoke highlight that
 * guesses through those is worse than one that admits it has lost the thread.
 */

/** One timed segment as the server stores it. */
export interface AlignedSegment {
  sentenceId: string;
  startMs: number;
  endMs: number;
  /** How far off this timing may be, in ms. Used to size the lead-in. */
  uncertaintyMs?: number;
}

/** A sentence that has both a place on the page and a place in the narration. */
export interface Cue {
  id: string;
  /** Chapter character offsets - what the highlight and the tap target use. */
  charStart: number;
  charEnd: number;
  /** Book-absolute milliseconds - what the audio element is seeked to. */
  startMs: number;
  endMs: number;
  /**
   * How far off this timing may be, in ms - carried through from the aligner.
   * A cue the aligner is sure of can be shown to the reader as a fact; one it
   * is guessing at should only ever move a pace marker.
   */
  uncertaintyMs: number;
}

/**
 * Silence longer than this between two cues is treated as a hole in the
 * alignment rather than as a breath, and the highlight lets go instead of
 * sitting on a sentence that finished talking a while ago. Chosen from real
 * narration: inter-sentence pauses run to about a second, and paragraph
 * breaks to about two.
 */
export const HOLD_MS = 2_500;

/**
 * Join a chapter's sentences to its alignment.
 *
 * Sentences with no timing are dropped rather than interpolated: this list is
 * what the highlight trusts, and a made-up cue would put the highlight on the
 * wrong line with the same confidence as a real one. Order comes from the
 * clock, not from the page, because that is the order the lookup binary
 * searches - a book whose narration reorders a passage would otherwise break
 * the search rather than merely look odd.
 */
export function buildCues(sentences: SentenceIndexEntry[], segments: AlignedSegment[]): Cue[] {
  const byId = new Map(sentences.map((s) => [s.id, s]));
  const cues: Cue[] = [];
  for (const seg of segments) {
    const s = byId.get(seg.sentenceId);
    if (!s) continue;
    if (!Number.isFinite(seg.startMs) || !Number.isFinite(seg.endMs)) continue;
    cues.push({
      id: s.id,
      charStart: s.start,
      charEnd: Math.max(s.end, s.start + 1),
      startMs: seg.startMs,
      // A zero-length or inverted cue can never be "current", so give it the
      // smallest span that can be.
      endMs: Math.max(seg.endMs, seg.startMs + 1),
      // No stated uncertainty means the aligner did not measure one, which is
      // not the same as being certain - treat it as unknown, not as zero.
      uncertaintyMs: Number.isFinite(seg.uncertaintyMs)
        ? Math.max(0, seg.uncertaintyMs!)
        : Number.POSITIVE_INFINITY,
    });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

/** Where the narration is, relative to what this chapter can show. */
export type FollowState =
  /** On a sentence: highlight it. */
  | 'on'
  /** Between two cues, close enough that this is a pause: hold the last one. */
  | 'hold'
  /** In a stretch this chapter has no timings for: let go, say so. */
  | 'gap'
  /** Before this chapter's first cue, or after its last: the page should move. */
  | 'before'
  | 'after';

export interface CueLookup {
  cue: Cue | null;
  state: FollowState;
  /** Index into `cues`, or -1. Lets a caller prefetch what comes next. */
  index: number;
}

/** Index of the last cue starting at or before `ms`, or -1. */
function lastStartingBefore(cues: Cue[], ms: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The cue the narration is inside at `bookMs`, and how much to trust it.
 *
 * Between cues the previous one is held for `HOLD_MS`, so an ordinary pause
 * between sentences does not make the highlight blink. Past that, the answer
 * is `gap` and the caller stops highlighting: somewhere in there the aligner
 * gave up, and following it would be a guess dressed as a fact.
 */
export function cueAt(cues: Cue[], bookMs: number): CueLookup {
  if (cues.length === 0) return { cue: null, state: 'gap', index: -1 };
  const first = cues[0]!;
  const last = cues[cues.length - 1]!;
  if (bookMs < first.startMs) {
    // Only "before" once it is a real distance away; a hair early is the
    // clock's rounding, not a different chapter.
    return { cue: null, state: bookMs < first.startMs - HOLD_MS ? 'before' : 'hold', index: -1 };
  }
  const i = lastStartingBefore(cues, bookMs);
  const cue = cues[i]!;
  if (bookMs < cue.endMs) return { cue, state: 'on', index: i };

  const next = cues[i + 1];
  if (!next) {
    return bookMs <= last.endMs + HOLD_MS
      ? { cue, state: 'hold', index: i }
      : { cue: null, state: 'after', index: -1 };
  }
  // Inside the chapter, between two cues: a breath, or a hole.
  return bookMs <= cue.endMs + HOLD_MS
    ? { cue, state: 'hold', index: i }
    : { cue: null, state: 'gap', index: -1 };
}

/**
 * The cue to start narrating for a place on the page - used when the reader
 * taps a sentence, and when read-along is switched on where they are reading.
 *
 * Falls forward, never back: given an offset in an unaligned stretch, the
 * answer is the next sentence that does have a timing. Starting the narration
 * behind the reader replays what they have already read; starting it a little
 * ahead is the smaller sin, and the highlight makes it obvious.
 */
export function cueForOffset(cues: Cue[], charOffset: number): Cue | null {
  let best: Cue | null = null;
  for (const c of cues) {
    if (charOffset >= c.charStart && charOffset < c.charEnd) return c;
    if (c.charStart >= charOffset && (!best || c.charStart < best.charStart)) best = c;
  }
  return best ?? null;
}

/**
 * How long before a cue's stated start to begin playing it.
 *
 * The alignment says how sure it is; when it is unsure, coming in a little
 * early means the reader hears the whole sentence rather than joining it
 * halfway. Bounded, because on a badly-aligned passage the uncertainty can be
 * tens of seconds and nobody wants to rewind that far to hear one line.
 */
export function leadInFor(uncertaintyMs: number | undefined): number {
  if (!uncertaintyMs || uncertaintyMs <= 0) return 0;
  return Math.min(1_200, Math.round(uncertaintyMs * 0.25));
}

/**
 * Whether the page should follow the narration to `cue`.
 *
 * Auto-follow is given up the moment the reader moves the page themselves -
 * looking ahead is a normal thing to do while listening, and a page that
 * snatches itself back is the single most irritating thing a read-along can
 * do. It comes back when they ask for it, or, without anyone pressing
 * anything, when the narration catches up to the page they wandered to.
 *
 * `cueOnScreen` is geometry the reader measures: whether the sentence's own
 * rectangle is inside the page box right now. Offsets would be the wrong
 * question - a two-column spread shows two ranges that are not contiguous.
 */
export function shouldFollow(
  following: boolean,
  cue: Cue | null,
  cueOnScreen: boolean,
  /**
   * Whether the voice has been off the screen at all since the reader took
   * over. Resuming purely because the sentence is still visible means a
   * deliberate scroll is undone by the very next tick of the clock - in
   * scrolling mode "on screen" is most of a chapter, so the page fought the
   * reader and "Back to the voice" blinked in and out as it went. Once they
   * have taken over, following resumes when the voice comes BACK to them.
   */
  cueLeftSinceTakeover = true,
): boolean {
  if (!cue) return false;
  if (following) return true;
  return cueOnScreen && cueLeftSinceTakeover;
}

/** The tracks of an audiobook, as the book detail reports them. */
export interface TrackSpan {
  durationMs: number;
  startMsAbsolute: number;
}

/**
 * Which file a book-absolute position falls in, and where inside it.
 *
 * An audiobook is usually many files, but an alignment only ever speaks in
 * positions from the start of the book. Every seek has to cross that boundary,
 * and getting it wrong by one track is the difference between chapter two and
 * chapter three, so it is arithmetic worth having on its own.
 */
export function locateInTracks(
  tracks: TrackSpan[],
  bookMs: number,
): { trackIdx: number; positionMs: number } {
  if (tracks.length === 0) return { trackIdx: 0, positionMs: Math.max(0, bookMs) };
  const target = Math.max(0, bookMs);
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i]!;
    if (target >= t.startMsAbsolute) {
      // Clamp inside the file: a position past the end of the last track (a
      // rounding error, or an alignment that ran long) must still be seekable.
      return { trackIdx: i, positionMs: Math.min(target - t.startMsAbsolute, t.durationMs) };
    }
  }
  return { trackIdx: 0, positionMs: 0 };
}

/**
 * A timing tight enough to show the reader as a fact.
 *
 * Anything looser moves the pace marker and nothing else. Half a second is
 * about one spoken clause: inside that, pointing at a word is genuinely
 * pointing at the word being said; outside it, a highlight would be a
 * confident-looking lie, and a wrong highlight is worse than none because the
 * reader's eye follows it.
 */
export const CONFIDENT_MS = 500;

export function isConfident(cue: Cue | null): boolean {
  return !!cue && cue.uncertaintyMs <= CONFIDENT_MS;
}

/**
 * Where the narration has got to, as a character offset - including between
 * sentences.
 *
 * The pace marker needs a position at every instant, not once a sentence. A
 * cue gives a span of text and a span of time, so inside a cue the offset is
 * that span read at a constant rate; between two cues it carries on across
 * the gap at the rate the gap implies. It is an estimate and is drawn as one:
 * a marker beside the text, never a mark on it.
 *
 * Returns null when there is nothing to estimate from - before the first cue,
 * after the last, or in a stretch with no timings at all.
 */
export function paceOffset(cues: Cue[], bookMs: number): number | null {
  if (cues.length === 0) return null;
  const { cue, state, index } = cueAt(cues, bookMs);

  if (state === 'on' && cue) {
    const span = cue.endMs - cue.startMs;
    const through = span > 0 ? (bookMs - cue.startMs) / span : 0;
    return cue.charStart + (cue.charEnd - cue.charStart) * clamp01(through);
  }

  // Holding between two sentences: walk from the end of the one just spoken
  // towards the start of the next, so the marker keeps moving through a
  // breath instead of stalling and then jumping.
  if (state === 'hold' && cue) {
    const next = cues[index + 1];
    if (!next) return cue.charEnd;
    const span = next.startMs - cue.endMs;
    const through = span > 0 ? (bookMs - cue.endMs) / span : 1;
    return cue.charEnd + (next.charStart - cue.charEnd) * clamp01(through);
  }

  return null;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * The cue nearest a moment in time, whatever the lookup state says.
 *
 * `cueAt` deliberately answers "nothing" in a gap, before the first cue and
 * after the last, because a highlight must not claim a sentence the narrator
 * is not reading. But "take me back to the voice" is a different question: a
 * reader who has lost the thread wants to be put somewhere sensible, and the
 * nearest timed sentence is the honest answer. Refusing to move - which is
 * what returning nothing meant - left the button doing nothing at all,
 * exactly when it was needed most.
 */
export function nearestCue(cues: Cue[], bookMs: number): Cue | null {
  if (cues.length === 0) return null;
  const i = lastStartingBefore(cues, bookMs);
  const before = i >= 0 ? cues[i]! : null;
  const after = cues[i + 1] ?? null;
  if (!before) return after;
  if (!after) return before;
  // Inside the earlier cue still counts as being in it.
  if (bookMs <= before.endMs) return before;
  return bookMs - before.endMs <= after.startMs - bookMs ? before : after;
}

/** Where one chapter sits in the narration: its first and last timed moment. */
export interface ChapterBound {
  spineIdx: number;
  firstMs: number;
  lastMs: number;
}

/**
 * The chapter the voice is in at `bookMs`, or the one it is nearest to.
 *
 * Inside a chapter's timed span the answer is that chapter. Between two -
 * the narrator reading a chapter title nobody aligned - it is whichever
 * span is closer, and on a tie the later one, because the voice is moving
 * forward. This is what lets "Back to the voice" open the right chapter in
 * one move instead of walking there a chapter at a time from wherever the
 * page happens to be, and what stops the walk itself from getting stuck
 * between two chapters that each claim the playhead is past their edge.
 */
export function nearestChapter(bounds: ChapterBound[], bookMs: number): number | null {
  let best: { spineIdx: number; distance: number } | null = null;
  for (const b of bounds) {
    const distance =
      bookMs < b.firstMs ? b.firstMs - bookMs : bookMs > b.lastMs ? bookMs - b.lastMs : 0;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && b.spineIdx > best.spineIdx)
    )
      best = { spineIdx: b.spineIdx, distance };
  }
  return best?.spineIdx ?? null;
}

/**
 * How long the voice may read of the page before, after a turn with the
 * voice, to give the sentence the new page begins in the middle of whole.
 * Longer than this and it starts at the first sentence that begins on the
 * new page instead: a page is turned to read it, not to wait for it.
 */
export const TURN_LEAD_IN_MAX_MS = 6000;

/**
 * Where the voice starts when a page is turned with it (the side arrows in
 * page view): the first sentence that begins on the page - unless the page
 * begins in the middle of a sentence whose part on the page before is
 * short, in which case that sentence, heard whole, with `hold` set so the
 * page waits for the voice instead of flipping back to it. A page that no
 * sentence begins on at all - one very long sentence - is that sentence,
 * held the same way. Null when nothing from the page on is timed.
 *
 * @param onPage whether a character offset is on the page turned to.
 */
export function cueForTurn(
  cues: Cue[],
  pageStart: number,
  onPage: (charOffset: number) => boolean,
  maxLeadInMs = TURN_LEAD_IN_MAX_MS,
): { cue: Cue; hold: boolean } | null {
  let split: Cue | null = null;
  let first: Cue | null = null;
  for (const c of cues) {
    if (
      c.charStart < pageStart &&
      c.charEnd > pageStart &&
      (!split || c.charStart > split.charStart)
    )
      split = c;
    if (c.charStart >= pageStart && (!first || c.charStart < first.charStart)) first = c;
  }
  const firstHere = first !== null && onPage(first.charStart) ? first : null;
  if (split) {
    const share = (pageStart - split.charStart) / Math.max(1, split.charEnd - split.charStart);
    const leadIn = share * Math.max(0, split.endMs - split.startMs);
    if (!firstHere || leadIn <= maxLeadInMs) return { cue: split, hold: true };
  }
  // Nothing timed on the page itself: the next thing that is.
  const next = firstHere ?? first;
  return next ? { cue: next, hold: false } : null;
}
