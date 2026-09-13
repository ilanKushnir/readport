import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDatabase, type DB } from '../db/index.js';
import { loadConfig } from '../config.js';
import { hashPassword } from '../auth/passwords.js';
import { newId } from '../util/ids.js';
import { nowIso } from '../db/index.js';
import { KEY_RE } from '../auth/apikeys.js';

/**
 * What an API key can and cannot do.
 *
 * The point of a key is that a person can let an agent see what they are
 * reading WITHOUT handing over an account that can change it. That promise is
 * only as good as its enforcement, so this exercises the boundary directly
 * rather than trusting the one line that draws it: every verb that is not a
 * GET, the two GETs that are still refused, and a revoked key.
 */

let dir: string;
let db: DB;
let app: ReturnType<typeof buildApp>;
let cookie = '';
let bookId = '';

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-keys-'));
  const config = loadConfig({
    dataDir: path.join(dir, 'data'),
    cacheDir: path.join(dir, 'cache'),
    sessionSecret: 'apikey-test-secret-0123456789abc',
    logLevel: 'error',
  });
  db = openDatabase(config.dataDir);

  // One admin, signed in with a real session.
  const id = newId('user');
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, can_export, display_name, status, created_at)
     VALUES (?, 'admin', ?, 'admin', 1, NULL, 'active', ?)`,
  ).run(id, await hashPassword('admin-password-123'), nowIso());

  // One book, so there is something to read - and a real file behind it, so
  // the export route has something to hand over.
  fs.writeFileSync(path.join(dir, 'a.epub'), 'not really an epub, but bytes');
  db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, size_bytes, scan_state, added_at)
     VALUES ('bk1', 'ebook', ?, 'a.epub', 'epub', 'A Book', 10, 'ready', ?)`,
  ).run(dir, nowIso());
  bookId = 'bk1';

  app = buildApp({
    db,
    config,
    log: { info: () => {}, warn: () => {}, error: (m) => console.error(m) },
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-rp-csrf': '1', 'content-type': 'application/json' },
    payload: { username: 'admin', password: 'admin-password-123' },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const withSession = (opts: { method?: string; url: string; payload?: unknown }) =>
  app.inject({
    method: (opts.method ?? 'GET') as 'GET',
    url: opts.url,
    payload: opts.payload as never,
    headers: {
      cookie,
      'x-rp-csrf': '1',
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
  });

async function mintKey(name = 'agent'): Promise<string> {
  const res = await withSession({ method: 'POST', url: '/api/keys', payload: { name } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { key: string }).key;
}

const withKey = (key: string, opts: { method?: string; url: string; payload?: unknown }) =>
  app.inject({
    method: (opts.method ?? 'GET') as 'GET',
    url: opts.url,
    payload: opts.payload as never,
    headers: {
      authorization: `Bearer ${key}`,
      'x-rp-csrf': '1',
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
  });

describe('minting a key', () => {
  it('returns the secret exactly once, in the documented shape', async () => {
    const key = await mintKey('claude code');
    expect(key).toMatch(KEY_RE);
    // Listing them again never includes the secret.
    const list = (await withSession({ url: '/api/keys' })).json() as {
      keys: { name: string; prefix: string }[];
    };
    expect(list.keys.some((k) => k.name === 'claude code')).toBe(true);
    expect(JSON.stringify(list)).not.toContain(key.split('_')[2]);
  });

  it('stores a hash, not the key', () => {
    const rows = db.prepare('SELECT key_hash FROM api_keys').all() as { key_hash: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.key_hash).not.toMatch(/^rp_/);
  });
});

describe('a key can read', () => {
  it('sees the library, a book and the reading list', async () => {
    const key = await mintKey();
    for (const url of [
      '/api/library',
      `/api/books/${bookId}`,
      '/api/reading-list',
      '/api/shelves',
    ]) {
      const res = await withKey(key, { url });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('sees who it is acting as', async () => {
    const key = await mintKey();
    const me = (await withKey(key, { url: '/api/auth/me' })).json() as {
      user: { username: string };
    };
    expect(me.user.username).toBe('admin');
  });
});

describe('a key cannot write', () => {
  it('is refused every verb that is not a GET', async () => {
    const key = await mintKey();
    const attempts: { method: string; url: string; payload?: unknown }[] = [
      { method: 'POST', url: '/api/progress', payload: { events: [] } },
      { method: 'PUT', url: '/api/settings', payload: { autoAlign: false } },
      { method: 'POST', url: '/api/shelves', payload: { name: 'x' } },
      { method: 'DELETE', url: `/api/reading-list/${bookId}` },
      { method: 'PATCH', url: '/api/prefs', payload: {} },
    ];
    for (const a of attempts) {
      const res = await withKey(key, a);
      expect(res.statusCode, `${a.method} ${a.url}`).toBe(403);
      expect(res.json()).toMatchObject({ error: 'read-only' });
    }
  });

  it('cannot take the book file, even though that is a GET', async () => {
    // Seeing a reading list is not a licence to pull the library down.
    const key = await mintKey();
    expect((await withKey(key, { url: `/api/books/${bookId}/export` })).statusCode).toBe(403);
    // The same account CAN, with a real session.
    expect((await withSession({ url: `/api/books/${bookId}/export` })).statusCode).toBe(200);
  });

  it('cannot manage keys', async () => {
    const key = await mintKey();
    expect((await withKey(key, { url: '/api/keys' })).statusCode).toBe(403);
    expect(
      (await withKey(key, { method: 'POST', url: '/api/keys', payload: { name: 'x' } })).statusCode,
    ).toBe(403);
  });
});

describe('a key that should not work', () => {
  it('is refused once revoked', async () => {
    const key = await mintKey('short lived');
    expect((await withKey(key, { url: '/api/library' })).statusCode).toBe(200);
    const list = (await withSession({ url: '/api/keys' })).json() as {
      keys: { id: string; name: string }[];
    };
    const id = list.keys.find((k) => k.name === 'short lived')!.id;
    expect((await withSession({ method: 'DELETE', url: `/api/keys/${id}` })).statusCode).toBe(200);
    expect((await withKey(key, { url: '/api/library' })).statusCode).toBe(401);
  });

  it('is refused when it is nonsense, rather than falling back to anonymous', async () => {
    for (const bad of ['rp_deadbeef_' + 'f'.repeat(48), 'not-a-key', 'rp_zz_1']) {
      expect((await withKey(bad, { url: '/api/library' })).statusCode, bad).toBe(401);
    }
  });

  it('stops working when the account is disabled', async () => {
    const key = await mintKey('disabled owner');
    db.prepare("UPDATE users SET status = 'disabled' WHERE username = 'admin'").run();
    expect((await withKey(key, { url: '/api/library' })).statusCode).toBe(401);
    db.prepare("UPDATE users SET status = 'active' WHERE username = 'admin'").run();
  });
});
