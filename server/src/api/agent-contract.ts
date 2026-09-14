import { z } from 'zod';
import { locatorSchema } from '@readport/shared';

export const AGENT_SCOPE = 'agent:read';
export const AGENT_BASE = '/api/agent/v1';
export const AGENT_RATE_LIMIT = 120;
export const AGENT_WINDOW_MS = 60_000;
export const AGENT_RESPONSE_BYTES = 1024 * 1024;

/** Closed catalog: registering another route never grants a key access to it. */
export const AGENT_ROUTES = [
  AGENT_BASE,
  `${AGENT_BASE}/me`,
  `${AGENT_BASE}/books`,
  `${AGENT_BASE}/books/:id`,
  `${AGENT_BASE}/shelves`,
  `${AGENT_BASE}/shelves/:id/books`,
  `${AGENT_BASE}/reading-list`,
  `${AGENT_BASE}/annotations`,
  `${AGENT_BASE}/books/:id/progress`,
  `${AGENT_BASE}/books/:id/history`,
] as const;
const patterns = AGENT_ROUTES.map((route) => ({
  route,
  pattern: new RegExp(`^${route.replace(':id', '[A-Za-z0-9_-]{1,64}')}$`),
}));
export function agentRoute(pathname: string): string | undefined {
  return patterns.find(({ pattern }) => pattern.test(pathname))?.route;
}

const integerQuery = (min: number, max: number, fallback: string) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
export const agentPageQuery = z
  .object({
    limit: integerQuery(1, 100, '50'),
    offset: integerQuery(0, 100_000, '0'),
  })
  .strict();
export const agentBookQuery = agentPageQuery.extend({ query: z.string().max(200).optional() });
export const agentEmptyQuery = z.object({}).strict();

const text = z.string().max(500);
export const agentBookSchema = z.object({
  id: z.string().max(64),
  kind: z.enum(['ebook', 'audio']),
  title: text,
  author: text.nullable(),
  series: text.nullable(),
  format: z.string().max(32),
  durationMs: z.number().nullable(),
  addedAt: z.string().max(64),
  alignment: z.object({ coverage: z.number(), meanConfidence: z.number() }).nullable(),
});
export const agentProgressSchema = z.object({
  bookId: z.string().max(64),
  locator: locatorSchema.nullable(),
  finished: z.boolean(),
  updatedAt: z.string().max(64),
});
export const agentHistorySchema = z.object({
  locator: locatorSchema.nullable(),
  occurredAt: z.string().max(64),
  receivedAt: z.string().max(64),
  applied: z.boolean(),
});
export const agentShelfSchema = z.object({
  id: z.string().max(64),
  name: text,
  updatedAt: z.string().max(64),
});
export const agentListItemSchema = z.object({
  bookId: z.string().max(64),
  addedAt: z.string().max(64),
});
export const agentAnnotationSchema = z.object({
  id: z.string().max(64),
  bookId: z.string().max(64),
  kind: z.enum(['bookmark', 'highlight', 'note']),
  locator: locatorSchema.nullable(),
  note: z.string().max(2000).nullable(),
  noteTruncated: z.boolean(),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
});
export const agentUserSchema = z.object({
  id: z.string().max(64),
  username: text,
  displayName: text.nullable(),
});

export const AGENT_SCHEMAS = Object.fromEntries(
  Object.entries({
    book: agentBookSchema,
    progress: agentProgressSchema,
    history: agentHistorySchema,
    shelf: agentShelfSchema,
    readingListItem: agentListItemSchema,
    annotation: agentAnnotationSchema,
    user: agentUserSchema,
  }).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
);

/** Validate and strip unknown JSON keys; never return a raw stored object. */
export function agentLocator(raw: unknown): z.infer<typeof locatorSchema> | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const parsed = locatorSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    // Sentence ids are opaque content-derived identifiers, never file paths/CFIs.
    if (
      parsed.data.medium === 'ebook' &&
      parsed.data.sentenceId !== undefined &&
      !/^s[A-Za-z0-9_-]{1,63}$/.test(parsed.data.sentenceId)
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}
