import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { type DB, nowIso } from '../db/index.js';
import { stableId } from '../util/ids.js';

/**
 * Read-only filesystem scan of configured library roots. Discovers EPUBs and
 * audiobooks (single files or one-directory-per-book track sets), upserts
 * book rows, and reports which books need (re)indexing. Never writes inside
 * a library root.
 */

export const EBOOK_EXTS = new Set(['.epub']);
export const AUDIO_EXTS = new Set(['.m4b', '.mp3', '.m4a', '.flac', '.ogg', '.opus']);
/** Detected but honestly unsupported for reading in V1. */
export const KNOWN_UNSUPPORTED_EBOOK = new Set(['.pdf', '.mobi', '.azw3', '.azw', '.cbz', '.cbr']);

const MAX_DEPTH = 8;
const MAX_FILES = 100_000;

export interface DiscoveredEbook {
  rootDir: string;
  relPath: string;
  sizeBytes: number;
  contentHash: string;
}

export interface DiscoveredAudioBook {
  rootDir: string;
  /** rel path of the directory (multi-file) or the file itself. */
  relPath: string;
  tracks: { relPath: string; sizeBytes: number; ext: string }[];
  sizeBytes: number;
  contentHash: string;
}

export interface ScanReport {
  ebooks: DiscoveredEbook[];
  audiobooks: DiscoveredAudioBook[];
  unsupported: { relPath: string; ext: string }[];
  errors: string[];
}

