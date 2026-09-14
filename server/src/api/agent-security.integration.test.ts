import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { apiKeyAllows } from './guards.js';
import { createApiKey } from '../auth/apikeys.js';
import { openDatabase, type DB } from '../db/index.js';
import { loadConfig } from '../config.js';

let dir: string;
let db: DB;
let app: ReturnType<typeof buildApp>;
let key: string;
let logs: string[];
const now = '2026-09-14T00:00:00.000Z';
const locator = { medium: 'audio', trackIdx: 1, positionMs: 1250, bookMs: 3250, pct: 0.4 };
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-agent-security-'));
  db = openDatabase(dir);
  db.prepare(
    "INSERT INTO users (id,username,password_hash,role,created_at) VALUES ('u','reader','unused','reader',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO books (id,kind,root_dir,rel_path,format,title,added_at) VALUES ('b','audio','/SECRET','SECRET.mp3','mp3','Book',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO progress_state (user_id,book_id,locator_json,intent,occurred_at,session_uuid,device_id,seq,updated_at) VALUES ('u','b',?,'pause',?,'SECRET','SECRET',1,?)",
  ).run(JSON.stringify({ ...locator, file: '/SECRET', selectedText: 'SECRET' }), now, now);
  db.prepare(
    "INSERT INTO annotations (id,user_id,book_id,kind,locator_json,selected_text,note,created_at,updated_at) VALUES ('a','u','b','note',?,'SECRET',?,?,?)",
  ).run(JSON.stringify(locator), 'n'.repeat(12000), now, now);
  key = createApiKey(db, { id: 'k', userId: 'u', name: 'test', now }).key;
  logs = [];
  app = buildApp({
    db,
    config: loadConfig({ dataDir: dir, cacheDir: path.join(dir, 'cache'), logLevel: 'fatal' }),
    log: { info: (m) => logs.push(m), warn() {}, error() {} },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const get = (url: string, authorization = `Bearer ${key}`) =>
  app.inject({ url, headers: { authorization } });

it('audits bounded HTTP methods and outcomes without request data', async () => {
  const cases = [
    { method: 'GET' as const, url: '/api/agent/v1/me', status: 200, outcome: 'success' },
    {
      method: 'POST' as const,
      url: '/api/agent/v1/me?SECRET=locator',
      status: 403,
      outcome: 'forbidden',
    },
    {
      method: 'GET' as const,
      url: '/api/agent/v1/books?SECRET=locator',
      status: 400,
      outcome: 'bad-request',
    },
    {
      method: 'GET' as const,
      url: '/api/agent/v1/books/absent',
      status: 404,
      outcome: 'not-found',
    },
  ];
  for (const c of cases) {
    const res = await app.inject({
      method: c.method,
      url: c.url,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(c.status);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      method: c.method,
      outcome: c.outcome,
      status: c.status,
    });
  }
  await get('/api/agent/v1/me', 'Bearer invalid-SECRET');
  expect(JSON.parse(logs.at(-1)!)).toMatchObject({
    method: 'GET',
    outcome: 'unauthorized',
    status: 401,
  });
  db.prepare("UPDATE login_throttle SET count = 10000 WHERE key = 'agent:user:u'").run();
  await get('/api/agent/v1/me');
  expect(JSON.parse(logs.at(-1)!)).toMatchObject({
    method: 'GET',
    outcome: 'rate-limited',
    status: 429,
  });
  for (const line of logs) {
    expect(line).not.toContain('SECRET');
    expect(line).not.toContain(key);
    expect(line).not.toContain('locator');
    expect(Object.keys(JSON.parse(line)).sort()).toEqual([
      'event',
      'keyId',
      'method',
      'outcome',
      'route',
      'status',
      'userId',
    ]);
  }
});

it('requires the read scope as well as an exact allowlisted GET', () => {
  expect(apiKeyAllows('GET', '/api/agent/v1/books', [])).toBe(false);
  expect(apiKeyAllows('GET', '/api/agent/v1/books', ['admin'])).toBe(false);
  expect(apiKeyAllows('GET', '/api/agent/v1/books', ['agent:read'])).toBe(true);
  expect(apiKeyAllows('HEAD', '/api/agent/v1/books', ['agent:read'])).toBe(false);
});

it('denies static paths, aliases, duplicate auth and body-bearing reads', async () => {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const port = new URL(address).port;
  // light-my-request uses new URL() and normalizes dot segments before
  // dispatch. Raw HTTP preserves the exact request-target under test.
  const rawStatus = (target: string, headers: string[] = ['Authorization', `Bearer ${key}`]) =>
    new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: target,
          headers: ['Host', `127.0.0.1:${port}`, ...headers],
          agent: false,
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode!));
        },
      );
      request.on('error', reject);
      request.end();
    });
  for (const url of [
    '/',
    '/index.html',
    '/api/agent/v1/books/',
    '/api/agent/v1/books%2fb',
    '/api/agent/v1/books/%62',
    '/api/agent/v1/books/../me',
    '/api/agent/v1/books/b%252fexport',
    '/api/agent/v1/books/b/export',
  ]) {
    expect(await rawStatus(url), url).toBe(403);
  }
  expect(await rawStatus('/api/agent/v1/me')).toBe(200);
  expect(
    await rawStatus('/api/agent/v1/me', [
      'Authorization',
      `Bearer ${key}`,
      'Authorization',
      `Bearer ${key}`,
    ]),
  ).toBe(401);
  for (const authorization of ['', 'Basic abc', `Bearer ${key}, Bearer ${key}`]) {
    expect((await get('/', authorization)).statusCode).toBe(401);
  }
  expect(
    (
      await app.inject({
        method: 'HEAD',
        url: '/api/agent/v1/books',
        headers: { authorization: `Bearer ${key}` },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/agent/v1/books',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        payload: '{}',
      })
    ).statusCode,
  ).toBe(400);
  expect((await app.inject({ url: '/api/agent/v1' })).statusCode).toBe(401);
});

