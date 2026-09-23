import { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  locatorSchema,
  type TranslationMapResponse,
  type TranslationPairSuggestion,
} from '@readport/shared';
import { type AppContext } from '../../context.js';
import { hasRole, requireRole } from '../../auth/roles.js';
import { bookVisible, seesHidden } from '../../library/visibility.js';
import {
  dismissSuggestion,
  linkTranslations,
  TranslationLinkError,
  translationBookIds,
  unlinkTranslation,
} from '../../translations/groups.js';
import { suggestionDto, translationTitles } from '../../translations/editions.js';
import { ensureMatches } from '../../translations/store.js';
import { librarySuggestions, suggestionsFor, type TitleFacts } from '../../translations/suggest.js';
import { carryPlace, passageIn } from '../../translations/map.js';

/**
 * The same book in other languages: which they are, linking and unlinking
 * them, the guesses, and carrying a place or a passage from one to another.
 *
 * Reading any of it is anyone's; changing it is a curator's, as pairing is.
 * Every route under /api/books/:id is behind the hidden-book guard for that
 * id; the OTHER book a request names is checked here, the same way, so a
 * reader can neither link to nor learn anything about a book hidden from
 * them.
 */

const idSchema = z.string().min(1).max(64);

export function registerTranslationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const exists = (id: string, sees: boolean) => bookVisible(db, id, sees);
  const titles = (req: { user: { id: string } | null }, id: string, sees: boolean) =>
    translationTitles(ctx, req.user!.id, id, sees);

  const refuse = (reply: FastifyReply, err: unknown) => {
    if (err instanceof TranslationLinkError)
      return reply.code(err.code === 'not-found' ? 404 : 409).send({ error: err.code });
    throw err;
  };

  /** The other languages of a book; a curator also gets the guesses. */
  app.get('/api/books/:id/translations', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sees = seesHidden(req);
    if (!exists(id, sees)) return reply.code(404).send({ error: 'not-found' });
    const curator = hasRole(req.user?.role, 'curator');
    return {
      titles: titles(req, id, sees),
      suggestions: curator ? suggestionsFor(db, id, sees).map(suggestionDto) : [],
      canLink: curator,
    };
  });

  /** Link another book as this one in another language. */
  app.post('/api/books/:id/translations', async (req, reply) => {
    if (!requireRole(req, reply, 'curator')) return reply;
    const { id } = req.params as { id: string };
    const body = z.object({ otherBookId: idSchema }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const sees = seesHidden(req);
    if (!exists(id, sees) || !exists(body.data.otherBookId, sees))
      return reply.code(404).send({ error: 'not-found' });
    try {
      linkTranslations(db, id, body.data.otherBookId, req.user!.id);
    } catch (err) {
      return refuse(reply, err);
    }
    ensureMatches(db, id);
    return { titles: titles(req, id, sees) };
  });

  /** "Not the same book after all": take a title out of this book's work. */
  app.delete('/api/books/:id/translations/:otherId', async (req, reply) => {
    if (!requireRole(req, reply, 'curator')) return reply;
    const { id, otherId } = req.params as { id: string; otherId: string };
    const sees = seesHidden(req);
    if (!exists(id, sees) || !exists(otherId, sees))
      return reply.code(404).send({ error: 'not-found' });
    if (!unlinkTranslation(db, id, otherId, req.user!.id))
      return reply.code(404).send({ error: 'not-linked' });
    return { titles: titles(req, id, sees) };
  });

  /** "These are not the same book": the guess goes and stays gone. */
  app.post('/api/books/:id/translations/dismiss', async (req, reply) => {
    if (!requireRole(req, reply, 'curator')) return reply;
    const { id } = req.params as { id: string };
    const body = z.object({ otherBookId: idSchema }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const sees = seesHidden(req);
    if (!exists(id, sees) || !exists(body.data.otherBookId, sees))
      return reply.code(404).send({ error: 'not-found' });
    dismissSuggestion(db, id, body.data.otherBookId, req.user!.id);
    return { ok: true };
  });

  /** Every guess in the library, for the page that reviews them together. */
  app.get('/api/translations/suggestions', async (req, reply) => {
    if (!requireRole(req, reply, 'curator')) return reply;
    const face = (t: TitleFacts) => ({
      language: t.language,
      title: t.title,
      author: t.author,
      books: t.books,
    });
    const suggestions: TranslationPairSuggestion[] = librarySuggestions(db, seesHidden(req)).map(
      (s) => ({ a: face(s.a), b: face(s.b), score: s.score, evidence: s.evidence }),
    );
    return { suggestions };
  });

  /**
   * Carry a place in this book to one of its other languages - where to
   * carry on reading from (`start`), or where the same point is (`point`).
   */
  app.post('/api/books/:id/translations/map', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        from: locatorSchema,
        toBookId: idSchema,
        mode: z.enum(['start', 'point']).default('start'),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const sees = seesHidden(req);
    const { from, toBookId, mode } = body.data;
    if (!exists(id, sees) || !exists(toBookId, sees))
      return reply.code(404).send({ error: 'not-found' });
    // Only across a link: this is not a way to find places in any book.
    if (!translationBookIds(db, id).includes(toBookId))
      return reply.code(409).send({ error: 'not-linked' });
    const carried = carryPlace(ctx, id, from, toBookId, mode);
    if (!carried) return reply.code(409).send({ error: 'no-place' });
    const out: TranslationMapResponse = { bookId: toBookId, ...carried };
    return out;
  });

  /** The passage around a place, as another language's ebook has it. */
  app.get('/api/books/:id/translations/passage', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z
      .object({
        to: idSchema,
        spine: z.coerce.number().int().min(0),
        start: z.coerce.number().int().min(0),
        end: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'bad-query' });
    const sees = seesHidden(req);
    const { to, spine, start } = q.data;
    if (!exists(id, sees) || !exists(to, sees)) return reply.code(404).send({ error: 'not-found' });
    if (!translationBookIds(db, id).includes(to))
      return reply.code(409).send({ error: 'not-linked' });
    const passage = passageIn(
      ctx,
      id,
      spine,
      start,
      Math.max(start + 1, q.data.end ?? start + 1),
      to,
    );
    if (!passage) return reply.code(409).send({ error: 'not-matched' });
    return passage;
  });
}
