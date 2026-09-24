import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';

/**
 * A book's metadata, through the API: an admin's to see - it names the
 * server's own disk - and a true account of the file behind the book, of
 * what the file says about itself, and of what ReadPort made of it. Every
 * book is invented.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-metadata-'));
const lib = path.join(tmp, 'library');
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: path.join(tmp, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    sessionSecret: 'metadata-test-secret-0123456789abcdef',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});
const as = (user: string, url: string) =>
  app.inject({
    url,
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': user, 'x-rp-csrf': '1' },
  });
const now = new Date().toISOString();

beforeAll(async () => {
  await app.ready();
  fs.mkdirSync(path.join(lib, 'Rivka Sharon', 'Fog Signals (7)'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'Rivka Sharon', 'Fog Signals (7)', 'Fog Signals.epub'), 'epub');
  fs.mkdirSync(path.join(lib, 'Rivka Sharon', 'Fog Signals'), { recursive: true });
  for (const f of ['01 - Harbor.mp3', '02 - Tide.mp3'])
    fs.writeFileSync(path.join(lib, 'Rivka Sharon', 'Fog Signals', f), 'mp3');
  const add = db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, author, series, series_idx,
       language, language_metadata, language_source, identifiers_json, meta_json, size_bytes,
       duration_ms, content_hash, scan_state, scanned_at, added_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?)`,
  );
  add.run(
    'fog-e',
    'ebook',
    lib,
    'Rivka Sharon/Fog Signals (7)/Fog Signals.epub',
    'epub',
    'Fog Signals',
    'Rivka Sharon',
    'Ash Harbor',
    2,
    'en',
    'en',
    'metadata',
    JSON.stringify({ isbn: '9780000000019', calibre: '7' }),
    JSON.stringify({
      publisher: 'Tidewater Press',
      description: '<p>Weather.</p>',
      totalChars: 5120,
    }),
    4,
    null,
    'abc123',
    now,
    now,
  );
  add.run(
    'fog-a',
    'audio',
    lib,
    'Rivka Sharon/Fog Signals',
    'multi',
    'Fog Signals',
    'Rivka Sharon',
    null,
    null,
    'en',
    null,
    'pair',
    '{}',
    '{}',
    6,
    7_200_000,
    null,
    now,
    now,
  );
  add.run(
    'gone',
    'ebook',
    lib,
    'Nobody/Gone.epub',
    'epub',
    'Gone',
    null,
    null,
    null,
    null,
    null,
    null,
    '{}',
    '{}',
    0,
    null,
    null,
    now,
    now,
  );
  const track = db.prepare(
    `INSERT INTO audio_tracks (book_id, idx, rel_path, duration_ms, size_bytes, format, title)
     VALUES ('fog-a', ?, ?, ?, 3, 'mp3', ?)`,
  );
  track.run(0, 'Rivka Sharon/Fog Signals/01 - Harbor.mp3', 3_600_000, 'Harbor');
  track.run(1, 'Rivka Sharon/Fog Signals/02 - Tide.mp3', 3_600_000, null);
  db.prepare(
    "INSERT INTO book_facets (book_id, kind, value, fold) VALUES ('fog-e', 'genre', 'Sea stories', 'sea stories')",
  ).run();
  db.prepare(
    "INSERT INTO pairs (id, ebook_id, audio_id, status, score, created_at) VALUES ('p', 'fog-e', 'fog-a', 'confirmed', 1, ?)",
  ).run(now);
  await as('astra', '/api/auth/me');
  await as('cyd', '/api/auth/me');
  db.prepare("UPDATE users SET role = 'curator' WHERE username = 'cyd'").run();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a book's metadata", () => {
  it('is an admin’s alone', async () => {
    expect((await as('cyd', '/api/books/fog-e/metadata')).statusCode).toBe(403);
    expect((await as('astra', '/api/books/nope/metadata')).statusCode).toBe(404);
  });

  it('names the file and where it is', async () => {
    const m = (await as('astra', '/api/books/fog-e/metadata')).json();
    expect(m.file).toMatchObject({
      name: 'Fog Signals.epub',
      folder: 'Rivka Sharon/Fog Signals (7)',
      library: lib,
      path: path.join(lib, 'Rivka Sharon', 'Fog Signals (7)', 'Fog Signals.epub'),
      isFolder: false,
      present: true,
      sizeBytes: 4,
    });
    expect(Date.parse(m.file.modifiedAt)).not.toBeNaN();
  });

  it('says what the file says about itself, and what ReadPort made of it', async () => {
    const m = (await as('astra', '/api/books/fog-e/metadata')).json();
    expect(m.embedded).toMatchObject({
      series: 'Ash Harbor',
      seriesIdx: 2,
      publisher: 'Tidewater Press',
      identifiers: { isbn: '9780000000019', calibre: '7' },
      tags: [{ kind: 'genre', value: 'Sea stories' }],
      description: true,
    });
    expect(m.readport).toMatchObject({
      id: 'fog-e',
      characters: 5120,
      language: { value: 'en', source: 'metadata' },
      pair: { title: 'Fog Signals', kind: 'audio', status: 'confirmed' },
      cover: 'none',
    });
  });

  it('lists an audiobook’s files by their names in its folder', async () => {
    const m = (await as('astra', '/api/books/fog-a/metadata')).json();
    expect(m.file).toMatchObject({ name: 'Fog Signals', isFolder: true, present: true });
    expect(m.tracks.map((t: { name: string }) => t.name)).toEqual([
      '01 - Harbor.mp3',
      '02 - Tide.mp3',
    ]);
  });

  it('says so when the file is no longer on disk', async () => {
    const m = (await as('astra', '/api/books/gone/metadata')).json();
    expect(m.file).toMatchObject({ present: false, modifiedAt: null, name: 'Gone.epub' });
  });
});
