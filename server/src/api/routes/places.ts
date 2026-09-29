import { type FastifyInstance } from 'fastify';
import { type ReadingPlace, forgetReadingPlace, readingPlaces } from '@readport/shared';
import { type AppContext, activeDerivedDir } from '../../context.js';
import { loadChapterText, loadManifest, loadSentences } from '../../epub/extract.js';
import { readPlacesDoc, writePlacesDoc } from '../../progress/places.js';

/** How long the words shown for a place may run, cut at a word. */
const EXCERPT_MAX = 160;

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_MAX) return flat;
  const cut = flat.slice(0, EXCERPT_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > EXCERPT_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`;
}

/**
 * A person's places in a book: the one they read, and the others they read
 * on at for a while. Each comes with its chapter's name and the sentence it
 * stopped in, so it is known by what it says rather than by a percentage.
 */
export function registerPlacesRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const view = (userId: string, bookId: string): ReadingPlace[] => {
    const shown = readingPlaces(readPlacesDoc(db, userId, bookId));
    if (shown.length === 0) return [];
    const dir = activeDerivedDir(ctx, bookId);
    const manifest = loadManifest(dir);
    const sentences = loadSentences(dir);
    const texts = new Map<number, string | null>();
    const textOf = (spineIdx: number) => {
      if (!texts.has(spineIdx)) texts.set(spineIdx, loadChapterText(dir, spineIdx));
      return texts.get(spineIdx) ?? null;
    };
    return shown.map(({ thread, main, current }) => {
      const { spineIdx, charOffset, sentenceId } = thread.locator;
      // Named as the contents name it: the entry the place falls under.
      const entry = manifest?.toc.filter((e) => e.spineIdx <= spineIdx).at(-1);
      const chapter = entry?.title || manifest?.chapters[spineIdx]?.title || null;
      const inChapter = sentences?.[spineIdx] ?? [];
      const at = charOffset ?? 0;
      // The sentence the place is in; at a chapter's head, before its first
      // sentence, the one it opens with.
      const sentence =
        (sentenceId && inChapter.find((s) => s.id === sentenceId)) ||
        inChapter.find((s) => at >= s.start && at < s.end) ||
        inChapter.find((s) => s.start >= at) ||
        null;
      const text = sentence ? textOf(spineIdx)?.slice(sentence.start, sentence.end) : null;
      return {
        id: thread.id,
        main,
        current,
        locator: thread.locator,
        fromPct: thread.from,
        readMs: Math.round(thread.readMs),
        startedAt: thread.startedAt,
        lastReadAt: thread.lastAt,
        chapter,
        excerpt: text ? excerptOf(text) || null : null,
      };
    });
  };

  const bookExists = (id: string) => !!db.prepare('SELECT 1 FROM books WHERE id = ?').get(id);

  app.get('/api/books/:id/places', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!bookExists(id)) return reply.code(404).send({ error: 'not-found' });
    return { places: view(req.user!.id, id) };
  });

  /** Forget a place, as its reader asked. The next reading there starts it again. */
  app.delete('/api/books/:id/places/:placeId', async (req, reply) => {
    const { id, placeId } = req.params as { id: string; placeId: string };
    if (!bookExists(id)) return reply.code(404).send({ error: 'not-found' });
    const doc = readPlacesDoc(db, req.user!.id, id);
    if (!doc.threads.some((t) => t.id === placeId)) {
      return reply.code(404).send({ error: 'no-place' });
    }
    writePlacesDoc(db, req.user!.id, id, forgetReadingPlace(doc, placeId));
    return { places: view(req.user!.id, id) };
  });
}
