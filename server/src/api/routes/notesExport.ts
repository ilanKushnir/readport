import fs from 'node:fs';
import { type FastifyInstance } from 'fastify';
import {
  NOTES_EXPORT_PREVIEW_PAGES,
  notesExportSchema,
  type NotesExportResult,
} from '@readport/shared';
import { type AppContext } from '../../context.js';
import { NotesTypesetter, TypesetterBusy } from '../../notes/pdf.js';
import { coverFormat, type TypesetJob } from '../../notes/typeset.js';

/** A document of ten thousand marks is a few megabytes of JSON. */
const BODY_LIMIT = 16 * 1024 * 1024;
/** Past this a cover is not a cover. */
const COVER_MAX_BYTES = 12 * 1024 * 1024;

/**
 * A book's highlights and notes as a PDF (shared/src/notesExport.ts).
 *
 * The app sends the document, written out in the reader's language; this
 * adds the book's cover and typesets it, and answers with the PDF and
 * pictures of its first pages, so the export page can show the reader the
 * very pages they are about to keep. The marks are the reader's own, sent
 * by the reader: nothing here reads anyone's annotations, and the book id
 * is only where the cover comes from (a hidden book is refused before this
 * runs, as every `/api/books/:id` route is).
 */
export function registerNotesExportRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const typesetter = new NotesTypesetter();
  app.addHook('onClose', async () => typesetter.close());

  const readCover = (file: string | null): TypesetJob['cover'] => {
    if (!file) return null;
    try {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.size === 0 || stat.size > COVER_MAX_BYTES) return null;
      const bytes = new Uint8Array(fs.readFileSync(file));
      const format = coverFormat(bytes);
      return format ? { bytes, format } : null;
    } catch {
      return null;
    }
  };

  app.post('/api/books/:id/notes/export', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const book = db.prepare('SELECT cover_path FROM books WHERE id = ?').get(id) as
      { cover_path: string | null } | undefined;
    if (!book) return reply.code(404).send({ error: 'not-found' });
    const parsed = notesExportSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const document = parsed.data;
    try {
      const result = await typesetter.typeset({
        document,
        cover: document.cover ? readCover(book.cover_path) : null,
        previewPages: NOTES_EXPORT_PREVIEW_PAGES,
      });
      reply.header('cache-control', 'no-store');
      const body: NotesExportResult = {
        pageCount: result.pageCount,
        pages: result.pages,
        pdf: Buffer.from(result.pdf.buffer, result.pdf.byteOffset, result.pdf.byteLength).toString(
          'base64',
        ),
      };
      return body;
    } catch (e) {
      if (e instanceof TypesetterBusy) return reply.code(503).send({ error: 'busy' });
      req.log.error({ err: e, bookId: id }, 'notes export failed');
      return reply.code(500).send({ error: 'export-failed' });
    }
  });
}
