import { type FastifyInstance } from 'fastify';
import { type AppContext } from '../../context.js';
import { type DB } from '../../db/index.js';
import {
  AGENT_BASE,
  AGENT_SCOPE,
  AGENT_ROUTES,
  AGENT_RATE_LIMIT,
  AGENT_WINDOW_MS,
  AGENT_RESPONSE_BYTES,
  AGENT_SCHEMAS,
  agentPageQuery,
  agentBookQuery,
  agentEmptyQuery,
  agentBookSchema,
  agentProgressSchema,
  agentHistorySchema,
  agentShelfSchema,
  agentListItemSchema,
  agentAnnotationSchema,
  agentUserSchema,
  agentLocator,
} from '../agent-contract.js';

type Row = Record<string, unknown>;

/** Bound UTF-16 length without splitting a surrogate pair. SQL already caps
 * materialized input by code points; this aligns it with the wire schema. */
function boundedText(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  let result = '';
  for (const char of value) {
    if (result.length + char.length > max) break;
    result += char;
  }
  return result;
}

/** A single atomic statement: concurrent processes cannot both spend the last slot.
 * Reuses the durable throttle store, but never the browser-login namespace.
 * One bounded counter per real user; expired rows use the existing pruning job.
 */
export function allowAgentRead(db: DB, userId: string): boolean {
  const now = Date.now();
  const result = db
    .prepare(
      `
    INSERT INTO login_throttle (key, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
    WHERE reset_at <= ? OR count < ?
    RETURNING count
  `,
    )
    .get(`agent:user:${userId}`, now + AGENT_WINDOW_MS, now, now, now, AGENT_RATE_LIMIT);
  return result !== undefined;
}

// Project safe fields in SQL, before materialization. No filesystem operations,
// raw metadata, diagnostic strings, file locators or legacy summary helpers.
const BOOK_COLUMNS = `b.id, b.kind, substr(b.title,1,500) AS title,
  substr(b.author,1,500) AS author, substr(b.series,1,500) AS series,
  substr(b.format,1,32) AS format, b.duration_ms AS durationMs,
  substr(b.added_at,1,64) AS addedAt`;
