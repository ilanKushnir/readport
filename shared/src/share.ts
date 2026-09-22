import { z } from 'zod';
import { bookKindSchema } from './api.js';

/**
 * Sharing a book, and letting the person it was shared with in.
 *
 * A share link is one person handing one book to someone - inside the house
 * or outside it. The token in the link resolves to a public teaser (title,
 * author, cover, who shared it) and, for whoever follows it, to a way in:
 * sign in if they have an account, or leave an address and wait for an admin
 * to approve them. Nothing here names the sharer's account: the public
 * answer carries a display name and nothing that could be used to find or
 * address them.
 */

/**
 * A share token: 24 random bytes as base64url, so 32 characters of
 * `[A-Za-z0-9_-]`. The pattern is what the routes accept, and it is looser
 * than what the server mints so a future token can grow without a client
 * refusing it.
 */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
export const shareTokenSchema = z.string().regex(SHARE_TOKEN_RE, 'Not a share token');

/** Where a share link points on the server that made it. */
export function sharePath(token: string): string {
  return `/s/${encodeURIComponent(token)}`;
}

export const JOIN_REQUEST_NAME_MAX = 80;
export const JOIN_REQUEST_MESSAGE_MAX = 500;

/**
 * An address, normalised so that "one open request per address" means one:
 * trimmed and lower-cased before it is compared or stored. The shape check
 * is deliberately loose - one `@`, something on both sides, no whitespace -
 * because the address is never mailed to; it is what an admin reads and
 * what the requester types again to check on their request.
 */
export const joinEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter an email address')
  .max(254, 'That address is too long')
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter an email address');

/** An optional line of text: blank means absent. */
const optionalLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((s) => (s ? s : undefined));

/** `POST /api/share/:token/join` */
export const joinRequestSchema = z.object({
  email: joinEmailSchema,
  name: optionalLine(JOIN_REQUEST_NAME_MAX),
  /** A line to the admin: who they are, why they want in. */
  message: optionalLine(JOIN_REQUEST_MESSAGE_MAX),
});
export type JoinRequestInput = z.infer<typeof joinRequestSchema>;

/** `GET /api/share/:token/join?email=` */
export const joinStatusQuerySchema = z.object({ email: joinEmailSchema });

export const joinStatusSchema = z.enum(['none', 'pending', 'approved', 'declined']);
export type JoinStatus = z.infer<typeof joinStatusSchema>;

/**
 * What the share page learns about a request by the address it remembers.
 * The invite token travels here and nowhere else, and only while the
 * request is approved and its invitation still open.
 */
export const joinStatusResponseSchema = z.object({
  status: joinStatusSchema,
  inviteToken: z.string().optional(),
});
export type JoinStatusResponse = z.infer<typeof joinStatusResponseSchema>;

/** The book, as far as someone without an account may see it. */
export const sharedBookSchema = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  kind: bookKindSchema,
  hasCover: z.boolean(),
});
export type SharedBook = z.infer<typeof sharedBookSchema>;

/** `GET /api/share/:token` */
export const sharePeekSchema = z.discriminatedUnion('valid', [
  z.object({
    valid: z.literal(true),
    book: sharedBookSchema,
    sharedBy: z.object({ displayName: z.string() }),
  }),
  z.object({ valid: z.literal(false) }),
]);
export type SharePeek = z.infer<typeof sharePeekSchema>;

/**
 * `POST /api/books/:id/share`. Exactly these two fields: the reader shares a
 * quotation through the same call, so the shape is a contract.
 */
export const createShareResponseSchema = z.object({ url: z.string(), token: z.string() });
export type CreateShareResponse = z.infer<typeof createShareResponseSchema>;

/** What an admin sees of a request: the person, and the book they came in through. */
export const joinRequestDtoSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  message: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'declined']),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  /** Null when the share was revoked or the book has left the library. */
  book: sharedBookSchema.nullable(),
  sharedBy: z.object({ displayName: z.string() }).nullable(),
});
export type JoinRequestDto = z.infer<typeof joinRequestDtoSchema>;

/**
 * Who put a book on somebody's reading list, when it was not the reader
 * themselves: a friend's recommendation or a share link.
 */
export const recommendedBySchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  at: z.string(),
});
export type RecommendedBy = z.infer<typeof recommendedBySchema>;

/** The optional provenance a client may attach when queueing a book. */
export const recommendedByIdSchema = z.string().min(1).max(64);
