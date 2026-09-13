import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../../context.js';
import { createApiKey, type ApiKeyRow } from '../../auth/apikeys.js';
import { newId } from '../../util/ids.js';
import { nowIso } from '../../db/index.js';

/**
 * Read-only API keys, for a person's own agents.
 *
 * Keys belong to a person and speak with that person's view of the library.
 * They are managed with a real session only: a key cannot list, mint or
 * revoke keys, which is enforced in the request hook rather than here so it
 * cannot be forgotten by a future route.
 */

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name').max(60),
});

interface KeyDto {
  id: string;
  name: string;
  /** The public half, for recognising a key in a list. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const toDto = (r: ApiKeyRow): KeyDto => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

export function registerKeyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const listFor = (userId: string): KeyDto[] =>
    (
      db
        .prepare(
          'SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
        )
        .all(userId) as unknown as ApiKeyRow[]
    ).map(toDto);

  app.get('/api/keys', async (req) => ({ keys: listFor(req.user!.id) }));

  app.post('/api/keys', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', message: parsed.error.issues[0]?.message });
    }
    // A cap, so a runaway script cannot fill the table.
    const count = (
      db
        .prepare('SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL')
        .get(req.user!.id) as { c: number }
    ).c;
    if (count >= 20) return reply.code(409).send({ error: 'too-many-keys' });

    const id = newId('key');
    const { key } = createApiKey(db, {
      id,
      userId: req.user!.id,
      name: parsed.data.name,
      now: nowIso(),
    });
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as unknown as ApiKeyRow;
    // The only time the secret exists outside the caller's hands. Not logged,
    // not recoverable: the server keeps a hash.
    return { key, apiKey: toDto(row) };
  });

  app.delete('/api/keys/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = db
      .prepare(
        'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      )
      .run(nowIso(), id, req.user!.id);
    // Scoped to the caller's own keys, so an id from someone else is simply
    // not found rather than a hint that it exists.
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    return { ok: true };
  });
}
