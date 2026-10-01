import { z } from 'zod';

/**
 * Alignment contract: a monotonic mapping between ebook sentences and
 * absolute audiobook milliseconds, with per-segment confidence and explicit
 * gaps. Low-confidence regions are never presented as exact.
 */

export const alignmentSourceSchema = z.enum(['exact', 'fuzzy', 'interpolated', 'anchor']);
export type AlignmentSource = z.infer<typeof alignmentSourceSchema>;

export const alignmentSegmentSchema = z.object({
  sentenceId: z.string(),
  spineIdx: z.number().int().min(0),
  sentenceOrd: z.number().int().min(0),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
  source: alignmentSourceSchema,
  /**
   * How far `startMs` may be wrong, in milliseconds, as the aligner judged it.
   * Sparse alignment interpolates between acoustic anchors, so a timing is only
   * as good as its distance to the nearest one. The read-to-listen handoff
   * subtracts this, which is what keeps a switch from landing on narration the
   * reader has not reached yet.
   */
  uncertaintyMs: z.number().int().min(0).default(0),
});
export type AlignmentSegment = z.infer<typeof alignmentSegmentSchema>;

export const alignmentGapSchema = z.object({
  fromMs: z.number().int().min(0),
  toMs: z.number().int().min(0),
  reason: z.enum(['narration-only', 'text-only', 'low-confidence']),
});
export type AlignmentGap = z.infer<typeof alignmentGapSchema>;

/**
 * How much of the narration a stretch must have that the ebook cannot
 * account for before read-along says "only in the audiobook".
 *
 * A gap in the alignment is not, by itself, narration the ebook lacks: text
 * the aligner could not place leaves a hole the same shape. What it lacks is
 * what is left of the hole once the untimed text inside it has been read
 * aloud at the book's own pace - a missing passage, an introduction, the
 * music after a part. Half a minute of that is a passage; less is a
 * reworded sentence or two, and saying so would be crying wolf.
 */
export const BEYOND_TEXT_MIN_MS = 30_000;

/** A stretch of the narration with no text in the ebook (see BEYOND_TEXT_MIN_MS). */
export const narrationBeyondTextSchema = z.object({
  /** Book-absolute milliseconds: from the end of the last synced sentence before it... */
  fromMs: z.number().int().min(0),
  /** ...to the start of the first one after it, or the end of the audiobook. */
  toMs: z.number().int().min(0),
  /** The narration in it that the untimed text between the two cannot account for. */
  extraMs: z.number().int().min(0),
  /** Before the book's first synced sentence, between two, or after its last. */
  where: z.enum(['start', 'middle', 'end']),
  /** Where the text picks up again; null after the last synced sentence. */
  resume: z
    .object({
      spineIdx: z.number().int().min(0),
      sentenceId: z.string(),
      /** The sentence's first character, in its chapter. */
      charOffset: z.number().int().min(0),
    })
    .nullable(),
});
export type NarrationBeyondText = z.infer<typeof narrationBeyondTextSchema>;

/**
 * A sync still under way, as read along sees it.
 *
 * A sync works through the book from the start forward, and everything it
 * has settled can be read along with at once - so a book is ready to read
 * along with from the beginning about half a minute after its sync starts,
 * not when the sync ends. This says how far that is.
 */
export const readAlongSyncSchema = z.object({
  /** Read along can follow the narration this far, in book milliseconds (0: not yet). */
  throughMs: z.number().min(0),
  /** The chapter (spine index) the synced part ends in; every chapter before it is wholly synced. -1: none yet. */
  throughSpine: z.number().int(),
  /** The whole narration, in milliseconds. */
  audioMs: z.number().min(0),
  /** Narration synced per millisecond of the sync's own time, for an estimate; 0 until measured. */
  rate: z.number().min(0),
  /** When `throughMs` last moved; null before it has. */
  updatedAt: z.string().nullable(),
  /** The sync is still working on the rest (or waiting its turn), rather than stopped. */
  active: z.boolean(),
});
export type ReadAlongSync = z.infer<typeof readAlongSyncSchema>;

export const alignmentSummarySchema = z.object({
  pairId: z.string(),
  version: z.number().int(),
  language: z.string(),
  model: z.string(),
  coverage: z.number().min(0).max(1),
  /**
   * Fraction of ebook sentences with a sentence-exact, high-confidence
   * mapping. This - not overall coverage - is what "exact" claims in the UI
   * must be based on.
   */
  exactSentenceCoverage: z.number().min(0).max(1),
  meanConfidence: z.number().min(0).max(1),
  segmentCount: z.number().int().min(0),
  gaps: z.array(alignmentGapSchema),
  createdAt: z.iso.datetime(),
});
export type AlignmentSummary = z.infer<typeof alignmentSummarySchema>;

/**
 * Per-pair switching status, exposed instead of a single boolean overclaim:
 * handoff availability, how much of the book is sentence-exact, and the rest
 * of the summary so clients can present honest expectations.
 */
export const handoffStatusSchema = z.object({
  available: z.boolean(),
  exactSentenceCoverage: z.number().min(0).max(1),
  coverage: z.number().min(0).max(1),
  meanConfidence: z.number().min(0).max(1),
});
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

/** Minimum confidence for a sentence-exact switch; below it we degrade. */
export const SWITCH_SENTENCE_CONFIDENCE = 0.6;
/** Below this, refuse the switch rather than guess. */
export const SWITCH_MIN_CONFIDENCE = 0.25;
/**
 * Fallback bound: how many sentences away a nearby aligned sentence may be
 * before a switch is refused (anchors returned instead of a silent jump).
 */
export const SWITCH_MAX_SENTENCE_DISTANCE = 8;
/** Audio-side bound: max ms past a segment's end before it is a gap, not a match. */
export const SWITCH_MAX_AUDIO_DRIFT_MS = 30_000;
/**
 * Ceiling on the backward step a read-to-listen switch takes to stay behind
 * the reader. A switch that rewinds further than this is not a safety margin
 * any more, it is a different place in the book.
 */
export const SWITCH_MAX_REWIND_MS = 45_000;

export const switchResolutionSchema = z.object({
  granularity: z.enum(['sentence', 'paragraph', 'chapter', 'none']),
  confidence: z.number().min(0).max(1),
  /** Provenance of the segment the resolution is based on. */
  source: alignmentSourceSchema.optional(),
  /** True when the resolution is a nearby-but-not-exact mapping. */
  approximate: z.boolean().optional(),
  /**
   * How far behind the requested position the answer deliberately lands, in
   * milliseconds. Present only on a read-to-listen switch that stepped back;
   * the player says so rather than letting the rewind look like a bug.
   */
  rewindMs: z.number().int().min(0).optional(),
  reason: z.string().optional(),
});
export type SwitchResolution = z.infer<typeof switchResolutionSchema>;