const LOCATOR_COLUMN =
  'CASE WHEN length(locator_json) <= 4096 THEN locator_json ELSE NULL END AS locator';

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const bookDto = (row: Row) => {
    // Only aggregate quality, not provenance, gaps, segments or model paths.
    const alignment =
      db
        .prepare(
          `
      SELECT a.coverage, a.mean_confidence AS meanConfidence
      FROM pairs p JOIN alignments a ON a.pair_id = p.id
      WHERE (p.ebook_id = ? OR p.audio_id = ?) AND p.status IN ('auto','confirmed')
        AND a.status = 'ready'
      ORDER BY CASE p.status WHEN 'confirmed' THEN 0 ELSE 1 END,
        p.score DESC, p.id, a.version DESC LIMIT 1
    `,
        )
        .get(row.id as string, row.id as string) ?? null;
    return agentBookSchema.parse({
      ...row,
      title: boundedText(row.title),
      author: boundedText(row.author),
      series: boundedText(row.series),
      format: boundedText(row.format, 32),
      alignment,
    });
  };
  const exists = (id: string) =>
    db.prepare("SELECT 1 FROM books WHERE id = ? AND scan_state != 'missing'").get(id);
  const page = <T>(rows: Row[], limit: number, offset: number, map: (row: Row) => T) => ({
    items: rows.slice(0, limit).map(map),
    nextOffset: rows.length > limit ? offset + limit : null,
  });

  for (const route of AGENT_ROUTES) {
    app.get(route, { exposeHeadRoute: false, bodyLimit: 1024 }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (req.authVia !== 'apikey') return reply.code(403).send({ error: 'forbidden' });
      const userId = req.user!.id;
      const { id } = req.params as { id: string };
      const isBooks = route === `${AGENT_BASE}/books`;
      const paginated =
        isBooks ||
        [
          `${AGENT_BASE}/shelves`,
          `${AGENT_BASE}/shelves/:id/books`,
          `${AGENT_BASE}/reading-list`,
          `${AGENT_BASE}/annotations`,
          `${AGENT_BASE}/books/:id/history`,
        ].includes(route);
      const schema = isBooks ? agentBookQuery : paginated ? agentPageQuery : agentEmptyQuery;
      const parsed = schema.safeParse(req.query ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'bad-query' });
      // The page schema above validated these before any query is executed.
      const {
        limit = 50,
        offset = 0,
        query = '',
      } = parsed.data as { limit?: number; offset?: number; query?: string };

      switch (route) {
        case AGENT_BASE:
          return {
            version: '1',
            basePath: AGENT_BASE,
            authentication: { scheme: 'Bearer', scopes: [AGENT_SCOPE] },
            readOnly: true,
            routes: AGENT_ROUTES.map((path) => ({ method: 'GET', path, scope: AGENT_SCOPE })),
            pagination: { defaultLimit: 50, maxLimit: 100, maxOffset: 100000 },
            limits: { requestsPerMinute: AGENT_RATE_LIMIT, responseBytes: AGENT_RESPONSE_BYTES },
            schemas: AGENT_SCHEMAS,
          };
        case `${AGENT_BASE}/me`:
          return {
            user: agentUserSchema.parse({
              id: userId,
              username: boundedText(req.user!.username),
              displayName: boundedText(req.user!.displayName),
            }),
            scopes: [AGENT_SCOPE],
          };
        case `${AGENT_BASE}/books`: {
          // instr implements literal substring search: % and _ are not wildcards.
          const rows = db
            .prepare(
              `SELECT ${BOOK_COLUMNS} FROM books b
            WHERE b.scan_state != 'missing' AND (? = '' OR
              instr(lower(b.title), lower(?)) > 0 OR instr(lower(coalesce(b.author,'')), lower(?)) > 0
              OR instr(lower(coalesce(b.series,'')), lower(?)) > 0)
            ORDER BY b.title COLLATE NOCASE, b.id LIMIT ? OFFSET ?
          `,
            )
            .all(query, query, query, query, limit + 1, offset) as Row[];
          return page(rows, limit, offset, bookDto);
        }
        case `${AGENT_BASE}/books/:id`: {
          const row = db
            .prepare(
              `SELECT ${BOOK_COLUMNS} FROM books b WHERE b.id = ? AND b.scan_state != 'missing'`,
            )
            .get(id) as Row | undefined;
          return row ? { book: bookDto(row) } : reply.code(404).send({ error: 'not-found' });
        }
        case `${AGENT_BASE}/shelves`: {
          const rows = db
            .prepare(
              `SELECT id, substr(name,1,500) AS name, substr(updated_at,1,64) AS updatedAt
            FROM shelves WHERE user_id = ? ORDER BY sort_key, id LIMIT ? OFFSET ?`,
            )
            .all(userId, limit + 1, offset) as Row[];
          return page(rows, limit, offset, (r) =>
            agentShelfSchema.parse({ ...r, name: boundedText(r.name) }),
          );
        }
        case `${AGENT_BASE}/shelves/:id/books`: {
          if (!db.prepare('SELECT 1 FROM shelves WHERE id = ? AND user_id = ?').get(id, userId)) {
            return reply.code(404).send({ error: 'not-found' });
          }
          const rows = db
            .prepare(
              `SELECT ${BOOK_COLUMNS} FROM shelf_items i
            JOIN shelves s ON s.id = i.shelf_id JOIN books b ON b.id = i.book_id
            WHERE s.id = ? AND s.user_id = ? AND b.scan_state != 'missing'
            ORDER BY i.sort_key, b.id LIMIT ? OFFSET ?`,
            )
            .all(id, userId, limit + 1, offset) as Row[];
          return page(rows, limit, offset, bookDto);
        }
        case `${AGENT_BASE}/reading-list`: {
          const rows = db
            .prepare(
              `SELECT r.book_id AS bookId, substr(r.added_at,1,64) AS addedAt
            FROM reading_list r JOIN books b ON b.id = r.book_id
            WHERE r.user_id = ? AND b.scan_state != 'missing'
            ORDER BY r.sort_key, r.book_id LIMIT ? OFFSET ?`,
            )
            .all(userId, limit + 1, offset) as Row[];
          return page(rows, limit, offset, (r) => agentListItemSchema.parse(r));
        }
        case `${AGENT_BASE}/annotations`: {
          const rows = db
            .prepare(
              `SELECT a.id, a.book_id AS bookId, a.kind, ${LOCATOR_COLUMN},
              substr(a.note,1,2000) AS note, length(a.note) > 2000 AS noteTruncated,
              substr(a.created_at,1,64) AS createdAt, substr(a.updated_at,1,64) AS updatedAt
            FROM annotations a JOIN books b ON b.id = a.book_id
            WHERE a.user_id = ? AND a.deleted_at IS NULL AND b.scan_state != 'missing'
            ORDER BY a.created_at DESC, a.id LIMIT ? OFFSET ?`,
            )
            .all(userId, limit + 1, offset) as Row[];
          return page(rows, limit, offset, (r) =>
            agentAnnotationSchema.parse({
              ...r,
              note: boundedText(r.note, 2000),
              noteTruncated:
                Boolean(r.noteTruncated) || (typeof r.note === 'string' && r.note.length > 2000),
              locator: agentLocator(r.locator),
            }),
          );
        }
        case `${AGENT_BASE}/books/:id/progress`: {
          if (!exists(id)) return reply.code(404).send({ error: 'not-found' });
          const row = db
            .prepare(
              `SELECT book_id AS bookId, ${LOCATOR_COLUMN}, finished, substr(updated_at,1,64) AS updatedAt
            FROM progress_state WHERE user_id = ? AND book_id = ?`,
            )
            .get(userId, id) as Row | undefined;
          return {
            progress: row
              ? agentProgressSchema.parse({
                  ...row,
                  finished: Boolean(row.finished),
                  locator: agentLocator(row.locator),
                })
              : null,
          };
        }
        case `${AGENT_BASE}/books/:id/history`: {
          if (!exists(id)) return reply.code(404).send({ error: 'not-found' });
          const rows = db
            .prepare(
              `SELECT ${LOCATOR_COLUMN}, substr(occurred_at,1,64) AS occurredAt,
              substr(received_at,1,64) AS receivedAt, applied
            FROM progress_events WHERE user_id = ? AND book_id = ?
            ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`,
            )
            .all(userId, id, limit + 1, offset) as Row[];
          return page(rows, limit, offset, (r) =>
            agentHistorySchema.parse({
              ...r,
              applied: Boolean(r.applied),
              locator: agentLocator(r.locator),
            }),
          );
        }
      }
    });
  }
}
