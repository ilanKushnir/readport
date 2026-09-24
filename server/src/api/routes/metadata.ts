import fs from 'node:fs';
import path from 'node:path';
import { type FastifyInstance } from 'fastify';
import { type BookMetadata } from '@readport/shared';
import { type AppContext } from '../../context.js';
import { requireRole } from '../../auth/roles.js';

/**
 * A book's metadata, for an admin: the file behind it and where it is, what
 * the file says about itself, and what ReadPort made of it. The paths name
 * the server's own disk, so they are an admin's and nobody else's.
 */

const json = (raw: unknown): Record<string, unknown> => {
  try {
    const v = JSON.parse(String(raw ?? '{}')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export function bookMetadata(ctx: AppContext, row: Record<string, unknown>): BookMetadata {
  const { db } = ctx;
  const id = String(row.id);
  const kind = row.kind === 'audio' ? 'audio' : 'ebook';
  const library = String(row.root_dir);
  const rel = String(row.rel_path);
  const full = path.join(library, rel);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(full, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }
  const folder = path.posix.dirname(rel.split(path.sep).join('/'));
  const meta = json(row.meta_json);
  const identifiers = Object.fromEntries(
    Object.entries(json(row.identifiers_json))
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .map(([k, v]) => [k, String(v)]),
  );
  const tags = (
    db
      .prepare(
        "SELECT kind, value FROM book_facets WHERE book_id = ? AND kind != 'publisher' ORDER BY kind, value",
      )
      .all(id) as { kind: string; value: string }[]
  ).map((t) => ({ kind: t.kind, value: t.value }));
  const tracks =
    kind === 'audio'
      ? (
          db
            .prepare(
              `SELECT rel_path, format, size_bytes, duration_ms, title
                 FROM audio_tracks WHERE book_id = ? ORDER BY idx`,
            )
            .all(id) as {
            rel_path: string;
            format: string;
            size_bytes: number;
            duration_ms: number;
            title: string | null;
          }[]
        ).map((t) => ({
          name: path.posix.relative(rel.split(path.sep).join('/'), t.rel_path) || t.rel_path,
          format: t.format,
          sizeBytes: Number(t.size_bytes ?? 0),
          durationMs: Number(t.duration_ms ?? 0),
          title: str(t.title),
        }))
      : [];
  const chapters = (
    db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?').get(id) as { n: number }
  ).n;
  const pairRow = db
    .prepare(
      `SELECT b.title, b.kind, p.status FROM pairs p
         JOIN books b ON b.id = CASE WHEN p.ebook_id = ? THEN p.audio_id ELSE p.ebook_id END
        WHERE (p.ebook_id = ? OR p.audio_id = ?) AND p.status != 'rejected'
        ORDER BY CASE p.status WHEN 'confirmed' THEN 0 WHEN 'auto' THEN 1 ELSE 2 END LIMIT 1`,
    )
    .get(id, id, id) as { title: string; kind: string; status: string } | undefined;
  const hiddenBy = row.hidden_by
    ? ((
        db
          .prepare('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?')
          .get(String(row.hidden_by)) as { name: string } | undefined
      )?.name ?? null)
    : null;
  const coverPath = str(row.cover_path);
  const cover: BookMetadata['readport']['cover'] =
    coverPath && fs.existsSync(coverPath)
      ? coverPath === row.found_cover_path
        ? 'picked'
        : 'own'
      : 'none';
  return {
    file: {
      name: path.basename(rel),
      folder: folder === '.' ? '' : folder,
      library,
      path: full,
      isFolder: stat?.isDirectory() ?? kind === 'audio',
      format: String(row.format ?? ''),
      sizeBytes: Number(row.size_bytes ?? 0),
      modifiedAt: stat ? stat.mtime.toISOString() : null,
      present: Boolean(stat),
      contentHash: str(row.content_hash),
    },
    tracks,
    embedded: {
      title: String(row.title),
      author: str(row.author),
      series: str(row.series),
      seriesIdx: typeof row.series_idx === 'number' ? row.series_idx : null,
      language: str(row.language_metadata),
      publisher: str(meta.publisher),
      identifiers,
      tags,
      description: Boolean(str(meta.description)),
    },
    readport: {
      id,
      addedAt: String(row.added_at),
      indexedAt: str(row.scanned_at),
      state: String(row.scan_state),
      error: str(row.scan_error),
      language: {
        value: str(row.language),
        source: str(row.language_source),
        manual: str(row.language_manual),
        detected: str(row.language_detected),
      },
      cover,
      coverSource: cover === 'picked' ? str(row.found_cover_source) : null,
      chapters: Number(chapters),
      characters: typeof meta.totalChars === 'number' ? meta.totalChars : null,
      durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : null,
      pair: pairRow
        ? {
            title: pairRow.title,
            kind: pairRow.kind === 'audio' ? 'audio' : 'ebook',
            status: pairRow.status,
          }
        : null,
      hidden: row.hidden_at ? { at: String(row.hidden_at), by: hiddenBy } : null,
    },
  };
}

export function registerMetadataRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/books/:id/metadata', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return reply;
    const { id } = req.params as { id: string };
    const row = ctx.db.prepare('SELECT * FROM books WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: 'not-found' });
    return bookMetadata(ctx, row);
  });
}
