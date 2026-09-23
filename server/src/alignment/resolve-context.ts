import { type AppContext, activeDerivedDir } from '../context.js';
import { loadManifest, loadSentences } from '../epub/extract.js';
import { latestAlignment, type ResolveContext } from './service.js';

/**
 * Everything a switch between a pair's two editions needs, for one pair:
 * its latest alignment, the ebook's sentence index and chapter offsets, and
 * the audiobook's track layout. Null when the pair is not settled, has not
 * been aligned, or its ebook has no index to resolve against.
 */
export function pairResolveContext(
  ctx: AppContext,
  pairId: string,
): { rctx: ResolveContext; ebookId: string; audioId: string } | null {
  const { db } = ctx;
  const pair = db
    .prepare(`SELECT id, ebook_id, audio_id, status FROM pairs WHERE id = ?`)
    .get(pairId) as { id: string; ebook_id: string; audio_id: string; status: string } | undefined;
  if (!pair || !['auto', 'confirmed'].includes(pair.status)) return null;
  const handle = latestAlignment(db, pair.id);
  if (!handle) return null;
  const dir = activeDerivedDir(ctx, pair.ebook_id);
  const manifest = loadManifest(dir);
  const sentences = loadSentences(dir);
  if (!manifest || !sentences) return null;
  const tracks = db
    .prepare(
      'SELECT start_ms_absolute, duration_ms FROM audio_tracks WHERE book_id = ? ORDER BY idx',
    )
    .all(pair.audio_id) as { start_ms_absolute: number; duration_ms: number }[];
  return {
    ebookId: pair.ebook_id,
    audioId: pair.audio_id,
    rctx: {
      db,
      alignmentId: handle.alignmentId,
      gaps: handle.summary.gaps,
      tracks: tracks.map((t) => ({
        startMsAbsolute: Number(t.start_ms_absolute),
        durationMs: Number(t.duration_ms),
      })),
      sentences,
      chapterCumChars: manifest.chapters.map((c) => c.cumChars),
      totalChars: manifest.totalChars,
    },
  };
}

/** The settled pair a book is in, when it is in one: the confirmed one first. */
export function settledPairOf(
  ctx: AppContext,
  bookId: string,
): { id: string; ebook_id: string; audio_id: string } | null {
  return (
    (ctx.db
      .prepare(
        `SELECT id, ebook_id, audio_id FROM pairs
          WHERE (ebook_id = ? OR audio_id = ?) AND status IN ('auto','confirmed')
          ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, score DESC LIMIT 1`,
      )
      .get(bookId, bookId) as { id: string; ebook_id: string; audio_id: string } | undefined) ??
    null
  );
}
