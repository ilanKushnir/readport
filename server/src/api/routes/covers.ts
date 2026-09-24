import fs from 'node:fs';
import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../../context.js';
import { requireRole } from '../../auth/roles.js';
import { resolveSettings } from '../../domain/settings.js';
import { bookVisible, seesHidden } from '../../library/visibility.js';
import { IMAGE_TYPES } from '../../covers/image.js';
import {
  acceptCandidate,
  candidateFile,
  coverSuggestions,
  dismissSuggestions,
  removeFoundCover,
} from '../../covers/lookup.js';
import { bookRowToSummary } from './library.js';

/**
 * Covers for books without one: what could be used, the pictures to choose
 * from, and choosing (covers/lookup.ts).
 *
 * A curator's to do, as the rest of the library's curation is. Every route
 * here is under /api/books/:id and so behind the hidden-book guard for it.
 * Candidate pictures are served from ReadPort's own disk, never linked from
 * wherever they were found, so the page only ever shows what was checked.
 */

export function registerCoverRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  /**
   * What could be this book's cover. `?look=1` asks the sources an admin
   * chose now; otherwise they are asked only when an admin has turned
   * automatic suggestions on, and a lookup already made is simply shown.
   * `canLook` says whether there is anywhere to ask at all.
   */
  app.get('/api/books/:id/cover-suggestions', async (req, reply) => {
    if (!requireRole(req, reply, 'curator')) return reply;
    const { id } = req.params as { id: string };
    const q = z.object({ look: z.enum(['0', '1']).optional() }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'bad-query' });
    if (!bookVisible(db, id, seesHidden(req))) return reply.code(404).send({ error: 'not-found' });
    const { coverSuggestions: auto, coverSources: sources } = resolveSettings(
      db,
      ctx.config,
    ).values;
    const found = await coverSuggestions(ctx, id, { look: q.data.look === '1', auto, sources });
    return {
      state: found.state,
      auto,
      canLook: sources.length > 0,
      suggestions: found.candidates.map((c, n) => ({
        n,
        source: c.source,
        title: c.title,
        author: c.author,
        width: c.width,
        height: c.height,
      })),
    };
  });

  /** One candidate's picture, as ReadPort keeps it. */
  app.get('/api/books/:id/cover-suggestions/:n/image', async (req, reply) => {
    if (!requireRole(req, reply, 'curator')) return reply;
    const { id, n } = req.params as { id: string; n: string };
    const idx = Number(n);
    if (!Number.isInteger(idx) || idx < 0 || idx > 16)
      return reply.code(400).send({ error: 'bad-candidate' });
    const c = candidateFile(ctx, id, idx, resolveSettings(db, ctx.config).values.coverSources);
    if (!c || !fs.existsSync(c.file)) return reply.code(404).send({ error: 'not-found' });
    reply.header('content-type', IMAGE_TYPES[c.kind]);
    reply.header('x-content-type-options', 'nosniff');
    // A drawn cover (the other format's own) may style itself, and do nothing else.
    reply.header(
      'content-security-policy',
      c.kind === 'svg' ? "default-src 'none'; style-src 'unsafe-inline'" : "default-src 'none'",
    );
    reply.header('cache-control', 'private, max-age=600');
    return reply.send(fs.createReadStream(c.file));
  });

  /** Use a candidate as the book's cover (and its other format's, when that has none either). */
  app.post('/api/books/:id/cover-suggestions/:n/accept', async (req, reply) => {
    if (!requireRole(req, reply, 'curator')) return reply;
    const { id, n } = req.params as { id: string; n: string };
    const idx = Number(n);
    if (!Number.isInteger(idx) || idx < 0 || idx > 16)
      return reply.code(400).send({ error: 'bad-candidate' });
    const ids = acceptCandidate(ctx, id, idx, resolveSettings(db, ctx.config).values.coverSources);
    if (ids.length === 0) return reply.code(404).send({ error: 'not-found' });
    const row = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as Record<string, unknown>;
    return { book: bookRowToSummary(ctx, req.user!.id, row, seesHidden(req)), ids };
  });

  /** "None of these": nothing more is offered for this book until a curator asks. */
  app.post('/api/books/:id/cover-suggestions/dismiss', async (req, reply) => {
    if (!requireRole(req, reply, 'curator')) return reply;
    const { id } = req.params as { id: string };
    if (!db.prepare('SELECT 1 FROM books WHERE id = ?').get(id))
      return reply.code(404).send({ error: 'not-found' });
    dismissSuggestions(db, id, req.user!.id);
    return { ok: true };
  });

  /** Take a picked cover off: the book is coverless again, and may be offered others. */
  app.delete('/api/books/:id/found-cover', async (req, reply) => {
    if (!requireRole(req, reply, 'curator')) return reply;
    const { id } = req.params as { id: string };
    if (!removeFoundCover(ctx, id)) return reply.code(404).send({ error: 'no-found-cover' });
    const row = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as Record<string, unknown>;
    return { book: bookRowToSummary(ctx, req.user!.id, row, seesHidden(req)) };
  });
}
