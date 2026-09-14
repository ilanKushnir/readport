import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { buildApp } from './app.js';
import { openDatabase } from '../db/index.js';
import { loadConfig } from '../config.js';
import { createApiKey } from '../auth/apikeys.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-agent-'));
const config = loadConfig({ dataDir: dir, cacheDir: path.join(dir, 'cache'), logLevel: 'fatal' });
const db = openDatabase(dir);
const now = '2026-09-14T00:00:00.000Z';
for (const id of ['alice', 'bob']) {
  db.prepare(
    "INSERT INTO users (id,username,password_hash,role,created_at) VALUES (?,?, 'unused','admin',?)",
  ).run(id, id, now);
  db.prepare(
    'INSERT INTO shelves (id,user_id,name,sort_key,created_at,updated_at) VALUES (?,?,?, ?,?,?)',
  ).run(id, id, id, 'A', now, now);
}
for (const id of ['b1', 'b2'])
  db.prepare(
    "INSERT INTO books (id,kind,root_dir,rel_path,format,title,scan_error,added_at) VALUES (?,'ebook','/SECRET',?,'epub',?,'/SECRET/error',?)",
  ).run(id, `${id}.epub`, id, now);
const locator = {
  medium: 'ebook',
  spineIdx: 2,
  sentenceId: 's123',
  charOffset: 42,
  sentenceRatio: 0.6,
  pct: 0.3,
};
for (const id of ['alice', 'bob']) {
  db.prepare(
    "INSERT INTO reading_list (user_id,book_id,sort_key,note,added_at) VALUES (?,'b2','A',?,?), (?,'b1','B',?,?)",
  ).run(id, id, now, id, id, now);
  db.prepare(
    "INSERT INTO shelf_items (shelf_id,book_id,sort_key,added_at) VALUES (?,'b1','A',?)",
  ).run(id, now);
  db.prepare(
    "INSERT INTO annotations (id,user_id,book_id,kind,locator_json,note,selected_text,created_at,updated_at) VALUES (?,?,'b1','note',?,?,'SECRET EXCERPT',?,?)",
  ).run(id, id, JSON.stringify(locator), id, now, now);
  db.prepare(
    "INSERT INTO progress_state (user_id,book_id,locator_json,intent,occurred_at,session_uuid,device_id,seq,updated_at) VALUES (?,'b1',?,'read',?,'private-session','private-device',1,?)",
  ).run(id, JSON.stringify(locator), now, now);
  db.prepare(
    "INSERT INTO progress_events (user_id,book_id,event_id,device_id,session_uuid,seq,intent,medium,locator_json,occurred_at,received_at,applied) VALUES (?,'b1',?,'private-device','private-session',1,'read','ebook',?,?,?,1)",
  ).run(id, id, JSON.stringify(locator), now, now);
}
const key = createApiKey(db, { id: 'key', userId: 'alice', name: 'test', now }).key;
const app = buildApp({ db, config, log: { info() {}, warn() {}, error() {} } });
const routes: { method: string; url: string }[] = [];
app.addHook('onRoute', (route) => {
  for (const method of [route.method].flat()) routes.push({ method, url: route.url });
});
// Future public routes must not bypass the boundary.
app.get('/api/future-public', { config: { public: true } }, async () => ({ secret: true }));
const get = (url: string, authorization = `Bearer ${key}`) =>
  app.inject({ url, headers: { authorization } });
beforeAll(() => app.ready());
afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('denies every registered non-agent route, including public endpoints and future routes', async () => {
  // Enumerate source registrations as buildApp registers routes synchronously before a caller can add onRoute.
  const files = [
    path.join(import.meta.dirname, 'app.ts'),
    ...fs
      .readdirSync(path.join(import.meta.dirname, 'routes'))
      .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
      .map((f) => path.join(import.meta.dirname, 'routes', f)),
  ];
  for (const file of files)
    for (const m of fs
      .readFileSync(file, 'utf8')
      .matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g))
      routes.push({ method: m[1]!.toUpperCase(), url: m[2]! });
  expect(routes.length).toBeGreaterThan(85);
  for (const route of routes.filter((r) => !r.url.startsWith('/api/agent/'))) {
    const url = route.url.replace(/:[\w]+/g, 'b1').replace('*', 'file');
    const res = await app.inject({
      method: route.method as 'GET',
      url,
      headers: { authorization: `Bearer ${key}`, 'x-rp-csrf': '1' },
    });
    expect(res.statusCode, `${route.method} ${url}`).toBe(403);
  }
});
it('fails closed for malformed auth even on public routes', async () => {
  for (const auth of ['Bearer wrong', 'Bearer', 'Basic abc'])
    expect((await get('/api/setup/status', auth)).statusCode).toBe(401);
});
it('denies unknown agent routes, encoded legacy paths and every mutation', async () => {
  for (const url of ['/api/agent/v1/future', '/%61pi/settings', '/api/agent/v1/books/b1/export'])
    expect((await get(url)).statusCode).toBe(403);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    expect(
      (
        await app.inject({
          method: method as 'POST',
          url: '/api/agent/v1/books',
          headers: { authorization: `Bearer ${key}` },
        })
      ).statusCode,
    ).toBe(403);
});
it('discovers versioned schemas without secrets and prevents caching', async () => {
  const r = await get('/api/agent/v1');
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.json()).toMatchObject({
    version: '1',
    basePath: '/api/agent/v1',
    authentication: { scheme: 'Bearer' },
    readOnly: true,
  });
  expect(r.json().schemas).toHaveProperty('book');
  expect(r.body).not.toContain(key);
});
it('scopes personal data and retains exact locators while excluding content and infrastructure', async () => {
  for (const resource of [
    'reading-list',
    'shelves',
    'annotations',
    'books/b1/progress',
    'books/b1/history',
    'shelves/alice/books',
  ]) {
    const r = await get(`/api/agent/v1/${resource}`);
    expect(r.statusCode, resource).toBe(200);
    expect(r.body).not.toMatch(
      /bob|SECRET|private-device|private-session|root_dir|rel_path|selectedText/,
    );
  }
  expect((await get('/api/agent/v1/books/b1/progress')).json().progress.locator).toEqual(locator);
  expect((await get('/api/agent/v1/books/b1/history')).json().items[0].locator).toEqual(locator);
  expect((await get('/api/agent/v1/shelves/bob/books')).statusCode).toBe(404);
  expect(
    (await get('/api/agent/v1/reading-list')).json().items.map((r: { bookId: string }) => r.bookId),
  ).toEqual(['b2', 'b1']);
});
it('paginates, searches, validates and redacts book details', async () => {
  const first = (await get('/api/agent/v1/books?limit=1')).json();
  expect(first.items).toHaveLength(1);
  expect(first.nextOffset).toBe(1);
  const last = (await get('/api/agent/v1/books?limit=1&offset=1')).json();
  expect(last.items).toHaveLength(1);
  expect(last.nextOffset).toBeNull();
  expect((await get('/api/agent/v1/books?query=b2')).json().items[0].id).toBe('b2');
  for (const q of ['limit=101', 'offset=-1', 'userId=bob', 'query=' + 'a'.repeat(201)])
    expect((await get('/api/agent/v1/books?' + q)).statusCode).toBe(400);
  const book = await get('/api/agent/v1/books/b1');
  expect(book.statusCode).toBe(200);
  expect(book.body).not.toMatch(/SECRET|root_dir|rel_path|scanError/);
  expect(book.json().book).toHaveProperty('alignment');
});
