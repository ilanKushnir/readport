import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { createJoinRequest, deriveInviteToken } from '../../share/service.js';
import { createSession } from '../../auth/sessions.js';

/**
 * The admin's side of a join request: who may see and decide them, what a
 * decision does to the row, and that approval mints exactly the invitation
 * the share link will later hand over - a reader, named after the request,
 * open for a week, stored as a hash of a code nobody wrote down.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-users-'));
const db = openMemoryDatabase();
const SECRET = 'users-test-secret-0123456789abcdef';
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: tmp,
    cacheDir: tmp,
    sessionSecret: SECRET,
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});

const as = (user: string, url: string, method: 'GET' | 'POST' = 'GET', payload?: unknown) =>
  app.inject({
    url,
    method,
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': user, 'x-rp-csrf': '1' },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

interface RequestDto {
  id: string;
  email: string;
  name: string | null;
  status: string;
  decidedAt: string | null;
  book: { id: string; title: string } | null;
  sharedBy: { displayName: string } | null;
}
const listed = async () =>
  ((await as('astra', '/api/join-requests')).json() as { requests: RequestDto[] }).requests;

const ids: Record<string, string> = {};
let token = '';

beforeAll(async () => {
  await app.ready();
  for (const u of ['astra', 'bob']) {
    ids[u] = ((await as(u, '/api/auth/me')).json() as { user: { id: string } }).user.id;
  }
  db.prepare("UPDATE users SET display_name = 'Bob Bookish' WHERE id = ?").run(ids.bob);
  db.prepare(
    `INSERT INTO books (id,kind,root_dir,rel_path,format,title,author,scan_state,added_at)
     VALUES ('b1','ebook',?,'b1.epub','epub','The Lantern of Ash Harbor','M. Vale','ready',?)`,
  ).run(tmp, new Date().toISOString());
  token = ((await as('bob', '/api/books/b1/share', 'POST')).json() as { token: string }).token;
  for (const [email, name] of [
    ['ada@example.org', 'Ada'],
    ['ben@example.org', undefined],
    ['cy@example.org', 'Cy'],
  ] as const) {
    createJoinRequest(db, { email, name, shareToken: token });
  }
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('listing', () => {
  it('is for admins', async () => {
    expect((await as('bob', '/api/join-requests')).statusCode).toBe(403);
    expect((await as('astra', '/api/join-requests')).statusCode).toBe(200);
  });

  it('shows each request with the book and the sharer it came through', async () => {
    const rows = await listed();
    expect(rows.map((r) => r.email)).toEqual([
      'ada@example.org',
      'ben@example.org',
      'cy@example.org',
    ]);
    expect(rows[0]).toMatchObject({
      name: 'Ada',
      status: 'pending',
      decidedAt: null,
      book: { id: 'b1', title: 'The Lantern of Ash Harbor' },
      sharedBy: { displayName: 'Bob Bookish' },
    });
    expect(rows[1]!.name).toBeNull();
  });
});

describe('deciding', () => {
  it('is for admins, and only once', async () => {
    const [ada] = await listed();
    expect((await as('bob', `/api/join-requests/${ada!.id}/approve`, 'POST')).statusCode).toBe(403);
    expect((await as('bob', `/api/join-requests/${ada!.id}/decline`, 'POST')).statusCode).toBe(403);
    expect((await as('astra', '/api/join-requests/jr_nope/approve', 'POST')).statusCode).toBe(404);
  });

  it('approval mints a week-long reader invitation named after the request', async () => {
    const [ada] = await listed();
    const before = Date.now();
    const res = await as('astra', `/api/join-requests/${ada!.id}/approve`, 'POST');
    expect(res.statusCode).toBe(200);
    const { request } = res.json() as { request: RequestDto };
    expect(request).toMatchObject({ id: ada!.id, status: 'approved' });
    expect(request.decidedAt).not.toBeNull();
    // Never the code, never the hash.
    expect(res.body).not.toMatch(/token/i);

    const row = db
      .prepare('SELECT invite_id, decided_by FROM join_requests WHERE id = ?')
      .get(ada!.id) as { invite_id: string; decided_by: string };
    expect(row.decided_by).toBe(ids.astra);
    const invite = db
      .prepare(
        'SELECT role, can_export, display_name, username, created_by, expires_at, token_hash FROM invites WHERE id = ?',
      )
      .get(row.invite_id) as {
      role: string;
      can_export: number;
      display_name: string;
      username: string | null;
      created_by: string;
      expires_at: string;
      token_hash: string;
    };
    expect(invite).toMatchObject({
      role: 'reader',
      can_export: 0,
      display_name: 'Ada',
      username: null,
      created_by: ids.astra,
    });
    const days = (Date.parse(invite.expires_at) - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    // The stored hash is of the code the link will derive for this request,
    // so the public invite route recognises it.
    const code = deriveInviteToken(SECRET, ada!.id);
    expect(invite.token_hash).not.toBe(code);
    const peek = await app.inject({ url: `/api/invites/${code}`, remoteAddress: '203.0.113.1' });
    expect(peek.statusCode).toBe(200);
    expect(peek.json()).toMatchObject({ role: 'reader', displayName: 'Ada' });

    expect((await as('astra', `/api/join-requests/${ada!.id}/approve`, 'POST')).statusCode).toBe(
      409,
    );
    expect((await as('astra', `/api/join-requests/${ada!.id}/decline`, 'POST')).statusCode).toBe(
      409,
    );
  });

  it('declining records the decision and mints nothing', async () => {
    const ben = (await listed()).find((r) => r.email === 'ben@example.org')!;
    const res = await as('astra', `/api/join-requests/${ben.id}/decline`, 'POST');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { request: RequestDto }).request.status).toBe('declined');
    const row = db.prepare('SELECT invite_id, status FROM join_requests WHERE id = ?').get(ben.id);
    expect(row).toEqual({ invite_id: null, status: 'declined' });
    expect((await as('astra', `/api/join-requests/${ben.id}/approve`, 'POST')).statusCode).toBe(
      409,
    );
  });

  it('keeps the decided ones on the list, pending first', async () => {
    const rows = await listed();
    expect(rows.map((r) => [r.email, r.status])).toEqual([
      ['cy@example.org', 'pending'],
      ['ben@example.org', 'declined'],
      ['ada@example.org', 'approved'],
    ]);
    expect(
      ((await as('astra', '/api/auth/me')).json() as { joinRequests: number }).joinRequests,
    ).toBe(1);
  });

  it('derives the same code for the same request and different codes for different ones', () => {
    expect(deriveInviteToken(SECRET, 'jr_one')).toBe(deriveInviteToken(SECRET, 'jr_one'));
    expect(deriveInviteToken(SECRET, 'jr_one')).not.toBe(deriveInviteToken(SECRET, 'jr_two'));
    expect(deriveInviteToken('another-secret', 'jr_one')).not.toBe(
      deriveInviteToken(SECRET, 'jr_one'),
    );
    expect(deriveInviteToken(SECRET, 'jr_one')).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });
});

describe('last seen', () => {
  const seenOf = async (id: string) =>
    (
      (await as('astra', '/api/users')).json() as {
        users: { id: string; lastSeenAt: string | null; lastLoginAt: string | null }[];
      }
    ).users.find((u) => u.id === id)!;

  it('is when they last used ReadPort, not when they last typed a password', async () => {
    // Joined by invitation: an account with a session and no login, ever.
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, status, created_at)
       VALUES ('user_dora', 'dora', 'x', 'reader', 'active', ?)`,
    ).run(at);
    const { token } = createSession(db, SECRET, 'user_dora', 30);
    const before = await seenOf('user_dora');
    expect(before.lastLoginAt).toBeNull();
    expect(before.lastSeenAt).toBeNull();
    const me = await app.inject({ url: '/api/auth/me', cookies: { rp_session: token } });
    expect(me.statusCode).toBe(200);
    const after = await seenOf('user_dora');
    expect(after.lastLoginAt).toBeNull();
    expect(Date.now() - Date.parse(after.lastSeenAt!)).toBeLessThan(60_000);
  });

  it('outlives the session it came from', async () => {
    db.prepare("DELETE FROM sessions WHERE user_id = 'user_dora'").run();
    expect((await seenOf('user_dora')).lastSeenAt).not.toBeNull();
  });

  it('counts a request through the sign-in proxy too', async () => {
    expect(Date.now() - Date.parse((await seenOf(ids.bob!)).lastSeenAt!)).toBeLessThan(60_000);
  });
});
