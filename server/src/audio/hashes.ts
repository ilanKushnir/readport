import { type DB } from '../db/index.js';
import { hashFileChunks, OFFLINE_AUDIO_CHUNK_BYTES } from './integrity.js';

/**
 * The per-chunk hashes an offline download checks each piece of audio
 * against: worked out once per version of a file, and kept.
 *
 * They used to be computed inside the request for a book's offline
 * manifest - the whole audiobook read and hashed again before the first
 * byte of the answer. For a gigabyte on a network share that is long
 * enough for a phone to give up on the request, or for the tunnel in front
 * of the server to time it out, and a retry paid for all of it again.
 *
 * Now the work is the book's, not the request's. The first request starts
 * it and is told how far along it is; it carries on if that request goes
 * away; a second request for the same book joins it rather than starting
 * another; and the answer is kept by the file's source version, so every
 * later download of the same file - the retry included - is instant.
 */

export interface TrackToHash {
  abs: string;
  relPath: string;
  sourceVersion: string;
  size: number;
}

interface Work {
  done: number;
  total: number;
  promise: Promise<void>;
}

/** Books being hashed right now, by book id. */
const working = new Map<string, Work>();

function keptHashes(db: DB, sourceVersion: string, chunkSize: number): string[] | null {
  const row = db
    .prepare('SELECT hashes_json FROM track_hashes WHERE source_version = ? AND chunk_size = ?')
    .get(sourceVersion, chunkSize) as { hashes_json: string } | undefined;
  if (!row) return null;
  try {
    const hashes = JSON.parse(row.hashes_json) as unknown;
    return Array.isArray(hashes) && hashes.every((h) => typeof h === 'string')
      ? (hashes as string[])
      : null;
  } catch {
    return null;
  }
}

function keep(db: DB, track: TrackToHash, chunkSize: number, hashes: string[]): void {
  // A file's older versions are not coming back; their hashes go with them.
  db.prepare('DELETE FROM track_hashes WHERE rel_path = ? AND source_version != ?').run(
    track.relPath,
    track.sourceVersion,
  );
  db.prepare(
    `INSERT OR REPLACE INTO track_hashes (source_version, chunk_size, rel_path, hashes_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    track.sourceVersion,
    chunkSize,
    track.relPath,
    JSON.stringify(hashes),
    new Date().toISOString(),
  );
}

/**
 * Every track's hashes, when all of them are known; otherwise how far the
 * work to know them has got, starting it if nothing is under way.
 */
export function bookTrackHashes(
  db: DB,
  bookId: string,
  tracks: TrackToHash[],
  chunkSize: number = OFFLINE_AUDIO_CHUNK_BYTES,
  log?: { warn: (msg: string) => void },
): { ready: true; hashes: string[][] } | { ready: false; done: number; total: number } {
  const known = tracks.map((t) => keptHashes(db, t.sourceVersion, chunkSize));
  if (known.every((h) => h !== null)) return { ready: true, hashes: known as string[][] };

  let work = working.get(bookId);
  if (!work) {
    const missing = tracks.filter((_, i) => known[i] === null);
    // Progress over the whole book, so the bar does not start again at
    // every track; the tracks already known count as done.
    const total = tracks.reduce((a, t) => a + t.size, 0);
    const started: Work = {
      done: total - missing.reduce((a, t) => a + t.size, 0),
      total,
      promise: Promise.resolve(),
    };
    started.promise = (async () => {
      try {
        // One track at a time: two readers on one spinning disk are slower
        // than one after the other.
        for (const track of missing) {
          const hashes = await hashFileChunks(track.abs, chunkSize, (n) => {
            started.done += n;
          });
          keep(db, track, chunkSize, hashes);
        }
      } catch (err) {
        log?.warn(`Could not prepare ${bookId} for offline: ${(err as Error).message}`);
      } finally {
        working.delete(bookId);
      }
    })();
    working.set(bookId, started);
    work = started;
  }
  return { ready: false, done: Math.min(work.done, work.total), total: work.total };
}

/** Wait for a book's hashing to finish, for tests. */
export async function settleHashing(bookId: string): Promise<void> {
  await working.get(bookId)?.promise;
}