it('validates every query and bounds annotations without exposing selected text', async () => {
  for (const route of ['shelves', 'reading-list', 'annotations', 'books/b/history']) {
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=1&limit=2',
      'offset=100001',
      'userId=other',
    ]) {
      expect((await get(`/api/agent/v1/${route}?${query}`)).statusCode, `${route}?${query}`).toBe(
        400,
      );
    }
  }
  for (const route of ['', '/me', '/books/b', '/books/b/progress']) {
    expect((await get(`/api/agent/v1${route}?userId=other`)).statusCode).toBe(400);
  }
  const res = await get('/api/agent/v1/annotations');
  expect(res.statusCode).toBe(200);
  expect(res.json().items[0].note.length).toBeLessThanOrEqual(2000);
  expect(res.body).not.toContain('SECRET');
  expect(res.json().items[0].noteTruncated).toBe(true);
  // SQLite substr counts code points, but JSON/Zod strings count UTF-16 units.
  db.prepare("UPDATE annotations SET note = ? WHERE id = 'a'").run('😀'.repeat(2001));
  const unicodeNote = await get('/api/agent/v1/annotations');
  expect(unicodeNote.statusCode).toBe(200);
  expect(unicodeNote.json().items[0].note.length).toBeLessThanOrEqual(2000);
  expect(unicodeNote.json().items[0].noteTruncated).toBe(true);
  db.prepare("UPDATE books SET title = ? WHERE id = 'b'").run('😀'.repeat(501));
  const unicodeBook = await get('/api/agent/v1/books/b');
  expect(unicodeBook.statusCode).toBe(200);
  expect(unicodeBook.json().book.title.length).toBeLessThanOrEqual(500);
  db.prepare("UPDATE annotations SET deleted_at = ? WHERE id = 'a'").run(now);
  expect((await get('/api/agent/v1/annotations')).json().items).toEqual([]);
});

it('keeps canonical audio positions and does not mutate reader data on repeated reads', async () => {
  const before = db.prepare('SELECT * FROM progress_state').all();
  for (let i = 0; i < 2; i++) {
    const res = await get('/api/agent/v1/books/b/progress');
    expect(res.statusCode).toBe(200);
    expect(res.json().progress.locator).toEqual(locator);
    expect(res.body).not.toContain('SECRET');
    expect(res.headers['cache-control']).toBe('no-store');
  }
  expect(db.prepare('SELECT * FROM progress_state').all()).toEqual(before);
  expect(db.prepare('SELECT * FROM progress_events').all()).toEqual([]);
  db.prepare('UPDATE progress_state SET locator_json = ?').run(
    JSON.stringify({ ...locator, positionMs: -1 }),
  );
  expect((await get('/api/agent/v1/books/b/progress')).json().progress.locator).toBeNull();
  expect((await get('/api/agent/v1/books/absent/progress')).statusCode).toBe(404);
});

it('shares an atomic dedicated rate budget across keys and app instances and audits without secrets', async () => {
  const secondKey = createApiKey(db, { id: 'k2', userId: 'u', name: 'second', now }).key;
  const second = buildApp({
    db,
    config: loadConfig({ dataDir: dir, cacheDir: path.join(dir, 'cache'), logLevel: 'fatal' }),
    log: { info() {}, warn() {}, error() {} },
  });
  try {
    for (let i = 0; i < 120; i++) expect((await get('/api/agent/v1/me')).statusCode).toBe(200);
    const res = await second.inject({
      url: '/api/agent/v1/me',
      headers: { authorization: `Bearer ${secondKey}` },
    });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['cache-control']).toBe('no-store');
    // The agent bucket never locks a browser out of the public health route.
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    expect((await get('/api/settings')).statusCode).toBe(403);
    const audit = logs.filter((line) => line.includes('agent-api'));
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.join('\n')).toContain('403');
    expect(audit.join('\n')).not.toContain(key);
    expect(audit.join('\n')).not.toContain('SECRET');
  } finally {
    await second.close();
  }
});
