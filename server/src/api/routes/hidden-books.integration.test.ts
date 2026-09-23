import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { writeFacets } from '../../library/facets.js';
import { createApiKey } from '../../auth/apikeys.js';

/**
 * Hidden books: on no list, in no count and behind no link for anybody but
 * an admin signed in to ReadPort - and everything a reader attached to one
 * is still there the day it is shown again.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-hidden-books-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: tmp,
    cacheDir: tmp,
    sessionSecret: 'hidden-books-test-secret-0123456789',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const as = (user: string, url: string, method: Method = 'GET', payload?: unknown) =>
  app.inject({
    url,
    method,
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': user, 'x-rp-csrf': '1' },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const anon = (url: string) => app.inject({ url, remoteAddress: '192.168.1.9' });
const idOf = (username: string) =>
  (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string }).id;
const ids = (res: { json: () => { books: { id: string }[] } }) =>
  res
    .json()
    .books.map((b) => b.id)
    .sort();
const now = new Date().toISOString();
let shareToken = '';
let apiKey = '';

beforeAll(async () => {
  await app.ready();
  const add = (id: string, kind: 'ebook' | 'audio', title: string) =>
    db
      .prepare(
        `INSERT INTO books (id,kind,root_dir,rel_path,format,title,scan_state,added_at)
         VALUES (?,?,?,?,?,?,'ready',?)`,
      )
      .run(id, kind, tmp, id, kind === 'ebook' ? 'epub' : 'm4b', title, now);
  add('open-ebook', 'ebook', 'The Open Book');
  add('lone-audio', 'audio', 'A Lone Audiobook');
  add('secret-ebook', 'ebook', 'The Secret Book');
  add('secret-audio', 'audio', 'The Secret Book');
  db.prepare(
    "INSERT INTO pairs (id,ebook_id,audio_id,status,score,created_at) VALUES ('secret-pair','secret-ebook','secret-audio','confirmed',1,?)",
  ).run(now);
  db.prepare(
    "INSERT INTO audio_tracks (book_id,idx,rel_path,format,duration_ms,start_ms_absolute,size_bytes) VALUES ('secret-audio',0,'secret-audio','m4b',1000,0,10)",
  ).run();
  fs.writeFileSync(path.join(tmp, 'secret-audio'), 'ten bytes!');
  // A genre only the secret book carries: the sidebar must not offer it.
  writeFacets(db, 'secret-ebook', [{ kind: 'genre', value: 'Whispers' }]);
  writeFacets(db, 'open-ebook', [{ kind: 'genre', value: 'Daylight' }]);
  writeFacets(db, 'lone-audio', [{ kind: 'genre', value: 'Daylight' }]);

  // First through the proxy is the admin; then a reader and a curator.
  await as('astra', '/api/auth/me');
  await as('dana', '/api/auth/me');
  await as('cyd', '/api/auth/me');
  db.prepare("UPDATE users SET role = 'curator' WHERE username = 'cyd'").run();
  const dana = idOf('dana');
  const astra = idOf('astra');

  // Everything the reader attached to the secret book before it was hidden.
  const shelf = await as('dana', '/api/shelves', 'POST', { name: 'Keep' });
  const shelfId = shelf.json().shelf.id as string;
  await as('dana', `/api/shelves/${shelfId}/books/secret-ebook`, 'PUT', {});
  await as('dana', `/api/shelves/${shelfId}/books/open-ebook`, 'PUT', {});
  await as('dana', '/api/reading-list/secret-ebook', 'PUT', {});
  db.prepare(
    "INSERT INTO friendships (id,requester_id,addressee_id,status,created_at,responded_at) VALUES ('f1',?,?,'accepted',?,?)",
  ).run(astra, dana, now, now);
  db.prepare(
    "INSERT INTO recommendations (id,from_user_id,to_user_id,book_id,created_at) VALUES ('rec1',?,?,'secret-ebook',?)",
  ).run(astra, dana, now);
  db.prepare(
    `INSERT INTO jobs (id,type,payload_json,state,created_at)
     VALUES ('job-secret','index-ebook','{"bookId":"secret-ebook"}','done',?),
            ('job-open','index-ebook','{"bookId":"open-ebook"}','done',?)`,
  ).run(now, now);
  shareToken = (await as('astra', '/api/books/secret-ebook/share', 'POST')).json().token;
  apiKey = createApiKey(db, { id: 'astra-key', userId: astra, name: 'app', now }).key;
});

afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('hiding a book', () => {
  it('is for admins only', async () => {
    expect(
      (await as('dana', '/api/books/open-ebook/hidden', 'POST', { hidden: true })).statusCode,
    ).toBe(403);
    expect(
      (await as('cyd', '/api/books/open-ebook/hidden', 'POST', { hidden: true })).statusCode,
    ).toBe(403);
    expect(
      (await as('astra', '/api/books/open-ebook/hidden', 'POST', { hidden: 'yes' })).statusCode,
    ).toBe(400);
    expect((await as('astra', '/api/books/nope/hidden', 'POST', { hidden: true })).statusCode).toBe(
      404,
    );
  });

  it('hides both editions of a title owned twice, and says who did it', async () => {
    const res = await as('astra', '/api/books/secret-ebook/hidden', 'POST', { hidden: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().ids).toEqual(['secret-ebook', 'secret-audio']);
    expect(res.json().book.hidden).toMatchObject({ by: 'astra' });
    expect(res.json().book.pair?.pairId).toBe('secret-pair');
  });
});

describe('a hidden book, to everyone but an admin', () => {
  it('is not in the library, on any shelf, or in any count', async () => {
    expect(ids(await as('dana', '/api/library'))).toEqual(['lone-audio', 'open-ebook']);
    expect(ids(await as('cyd', '/api/library'))).toEqual(['lone-audio', 'open-ebook']);
    expect(ids(await as('dana', '/api/library?filter=hidden'))).toEqual([]);
    expect(ids(await as('dana', '/api/library?query=secret'))).toEqual([]);

    const shelves = (await as('dana', '/api/shelves')).json();
    expect(shelves.readingList.count).toBe(0);
    expect(shelves.readingList.nextBookId).toBeNull();
    expect(shelves.shelves[0].count).toBe(1);
    expect(shelves.hidden).toBeUndefined();
    const shelfId = shelves.shelves[0].id as string;
    const shelf = (await as('dana', `/api/shelves/${shelfId}/books`)).json();
    expect(shelf.books.map((b: { id: string }) => b.id)).toEqual(['open-ebook']);
    expect(shelf.missingCount).toBe(0);
    expect((await as('dana', '/api/reading-list')).json().items).toEqual([]);

    const genres = (await as('dana', '/api/facets')).json().groups as {
      kind: string;
      values: { value: string }[];
    }[];
    expect(genres.flatMap((g) => g.values.map((v) => v.value))).not.toContain('Whispers');
  });

  it('answers 404 wherever it is named, as a book that never existed would', async () => {
    for (const url of [
      '/api/books/secret-ebook',
      '/api/books/secret-ebook/cover',
      '/api/books/secret-ebook/manifest',
      '/api/books/secret-ebook/chapter/0',
      '/api/books/secret-ebook/annotations',
      '/api/books/secret-ebook/shelves',
      '/api/books/secret-ebook/offline-manifest',
      '/api/books/secret-audio/track/0',
      '/api/progress/secret-ebook',
      '/api/pairs/secret-pair',
      '/api/pairs/secret-pair/chapters',
    ]) {
      expect((await as('dana', url)).statusCode, url).toBe(404);
    }
    expect((await as('dana', '/api/reading-list/secret-audio', 'PUT', {})).statusCode).toBe(404);
    expect(
      (await as('dana', '/api/books/secret-ebook/annotations', 'POST', { kind: 'bookmark' }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await as('cyd', '/api/pairs/link', 'POST', {
          ebookId: 'open-ebook',
          audioId: 'secret-audio',
        })
      ).statusCode,
    ).toBe(404);
    const pairs = (await as('cyd', '/api/pairs')).json().pairs as { id: string }[];
    expect(pairs.map((p) => p.id)).not.toContain('secret-pair');
  });

  it('is gone from friends, recommendations and the job list', async () => {
    expect((await as('dana', '/api/friends/inbox')).json().recommendations).toEqual([]);
    expect((await as('dana', '/api/auth/me')).json().recommendations).toBe(0);
    expect((await as('dana', '/api/friends/progress?bookId=secret-ebook')).json().friends).toEqual(
      [],
    );
    const jobs = (await as('dana', '/api/jobs')).json().jobs as { id: string }[];
    expect(jobs.map((j) => j.id)).toContain('job-open');
    expect(jobs.map((j) => j.id)).not.toContain('job-secret');
    const adminJobs = (await as('astra', '/api/jobs')).json().jobs as { id: string }[];
    expect(adminJobs.map((j) => j.id)).toContain('job-secret');
  });

  it('closes its share links to everybody, signed in or not', async () => {
    expect((await anon(`/api/share/${shareToken}`)).json()).toEqual({ valid: false });
    expect((await anon(`/s/${shareToken}/image.png`)).statusCode).toBe(404);
    // And an admin is not handed a link that would open on nothing.
    expect((await as('astra', '/api/books/secret-ebook/share', 'POST')).statusCode).toBe(409);
    // Nor can it be recommended to a friend.
    expect(
      (
        await as('astra', '/api/friends/recommend', 'POST', {
          toUserId: idOf('dana'),
          bookId: 'secret-audio',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('is not given to an app through an API key, even an admin key', async () => {
    const get = (url: string) =>
      app.inject({ url, headers: { authorization: `Bearer ${apiKey}` } });
    const books = (await get('/api/agent/v1/books')).json().items as { id: string }[];
    expect(books.map((b) => b.id).sort()).toEqual(['lone-audio', 'open-ebook']);
    expect((await get('/api/agent/v1/books/secret-ebook')).statusCode).toBe(404);
    expect((await get('/api/agent/v1/books/secret-ebook/progress')).statusCode).toBe(404);
  });
});

describe('a hidden book, to an admin', () => {
  it('is in the library, marked, and on a shelf of its own', async () => {
    const all = (await as('astra', '/api/library')).json().books as {
      id: string;
      hidden?: { by: string | null } | null;
    }[];
    // One card for the title owned twice, as always.
    expect(all.map((b) => b.id).sort()).toEqual(['lone-audio', 'open-ebook', 'secret-ebook']);
    expect(all.find((b) => b.id === 'secret-ebook')?.hidden?.by).toBe('astra');
    expect(all.find((b) => b.id === 'open-ebook')?.hidden).toBeNull();
    expect(ids(await as('astra', '/api/library?filter=hidden'))).toEqual(['secret-ebook']);
    expect((await as('astra', '/api/shelves')).json().hidden).toBe(1);
    expect((await as('astra', '/api/books/secret-audio/track/0')).statusCode).toBe(200);
    const genres = (await as('astra', '/api/facets')).json().groups as {
      values: { value: string }[];
    }[];
    expect(genres.flatMap((g) => g.values.map((v) => v.value))).toContain('Whispers');
  });
});

describe('showing it again', () => {
  it('brings back everything the reader had attached to it', async () => {
    const res = await as('astra', '/api/books/secret-audio/hidden', 'POST', { hidden: false });
    expect(res.json().ids).toEqual(['secret-audio', 'secret-ebook']);
    expect(res.json().book.hidden).toBeNull();
    expect(ids(await as('dana', '/api/library'))).toEqual([
      'lone-audio',
      'open-ebook',
      'secret-ebook',
    ]);
    const shelves = (await as('dana', '/api/shelves')).json();
    expect(shelves.readingList.nextBookId).toBe('secret-ebook');
    expect(shelves.shelves[0].count).toBe(2);
    expect((await as('dana', '/api/friends/inbox')).json().recommendations).toHaveLength(1);
    expect((await anon(`/api/share/${shareToken}`)).json().valid).toBe(true);
  });

  it('keeps a pair with one hidden edition away from readers, and the other edition alone', async () => {
    // A pair that forms, or is edited, around the admin route: one half hidden.
    db.prepare("UPDATE books SET hidden_at = ? WHERE id = 'secret-audio'").run(now);
    const books = (await as('dana', '/api/library')).json().books as {
      id: string;
      pair: unknown;
    }[];
    expect(books.map((b) => b.id).sort()).toEqual(['lone-audio', 'open-ebook', 'secret-ebook']);
    expect(books.find((b) => b.id === 'secret-ebook')?.pair).toBeNull();
    expect((await as('dana', '/api/pairs/secret-pair/chapters')).statusCode).toBe(404);
    expect((await as('dana', '/api/books/secret-ebook')).json().book.pair).toBeNull();
    // The admin still sees the pair as a pair.
    expect((await as('astra', '/api/books/secret-ebook')).json().book.pair?.pairId).toBe(
      'secret-pair',
    );
  });
});
