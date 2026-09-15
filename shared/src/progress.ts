import { z } from 'zod';
import { locatorSchema } from './locator.js';

/**
 * Loss-resistant progress contract.
 *
 * Clients write every checkpoint to IndexedDB first, then sync events that
 * are idempotent (client-generated UUID) and ordered (device/session/seq).
 * The server appends to history and reconciles; it never trusts "largest
 * percentage wins".
 *
 * Reconciliation rules (implemented server-side, tested):
 *  1. A duplicate eventId is acknowledged idempotently and changes nothing.
 *  2. Explicit intents (open/pause/seek/switch/finish) claim playback: they
 *     apply when they are newer than the current state's explicit claim
 *     (occurredAt, with per-session seq as tiebreak).
 *  3. Heartbeats only apply when they come from the session holding the
 *     claim. A stale background tab's heartbeats cannot override a newer
 *     foreground seek/rewind from another session or device.
 *  4. Explicit rewind is forward progress: intent wins, not percentage.
 */

export const progressIntentSchema = z.enum([
  'open',
  'heartbeat',
  'pause',
  'seek',
  'switch',
  'finish',
]);
export type ProgressIntent = z.infer<typeof progressIntentSchema>;

export const EXPLICIT_INTENTS: ReadonlySet<ProgressIntent> = new Set([
  'open',
  'pause',
  'seek',
  'switch',
  'finish',
]);

export const progressEventSchema = z.object({
  eventId: z.uuid(),
  bookId: z.string().min(1).max(64),
  deviceId: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(64),
  seq: z.number().int().min(0),
  /**
   * Client wall-clock time. Diagnostic metadata only: reconciliation clamps
   * it to the receiver's clock (+ small skew), so a device with a clock far
   * in the future cannot hold the claim forever (see reconcile.ts).
   */
  occurredAt: z.iso.datetime(),
  /**
   * Revision of the server state the client had last seen for this book.
   * When it matches the current revision, an explicit intent is causally
   * newer than the claim regardless of clock skew.
   */
  baseRevision: z.number().int().min(0).optional(),
  /** Server-issued reset generation. Omitted legacy events belong to generation zero. */
  generation: z.number().int().min(0).optional(),
  /**
   * The account that recorded this event, stamped by the client at capture
   * time. The queue lives in one browser that several people may sign in
   * to, and a checkpoint is one person's reading position: the server
   * refuses to file it under anybody else, whatever cookie delivers it.
   */
  ownerId: z.string().min(1).max(64).optional(),
  intent: progressIntentSchema,
  locator: locatorSchema,
});
export type ProgressEvent = z.infer<typeof progressEventSchema>;

/**
 * How far a client clock may be corrected. A batch says what time the
 * client thinks it is as it sends; the server measures the difference and
 * moves every event's effective time by it, so a device whose clock is an
 * hour slow does not lose every explicit move to a device whose clock is
 * right. Bounded, because past a day the "clock" is not a clock.
 */
export const MAX_CLOCK_CORRECTION_MS = 24 * 60 * 60_000;

export const progressBatchSchema = z.object({
  events: z.array(progressEventSchema).min(1).max(200),
  /** The queue owner the client believes it is delivering for; see `ownerId`. */
  ownerId: z.string().min(1).max(64).optional(),
  /** The client's wall clock at send time, for skew correction. */
  clientNow: z.iso.datetime().optional(),
});
export type ProgressBatch = z.infer<typeof progressBatchSchema>;

export const progressStateSchema = z.object({
  bookId: z.string(),
  generation: z.number().int().min(0).optional(),
  revision: z.number().int().min(0),
  locator: locatorSchema,
  intent: progressIntentSchema,
  occurredAt: z.iso.datetime(),
  sessionId: z.string(),
  deviceId: z.string(),
  seq: z.number().int(),
  updatedAt: z.iso.datetime(),
  finished: z.boolean(),
});
export type ProgressState = z.infer<typeof progressStateSchema>;

export const progressAckSchema = z.object({
  results: z.array(
    z.object({
      eventId: z.uuid(),
      /**
       * `applied` moved the state; `recorded` was kept in history but did
       * not move it (a stale heartbeat, a claim another session holds);
       * `duplicate` had been seen before; `rejected` is a durable verdict -
       * malformed, or filed under the wrong person - that a client should
       * drop rather than retry.
       */
      status: z.enum(['applied', 'recorded', 'duplicate', 'rejected']),
      reason: z.string().optional(),
    }),
  ),
  /**
   * The reconciled state of the LAST book in the batch. Kept for clients
   * older than `states`, which is the same value as its final entry.
   */
  state: progressStateSchema.nullable(),
  /**
   * The reconciled state of every book the batch touched, in the order they
   * first appeared in it. A flush usually carries several books - a phone
   * coming back online after a day has the novel it was reading and the
   * audiobook it was listening to - and acknowledging only the last one left
   * the others' revisions stale, so the next write for them raced.
   */
  states: z.array(progressStateSchema).default([]),
  /** Includes reset books with no remaining state. */
  generations: z
    .array(z.object({ bookId: z.string(), generation: z.number().int().min(0) }))
    .optional(),
});
export type ProgressAck = z.infer<typeof progressAckSchema>;
