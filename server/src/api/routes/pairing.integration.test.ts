import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { stableId } from '../../util/ids.js';

/**
 * Pairing a book from its own page: the other format's books to choose
 * from, the likeliest first, and a pick that replaces whatever either book
 * was paired with before. Every book is invented.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-pairing-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: path.join(tmp, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    sessionSecret: 'pairing-test-secret-0123456789abcdef',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});
const headers = (user: string) => ({ 'x-rp-test-user': user, 'x-rp-csrf': '1' });
const get = (user: string, url: string) =>
  app.inject({ url, remoteAddress: '10.0.0.5', headers: headers(user) });
const post = (user: string, url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload, remoteAddress: '10.0.0.5', headers: headers(user) });
const now = new Date().toISOString();
// Pair ids are derived from the two books, as the app derives them.
const P_LANTERN = stableId('pair', 'lantern-e', 'lantern-a');
const P_FOG = stableId('pair', 'fog-e', 'fog-a');
const statusOf = (id: string) =>
  (db.prepare('SELECT status FROM pairs WHERE id = ?').get(id) as { status: string } | undefined)
    ?.status;

beforeAll(async () => {
  await app.ready();
  const add = db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, author, language, meta_json,
       size_bytes, duration_ms, scan_state, added_at, hidden_at)
     VALUES (?, ?, '/lib', ?, ?, ?, ?, 'en', ?, 1, ?, ?, ?, ?)`,
  );
  const ebook = (id: string, title: string, author: string, state = 'ready', hidden = false) =>
    add.run(
      id,
      'ebook',
      `${id}.epub`,
      'epub',
      title,
      author,
      JSON.stringify({ totalChars: 360_000 }),
      null,
      state,
      now,
      hidden ? now : null,
    );
  const audio = (id: string, title: string, author: string) =>
    add.run(id, 'audio', id, 'mp3', title, author, '{}', 21_800_000, 'ready', now, null);
  ebook('lantern-e', 'The Lantern of Ash Harbor', 'Rivka Sharon');
  ebook('fog-e', 'Fog Signals', 'Rivka Sharon');
  ebook('kites-e', 'Seventeen Kites', 'Ilse Marrowdale');
  ebook('hour-e', 'The Stopped Hour', 'Noa Adler', 'ready', true);
  ebook('gone-e', 'Gone From the Shelf', 'Noa Adler', 'missing');
  audio('lantern-a', 'The Lantern of Ash Harbor', 'Rivka Sharon');
  audio('fog-a', 'Fog Signals', 'Rivka Sharon');
  audio('kites-a', 'Seventeen Kites', 'Ilse Marrowdale');
  const pair = db.prepare(
    'INSERT INTO pairs (id, ebook_id, audio_id, status, score, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  pair.run(P_LANTERN, 'lantern-e', 'lantern-a', 'confirmed', 0.97, now);
  pair.run(P_FOG, 'fog-e', 'fog-a', 'candidate', 0.8, now);
  await get('astra', '/api/auth/me');
  await get('cyd', '/api/auth/me');
  await get('dana', '/api/auth/me');
  db.prepare("UPDATE users SET role = 'curator' WHERE username = 'cyd'").run();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a book's pairing", () => {
  it('is for the people who can pair', async () => {
    expect((await get('dana', '/api/books/kites-a/pairing')).statusCode).toBe(403);
    expect((await get('cyd', '/api/books/kites-a/pairing')).statusCode).toBe(200);
    expect((await get('cyd', '/api/books/nope/pairing')).statusCode).toBe(404);
    // A hidden book is an admin's to pair.
    expect((await get('cyd', '/api/books/hour-e/pairing')).statusCode).toBe(404);
    expect((await get('astra', '/api/books/hour-e/pairing')).statusCode).toBe(200);
  });

  it('offers the other format, the likeliest book first', async () => {
    const res = (await get('cyd', '/api/books/kites-a/pairing')).json();
    const ids = res.options.map((o: { book: { id: string } }) => o.book.id);
    expect(ids[0]).toBe('kites-e');
    expect(res.options[0]).toMatchObject({ likely: true, pairedWith: null, dismissed: false });
    // Only ebooks, none gone from the disk, none hidden from a curator.
    expect(ids.sort()).toEqual(['fog-e', 'kites-e', 'lantern-e']);
    expect(
      res.options.find((o: { book: { id: string } }) => o.book.id === 'lantern-e'),
    ).toMatchObject({
      likely: false,
      pairedWith: { id: 'lantern-a', title: 'The Lantern of Ash Harbor' },
    });
    const admin = (await get('astra', '/api/books/kites-a/pairing')).json();
    expect(admin.options.map((o: { book: { id: string } }) => o.book.id)).toContain('hour-e');
  });

  it('shows what it is paired with, and what was suggested', async () => {
    const lantern = (await get('cyd', '/api/books/lantern-e/pairing')).json();
    expect(lantern.linked).toEqual([
      expect.objectContaining({
        pairId: P_LANTERN,
        status: 'confirmed',
        switchable: false,
        book: expect.objectContaining({ id: 'lantern-a' }),
      }),
    ]);
    expect(lantern.options.map((o: { book: { id: string } }) => o.book.id)).not.toContain(
      'lantern-a',
    );
    const fog = (await get('cyd', '/api/books/fog-e/pairing')).json();
    expect(fog.suggested).toEqual([
      expect.objectContaining({ pairId: P_FOG, book: expect.objectContaining({ id: 'fog-a' }) }),
    ]);
    expect(fog.linked).toEqual([]);
  });

  it('counts the suggestions waiting on a curator', async () => {
    expect((await get('cyd', '/api/shelves')).json().pairsToReview).toBe(1);
    expect((await get('dana', '/api/shelves')).json().pairsToReview).toBeUndefined();
  });
});

describe('pairing from a book', () => {
  it('is a curator’s to do', async () => {
    const res = await post('dana', '/api/pairs/link', {
      ebookId: 'kites-e',
      audioId: 'kites-a',
      replace: true,
    });
    expect(res.statusCode).toBe(403);
  });

  it('replaces what either book was paired with, and settles their suggestions', async () => {
    // The Lantern ebook to the Fog narration: its own audiobook is let go,
    // and so is the suggestion that had the Fog narration with the Fog ebook.
    const res = await post('cyd', '/api/pairs/link', {
      ebookId: 'lantern-e',
      audioId: 'fog-a',
      replace: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pair).toMatchObject({ status: 'confirmed' });
    expect(res.json().released.sort()).toEqual([P_FOG, P_LANTERN].sort());
    expect(statusOf(P_LANTERN)).toBe('rejected');
    expect(statusOf(P_FOG)).toBe('rejected');

    const lantern = (await get('cyd', '/api/books/lantern-e/pairing')).json();
    expect(lantern.linked.map((l: { book: { id: string } }) => l.book.id)).toEqual(['fog-a']);
    expect(
      lantern.options.find((o: { book: { id: string } }) => o.book.id === 'lantern-a'),
    ).toMatchObject({ dismissed: true, pairedWith: null });
    expect((await get('cyd', '/api/shelves')).json().pairsToReview).toBe(0);
  });

  it('puts a pair right again, and alignment is queued for it', async () => {
    const res = await post('cyd', '/api/pairs/link', {
      ebookId: 'lantern-e',
      audioId: 'lantern-a',
      replace: true,
    });
    expect(res.statusCode).toBe(200);
    expect(statusOf(P_LANTERN)).toBe('confirmed');
    const aligns = db
      .prepare("SELECT COUNT(*) AS c FROM jobs WHERE type = 'align' AND payload_json LIKE ?")
      .get(`%${P_LANTERN}%`) as { c: number };
    expect(aligns.c).toBe(1);
  });

  it('adds rather than replaces when the Pairing page links', async () => {
    const res = await post('cyd', '/api/pairs/link', { ebookId: 'kites-e', audioId: 'lantern-a' });
    expect(res.statusCode).toBe(200);
    expect(res.json().released).toEqual([]);
    expect(statusOf(P_LANTERN)).toBe('confirmed');
  });
});
