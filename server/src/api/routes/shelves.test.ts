import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';

/**
 * Where a reading-list entry came from. A friend's recommendation or a
 * share link can put a book on somebody's list; the row remembers who, the
 * list reads it back with their current name, and a book the reader queued
 * for themselves keeps saying nothing at all.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-shelves-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: tmp,
    cacheDir: tmp,
    sessionSecret: 'shelves-test-secret-0123456789abcdef',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});

const as = (
  user: string,
  url: string,
  method: 'GET' | 'PUT' | 'DELETE' = 'GET',
  payload?: unknown,
) =>
  app.inject({
    url,
    method,
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': user, 'x-rp-csrf': '1' },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

interface Item {
  book: { id: string };
  recommendedBy: { userId: string; displayName: string; at: string } | null;
}
const list = async (user: string) =>
  ((await as(user, '/api/reading-list')).json() as { items: Item[] }).items;

const ids: Record<string, string> = {};

beforeAll(async () => {
  await app.ready();
  for (const u of ['alice', 'bob']) {
    ids[u] = ((await as(u, '/api/auth/me')).json() as { user: { id: string } }).user.id;
  }
  db.prepare("UPDATE users SET display_name = 'Bob Bookish' WHERE id = ?").run(ids.bob);
  const book = db.prepare(
    `INSERT INTO books (id,kind,root_dir,rel_path,format,title,author,scan_state,added_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const now = new Date().toISOString();
  book.run('b1', 'ebook', tmp, 'b1.epub', 'epub', 'One', null, 'ready', now);
  book.run('b2', 'ebook', tmp, 'b2.epub', 'epub', 'Two', null, 'ready', now);
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('recommended by', () => {
  it("is remembered when a book is queued on somebody's say-so", async () => {
    const res = await as('alice', '/api/reading-list/b1', 'PUT', { recommendedBy: ids.bob });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ added: true });
    const [item] = await list('alice');
    expect(item!.recommendedBy).toMatchObject({ userId: ids.bob, displayName: 'Bob Bookish' });
    expect(Date.parse(item!.recommendedBy!.at)).toBeGreaterThan(Date.now() - 10_000);
  });

  it('is nothing for a book the reader queued themselves', async () => {
    await as('alice', '/api/reading-list/b2', 'PUT', {});
    const two = (await list('alice')).find((i) => i.book.id === 'b2')!;
    expect(two.recommendedBy).toBeNull();
  });

  it('must name an account that exists, and not the reader themselves', async () => {
    expect(
      (await as('bob', '/api/reading-list/b1', 'PUT', { recommendedBy: 'user_nobody' })).statusCode,
    ).toBe(400);
    expect(
      (await as('bob', '/api/reading-list/b1', 'PUT', { recommendedBy: ids.bob })).statusCode,
    ).toBe(400);
    expect(await list('bob')).toEqual([]);
  });

  it('does not overwrite the provenance of a book already on the list', async () => {
    const res = await as('alice', '/api/reading-list/b2', 'PUT', { recommendedBy: ids.bob });
    expect(res.json()).toMatchObject({ added: false });
    const two = (await list('alice')).find((i) => i.book.id === 'b2')!;
    expect(two.recommendedBy).toBeNull();
  });

  it('reads the recommender under their current name', async () => {
    db.prepare("UPDATE users SET display_name = 'Robert' WHERE id = ?").run(ids.bob);
    const one = (await list('alice')).find((i) => i.book.id === 'b1')!;
    expect(one.recommendedBy!.displayName).toBe('Robert');
  });

  it('goes with the recommender when their account is deleted', async () => {
    db.prepare('DELETE FROM users WHERE id = ?').run(ids.bob);
    const one = (await list('alice')).find((i) => i.book.id === 'b1')!;
    expect(one.recommendedBy).toBeNull();
  });
});
