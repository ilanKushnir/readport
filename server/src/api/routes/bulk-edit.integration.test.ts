import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';

/**
 * The library's Edit mode: one change for many books - their language, who
 * sees them, which shelf they are on, whether they are queued. Every book
 * is invented.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-bulk-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: path.join(tmp, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    sessionSecret: 'bulk-edit-test-secret-0123456789abcdef',
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
const book = (id: string) =>
  db.prepare('SELECT language, language_manual, hidden_at FROM books WHERE id = ?').get(id) as {
    language: string | null;
    language_manual: string | null;
    hidden_at: string | null;
  };

beforeAll(async () => {
  await app.ready();
  const add = db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, author, size_bytes,
       scan_state, added_at, hidden_at)
     VALUES (?, ?, '/lib', ?, ?, ?, 'Rivka Sharon', 1, 'ready', ?, ?)`,
  );
  add.run('lantern-e', 'ebook', 'lantern.epub', 'epub', 'The Lantern of Ash Harbor', now, null);
  add.run('lantern-a', 'audio', 'lantern', 'mp3', 'The Lantern of Ash Harbor', now, null);
  add.run('fog-e', 'ebook', 'fog.epub', 'epub', 'Fog Signals', now, null);
  add.run('glass-e', 'ebook', 'glass.epub', 'epub', 'The Glass Room', now, null);
  add.run('hour-e', 'ebook', 'hour.epub', 'epub', 'The Stopped Hour', now, now);
  db.prepare(
    "INSERT INTO pairs (id, ebook_id, audio_id, status, score, created_at) VALUES ('p', 'lantern-e', 'lantern-a', 'confirmed', 1, ?)",
  ).run(now);
  await get('astra', '/api/auth/me');
  await get('cyd', '/api/auth/me');
  await get('dana', '/api/auth/me');
  db.prepare("UPDATE users SET role = 'curator' WHERE username = 'cyd'").run();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the language of many books', () => {
  it('is a curator’s to set', async () => {
    const body = { bookIds: ['fog-e'], language: 'he' };
    expect((await post('dana', '/api/books/language', body)).statusCode).toBe(403);
    expect(
      (await post('cyd', '/api/books/language', { bookIds: ['fog-e'], language: 'xx' })).statusCode,
    ).toBe(400);
    expect(
      (await post('cyd', '/api/books/language', { bookIds: [], language: 'he' })).statusCode,
    ).toBe(400);
  });

  it('is set on every book chosen, and a title’s other edition with it', async () => {
    const res = await post('cyd', '/api/books/language', {
      bookIds: ['lantern-e', 'fog-e', 'hour-e', 'nope'],
      language: 'he',
    });
    expect(res.statusCode).toBe(200);
    // The hidden book is not a curator's to see, and an unknown one is no book.
    expect(res.json().ids.sort()).toEqual(['fog-e', 'lantern-a', 'lantern-e']);
    for (const id of ['lantern-e', 'lantern-a', 'fog-e']) {
      expect(book(id)).toMatchObject({ language: 'he', language_manual: 'he' });
    }
    expect(book('hour-e').language_manual).toBeNull();
    expect(book('glass-e').language_manual).toBeNull();
  });

  it('goes back to what the books say for themselves', async () => {
    const res = await post('cyd', '/api/books/language', {
      bookIds: ['lantern-e', 'fog-e'],
      language: null,
    });
    expect(res.statusCode).toBe(200);
    for (const id of ['lantern-e', 'lantern-a', 'fog-e']) {
      expect(book(id).language_manual).toBeNull();
    }
  });
});

describe('hiding many books', () => {
  it('is an admin’s to do', async () => {
    const res = await post('cyd', '/api/books/hidden', { bookIds: ['fog-e'], hidden: true });
    expect(res.statusCode).toBe(403);
  });

  it('hides each with its other edition, and shows them again', async () => {
    const hid = await post('astra', '/api/books/hidden', {
      bookIds: ['lantern-e', 'fog-e'],
      hidden: true,
    });
    expect(hid.json().ids.sort()).toEqual(['fog-e', 'lantern-a', 'lantern-e']);
    expect(book('lantern-a').hidden_at).not.toBeNull();
    expect(book('glass-e').hidden_at).toBeNull();
    await post('astra', '/api/books/hidden', { bookIds: ['lantern-e', 'fog-e'], hidden: false });
    expect(book('lantern-a').hidden_at).toBeNull();
    expect(book('fog-e').hidden_at).toBeNull();
  });
});

describe('many books on and off a shelf, and onto the reading list', () => {
  it('takes the chosen books off a shelf, and only its owner may', async () => {
    const shelf = (await post('dana', '/api/shelves', { name: 'Harbour stories' })).json().shelf;
    await post('dana', `/api/shelves/${shelf.id}/books`, {
      bookIds: ['lantern-e', 'fog-e', 'glass-e'],
    });
    expect(
      (await post('cyd', `/api/shelves/${shelf.id}/remove`, { bookIds: ['fog-e'] })).statusCode,
    ).toBe(404);
    const res = await post('dana', `/api/shelves/${shelf.id}/remove`, {
      bookIds: ['fog-e', 'glass-e', 'hour-e'],
    });
    expect(res.json()).toEqual({ removed: 2, count: 1 });
  });

  it('queues the chosen books at the end, in order, and leaves a queued one where it is', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/reading-list/glass-e',
      payload: {},
      remoteAddress: '10.0.0.5',
      headers: headers('dana'),
    });
    const res = await post('dana', '/api/reading-list/add', {
      bookIds: ['fog-e', 'glass-e', 'lantern-e', 'hour-e'],
    });
    expect(res.json()).toEqual({ added: 2, skipped: 2, count: 3 });
    const list = (await get('dana', '/api/reading-list')).json().items as {
      book: { id: string };
    }[];
    expect(list.map((i) => i.book.id)).toEqual(['glass-e', 'fog-e', 'lantern-e']);
  });
});
