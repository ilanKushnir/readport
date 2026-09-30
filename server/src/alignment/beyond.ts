import { BEYOND_TEXT_MIN_MS, type AlignmentGap, type NarrationBeyondText } from '@readport/shared';
import { type DB } from '../db/index.js';

/**
 * The narration an ebook does not have: an introduction read before the
 * text begins, a passage one edition kept and the other cut, the music after
 * a part - the stretches where read-along should say "keep listening, the
 * text picks up again soon" rather than sit on a sentence the voice left a
 * minute ago.
 *
 * The aligner reports every hole in its timings longer than a breath as a
 * narration-only gap, and most of them are not. Text it could not place
 * leaves a hole the same shape as narration the book lacks. So a hole is
 * judged by what is in it: the sentences between the last synced one before
 * it and the first after it, none of them timed. Read aloud at the book's
 * own pace, they account for so much of the hole; only what is left over is
 * narration the ebook does not have, and only when that is a passage's worth
 * (BEYOND_TEXT_MIN_MS) is it reported.
 */

/** A book's sentence index: per chapter, its sentences in order (epub/extract loadSentences). */
export type SentenceIndex = readonly (readonly {
  id: string;
  ord: number;
  start: number;
  end: number;
}[])[];

/** A narrator's ordinary pace, for a book too little synced to measure its own: 14 characters a second. */
const FALLBACK_MS_PER_CHAR = 1000 / 14;
/** Two sentences this close are one breath apart - the pairs the pace is measured over. */
const PACE_MAX_PAUSE_MS = 3_000;
/** Measured over less text than this, a pace says more about one sentence than about the narrator. */
const PACE_MIN_CHARS = 2_000;

interface Timed {
  spine: number;
  ord: number;
  id: string;
  startMs: number;
  endMs: number;
}

/** Each alignment's answer, for as long as its alignment and its ebook's index stay the same. */
const cache = new Map<string, NarrationBeyondText[]>();
const CACHE_MAX = 16;

/**
 * The stretches of one alignment's narration with no text in the ebook,
 * in narration order. `key` names the alignment and the ebook's index the
 * answer was worked out against, so a new version of either is worked out
 * afresh.
 */
export function narrationBeyondText(
  db: DB,
  alignmentId: string,
  gaps: readonly AlignmentGap[],
  sentences: SentenceIndex,
  key = alignmentId,
): NarrationBeyondText[] {
  const hit = cache.get(key);
  if (hit) return hit;
  const found = judge(db, alignmentId, gaps, sentences);
  cache.set(key, found);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return found;
}

function judge(
  db: DB,
  alignmentId: string,
  gaps: readonly AlignmentGap[],
  sentences: SentenceIndex,
): NarrationBeyondText[] {
  const holes = gaps.filter(
    (g) => g.reason === 'narration-only' && g.toMs - g.fromMs >= BEYOND_TEXT_MIN_MS,
  );
  if (holes.length === 0) return [];
  const timed = (
    db
      .prepare(
        `SELECT spine_idx, sentence_ord, sentence_id, start_ms, end_ms FROM alignment_segments
          WHERE alignment_id = ? ORDER BY spine_idx, sentence_ord`,
      )
      .all(alignmentId) as Record<string, unknown>[]
  ).map((r): Timed => ({
    spine: Number(r.spine_idx),
    ord: Number(r.sentence_ord),
    id: String(r.sentence_id),
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
  }));
  if (timed.length === 0) return [];
  const isTimed = new Set(timed.map((t) => `${t.spine}:${t.ord}`));
  const sentenceAt = (spine: number, ord: number) => {
    const chapter = sentences[spine] ?? [];
    const s = chapter[ord];
    return s && s.ord === ord ? s : (chapter.find((x) => x.ord === ord) ?? null);
  };
  const length = (spine: number, ord: number) => {
    const s = sentenceAt(spine, ord);
    return s ? Math.max(0, s.end - s.start) : 0;
  };
  const msPerChar = paceOf(timed, length);
  const byTime = [...timed].sort((a, b) => a.startMs - b.startMs);

  const out: NarrationBeyondText[] = [];
  for (const hole of holes) {
    // The synced sentences either side: the last one heard before the
    // hole, and the first after it. Either may be missing - the hole before
    // the book's first synced sentence, and the one after its last.
    const before = lastEndingBy(byTime, hole.fromMs + 1);
    const after = firstStartingFrom(byTime, hole.toMs - 1);
    if (before && after && readingOrder(after, before) <= 0) continue;
    const untimed = untimedChars(sentences, isTimed, length, before, after);
    const extraMs = Math.round(hole.toMs - hole.fromMs - untimed * msPerChar);
    if (extraMs < BEYOND_TEXT_MIN_MS) continue;
    const resumeAt = after ? sentenceAt(after.spine, after.ord) : null;
    out.push({
      fromMs: Math.round(hole.fromMs),
      toMs: Math.round(hole.toMs),
      extraMs,
      where: !before ? 'start' : after ? 'middle' : 'end',
      resume:
        after && resumeAt
          ? { spineIdx: after.spine, sentenceId: after.id, charOffset: resumeAt.start }
          : null,
    });
  }
  return out;
}

/**
 * How long the narrator takes over a character, measured on this book:
 * from each synced sentence to the next one in the text, when the voice
 * went straight on from one to the other.
 */
function paceOf(timed: readonly Timed[], length: (spine: number, ord: number) => number): number {
  let ms = 0;
  let chars = 0;
  for (let i = 1; i < timed.length; i++) {
    const a = timed[i - 1]!;
    const b = timed[i]!;
    if (b.spine !== a.spine || b.ord !== a.ord + 1) continue;
    if (b.startMs <= a.startMs || b.startMs - a.endMs > PACE_MAX_PAUSE_MS) continue;
    const n = length(a.spine, a.ord);
    if (n <= 0) continue;
    ms += b.startMs - a.startMs;
    chars += n;
  }
  return chars >= PACE_MIN_CHARS ? ms / chars : FALLBACK_MS_PER_CHAR;
}

function readingOrder(a: Timed, b: Timed): number {
  return a.spine - b.spine || a.ord - b.ord;
}

/** The synced sentence that ends last at or before `ms`. */
function lastEndingBy(byTime: readonly Timed[], ms: number): Timed | null {
  let best: Timed | null = null;
  for (const t of byTime) {
    if (t.startMs > ms) break;
    if (t.endMs <= ms && (!best || t.endMs >= best.endMs)) best = t;
  }
  return best;
}

/** The synced sentence that starts first at or after `ms`. */
function firstStartingFrom(byTime: readonly Timed[], ms: number): Timed | null {
  let lo = 0;
  let hi = byTime.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byTime[mid]!.startMs < ms) lo = mid + 1;
    else hi = mid;
  }
  return byTime[lo] ?? null;
}

/** The characters of the untimed sentences between two synced ones, in reading order. */
function untimedChars(
  sentences: SentenceIndex,
  isTimed: ReadonlySet<string>,
  length: (spine: number, ord: number) => number,
  before: Timed | null,
  after: Timed | null,
): number {
  let n = 0;
  const firstSpine = before?.spine ?? 0;
  const lastSpine = after?.spine ?? sentences.length - 1;
  for (let spine = firstSpine; spine <= lastSpine; spine++) {
    const chapter = sentences[spine] ?? [];
    for (const s of chapter) {
      if (before && spine === before.spine && s.ord <= before.ord) continue;
      if (after && spine === after.spine && s.ord >= after.ord) break;
      if (!isTimed.has(`${spine}:${s.ord}`)) n += length(spine, s.ord);
    }
  }
  return n;
}