function quickHash(filePath: string, stat: fs.Stats): string {
  // Cheap change-detection hash: size + mtime + head/tail bytes. Not a
  // cryptographic identity of content; used to decide when to re-index.
  const h = createHash('sha256');
  h.update(`${stat.size}:${Math.floor(stat.mtimeMs)}`);
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(Math.min(65536, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    h.update(head);
    if (stat.size > 65536) {
      const tail = Buffer.alloc(65536);
      fs.readSync(fd, tail, 0, tail.length, stat.size - 65536);
      h.update(tail);
    }
    fs.closeSync(fd);
  } catch {
    /* hash stays size+mtime based */
  }
  return h.digest('hex').slice(0, 32);
}

/** Natural sort so "Track 2" < "Track 10". */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export function scanRoots(ebookRoots: string[], audioRoots: string[]): ScanReport {
  const report: ScanReport = { ebooks: [], audiobooks: [], unsupported: [], errors: [] };
  let fileCount = 0;

  const walk = (
    root: string,
    dir: string,
    depth: number,
    onFile: (abs: string, rel: string, ext: string, stat: fs.Stats) => void,
  ) => {
    if (depth > MAX_DEPTH || fileCount > MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      report.errors.push(`Cannot read ${dir}: ${(err as Error).message}`);
      return;
    }
    entries.sort((a, b) => naturalCompare(a.name, b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        // Follow only symlinks that resolve inside the root.
        try {
          const real = fs.realpathSync(abs);
          const rootReal = fs.realpathSync(root);
          if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue;
        } catch {
          continue;
        }
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(root, abs, depth + 1, onFile);
      } else if (stat.isFile()) {
        fileCount += 1;
        const ext = path.extname(e.name).toLowerCase();
        onFile(abs, path.relative(root, abs), ext, stat);
      }
    }
  };

  for (const root of ebookRoots) {
    if (!fs.existsSync(root)) {
      report.errors.push(`Ebook root does not exist: ${root}`);
      continue;
    }
    walk(root, root, 0, (abs, rel, ext, stat) => {
      if (EBOOK_EXTS.has(ext)) {
        report.ebooks.push({
          rootDir: root,
          relPath: rel,
          sizeBytes: stat.size,
          contentHash: quickHash(abs, stat),
        });
      } else if (KNOWN_UNSUPPORTED_EBOOK.has(ext)) {
        report.unsupported.push({ relPath: rel, ext });
      }
    });
  }

  for (const root of audioRoots) {
    if (!fs.existsSync(root)) {
      report.errors.push(`Audiobook root does not exist: ${root}`);
      continue;
    }
    const byDir = new Map<
      string,
      { relPath: string; sizeBytes: number; ext: string; abs: string; stat: fs.Stats }[]
    >();
    walk(root, root, 0, (abs, rel, ext, stat) => {
      if (!AUDIO_EXTS.has(ext)) return;
      const dir = path.dirname(rel);
      const list = byDir.get(dir) ?? [];
      list.push({ relPath: rel, sizeBytes: stat.size, ext, abs, stat });
      byDir.set(dir, list);
    });
    for (const [dir, files] of byDir) {
      files.sort((a, b) => naturalCompare(a.relPath, b.relPath));
      if (dir === '.') {
        // Loose files at the root: each is its own book.
        for (const f of files) {
          report.audiobooks.push({
            rootDir: root,
            relPath: f.relPath,
            tracks: [{ relPath: f.relPath, sizeBytes: f.sizeBytes, ext: f.ext }],
            sizeBytes: f.sizeBytes,
            contentHash: quickHash(f.abs, f.stat),
          });
        }
      } else {
        const h = createHash('sha256');
        let size = 0;
        for (const f of files) {
          h.update(quickHash(f.abs, f.stat));
          size += f.sizeBytes;
        }
        report.audiobooks.push({
          rootDir: root,
          relPath: dir,
          tracks: files.map((f) => ({ relPath: f.relPath, sizeBytes: f.sizeBytes, ext: f.ext })),
          sizeBytes: size,
          contentHash: h.digest('hex').slice(0, 32),
        });
      }
    }
  }
  return report;
}

export interface UpsertResult {
  /** Book ids that are new or whose content changed and need indexing. */
  needsIndex: { bookId: string; kind: 'ebook' | 'audio' }[];
  discovered: number;
  missing: number;
}

/** Apply a scan report to the database. */
/**
 * The generation of facet extraction the current code writes.
 *
 * A book indexed under an older generation carries tags this build would have
 * read differently - or, at generation 0, none at all. Bumping this re-indexes
 * every book once, without touching `scan_state`, so the library stays
 * readable and pairable while the backfill works through it.
 */
export const FACETS_REV = 1;

/** Whether this book predates the current facet extraction. */
function facetsStale(existing: { facets_rev?: unknown }): boolean {
  return Number(existing.facets_rev ?? 0) < FACETS_REV;
}

/**
 * A book that vanished from one path and reappeared at another.
 *
 * Book ids are derived from the path, so renaming a file or reorganising a
 * folder used to mint a brand new book and mark the old one missing - and
 * every highlight, note, bookmark, shelf membership and reading position
 * hangs off the old id. Matching on the content hash of a book the scanner
 * has already marked missing reunites them, which is the difference between
 * tidying a library and losing your marks in it.
 */
function relinkMoved(
  db: DB,
  kind: 'ebook' | 'audio',
  contentHash: string,
  rootDir: string,
  relPath: string,
): string | null {
  const hit = db
    .prepare(
      "SELECT id FROM books WHERE kind = ? AND content_hash = ? AND scan_state = 'missing' LIMIT 1",
    )
    .get(kind, contentHash) as { id: string } | undefined;
  if (!hit) return null;
  db.prepare(
    "UPDATE books SET root_dir = ?, rel_path = ?, scan_state = 'discovered' WHERE id = ?",
  ).run(rootDir, relPath, hit.id);
  return hit.id;
}

/**
 * Forget what we worked out about a book whose bytes have changed.
 *
 * A pairing says "these two files are the same work", and an alignment says
 * "this sentence is spoken at this second". Both are statements about the
 * CONTENT. Replace the file - a different edition, a re-encode, a corrected
 * EPUB - and they are not stale, they are wrong: the reader would be handed
 * timings for a book they no longer have, and switching would land them in
 * the wrong chapter with no sign that anything was amiss.
 *
 * Deliberately NOT done when a book merely goes missing. A NAS that fails to
 * mount would otherwise destroy every pairing in the library and hours of
 * computed timings, and `relinkMoved` exists precisely so a file that comes
 * back - even under a new name - is reunited with everything it had. Deleting
 * a book for real already cascades through the foreign keys.
 *
 * The saved .rpalign files are left alone: they are matched by a fingerprint
 * of the text, so the new content simply will not match them, and the old
 * ones stay available for whatever still does.
 */
export function discardPairing(db: DB, bookId: string): number {
  const pairs = db
    .prepare('SELECT id FROM pairs WHERE ebook_id = ? OR audio_id = ?')
    .all(bookId, bookId) as { id: string }[];
  if (pairs.length === 0) return 0;
  // Alignments and their segments cascade from the pair.
  db.prepare('DELETE FROM pairs WHERE ebook_id = ? OR audio_id = ?').run(bookId, bookId);
  return pairs.length;
}

export function applyScan(db: DB, report: ScanReport): UpsertResult {
  const needsIndex: UpsertResult['needsIndex'] = [];
  const seenIds = new Set<string>();
  const now = nowIso();

  const upsert = db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, size_bytes, content_hash, scan_state, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?)
     ON CONFLICT(kind, root_dir, rel_path) DO UPDATE SET size_bytes = excluded.size_bytes`,
  );
  const getExisting = db.prepare(
    'SELECT id, content_hash, scan_state, facets_rev FROM books WHERE kind = ? AND root_dir = ? AND rel_path = ?',
  );

  for (const e of report.ebooks) {
    const id = stableId('ebook', e.rootDir, e.relPath);
    seenIds.add(id);
    const existing = getExisting.get('ebook', e.rootDir, e.relPath) as
      | { id: string; content_hash: string | null; scan_state: string; facets_rev?: number }
      | undefined;
    if (!existing) {
      const moved = relinkMoved(db, 'ebook', e.contentHash, e.rootDir, e.relPath);
      if (moved) {
        seenIds.add(moved);
        needsIndex.push({ bookId: moved, kind: 'ebook' });
        continue;
      }
      upsert.run(
        id,
        'ebook',
        e.rootDir,
        e.relPath,
        'epub',
        path.basename(e.relPath, '.epub'),
        e.sizeBytes,
        e.contentHash,
        now,
      );
      needsIndex.push({ bookId: id, kind: 'ebook' });
    } else {
      const changed =
        existing.content_hash !== e.contentHash ||
        existing.scan_state === 'error' ||
        existing.scan_state === 'missing' ||
        existing.scan_state === 'discovered';
      if (changed || facetsStale(existing)) {
        // A re-index for facets alone must not take the book out of service:
        // only a real change or a broken state sends it back to 'discovered'.
        const nextState = changed
          ? existing.scan_state === 'missing' || existing.scan_state === 'ready'
            ? 'discovered'
            : existing.scan_state
          : existing.scan_state;
        db.prepare(
          'UPDATE books SET content_hash = ?, size_bytes = ?, scan_state = ? WHERE id = ?',
        ).run(e.contentHash, e.sizeBytes, nextState, existing.id);
        // Different bytes: whatever this book was paired with, and whatever
        // was timed against it, described the old file. Start again.
        if (existing.content_hash !== e.contentHash) discardPairing(db, existing.id);
        needsIndex.push({ bookId: existing.id, kind: 'ebook' });
      }
    }
  }

  for (const a of report.audiobooks) {
    const id = stableId('audio', a.rootDir, a.relPath);
    seenIds.add(id);
    const format = a.tracks.length === 1 ? a.tracks[0]!.ext.slice(1) : 'multi';
    const existing = getExisting.get('audio', a.rootDir, a.relPath) as
      | { id: string; content_hash: string | null; scan_state: string; facets_rev?: number }
      | undefined;
    if (!existing) {
      const moved = relinkMoved(db, 'audio', a.contentHash, a.rootDir, a.relPath);
      if (moved) {
        seenIds.add(moved);
        insertTracks(db, moved, a);
        needsIndex.push({ bookId: moved, kind: 'audio' });
        continue;
      }
      upsert.run(
        id,
        'audio',
        a.rootDir,
        a.relPath,
        format,
        path.basename(a.relPath).replace(/\.[^.]+$/, ''),
        a.sizeBytes,
        a.contentHash,
        now,
      );
      insertTracks(db, id, a);
      needsIndex.push({ bookId: id, kind: 'audio' });
    } else if (
      existing.content_hash !== a.contentHash ||
      ['error', 'missing', 'discovered'].includes(existing.scan_state) ||
      facetsStale(existing)
    ) {
      const changed =
        existing.content_hash !== a.contentHash ||
        ['error', 'missing', 'discovered'].includes(existing.scan_state);
      // As with ebooks: a facets-only re-index leaves the book playable.
      db.prepare(
        'UPDATE books SET content_hash = ?, size_bytes = ?, scan_state = ? WHERE id = ?',
      ).run(a.contentHash, a.sizeBytes, changed ? 'discovered' : existing.scan_state, existing.id);
      if (existing.content_hash !== a.contentHash) discardPairing(db, existing.id);
      insertTracks(db, existing.id, a);
      needsIndex.push({ bookId: existing.id, kind: 'audio' });
    }
  }

  // Mark books whose files disappeared.
  const all = db.prepare("SELECT id FROM books WHERE scan_state != 'missing'").all() as {
    id: string;
  }[];
  let missing = 0;
  for (const row of all) {
    if (!seenIds.has(row.id)) {
      db.prepare("UPDATE books SET scan_state = 'missing' WHERE id = ?").run(row.id);
      missing += 1;
    }
  }

  return { needsIndex, discovered: report.ebooks.length + report.audiobooks.length, missing };
}

function insertTracks(db: DB, bookId: string, a: DiscoveredAudioBook): void {
  db.prepare('DELETE FROM audio_tracks WHERE book_id = ?').run(bookId);
  const ins = db.prepare(
    'INSERT INTO audio_tracks (book_id, idx, rel_path, size_bytes, format) VALUES (?, ?, ?, ?, ?)',
  );
  a.tracks.forEach((t, idx) => ins.run(bookId, idx, t.relPath, t.sizeBytes, t.ext.slice(1)));
}
