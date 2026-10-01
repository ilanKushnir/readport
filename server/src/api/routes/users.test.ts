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
 * open for a week, for the address it was asked with, in the language the
 * admin chose, stored as a hash of a code only the server can say again.
 * The admin is told the code, to send it on: ReadPort sends no mail.
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
  language?: string | null;
  invite?: {
    code: string;
    path: string;
    url: string | null;
    expiresAt: string;
    language: string | null;
  } | null;
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
    // The way in, for the admin to send on - the code the share link will
    // derive for this request, and the link that carries it - but never the
    // hash it is kept as.
    const derived = deriveInviteToken(SECRET, ada!.id);
    expect(request.invite).toMatchObject({
      code: derived,
      path: `/join/${encodeURIComponent(derived)}`,
      // No public address configured: the admin's browser supplies its own.
      url: null,
      language: null,
    });
    expect(res.body).not.toMatch(/token_hash|[0-9a-f]{64}/);

    const row = db
      .prepare('SELECT invite_id, decided_by FROM join_requests WHERE id = ?')
      .get(ada!.id) as { invite_id: string; decided_by: string };
    expect(row.decided_by).toBe(ids.astra);
    const invite = db
      .prepare(
        'SELECT role, can_export, display_name, username, created_by, expires_at, token_hash, email, language FROM invites WHERE id = ?',
      )
      .get(row.invite_id) as {
      role: string;
      can_export: number;
      display_name: string;
      username: string | null;
      created_by: string;
      expires_at: string;
      token_hash: string;
      email: string | null;
      language: string | null;
    };
    expect(invite).toMatchObject({
      role: 'reader',
      can_export: 0,
      display_name: 'Ada',
      username: null,
      created_by: ids.astra,
      // For the address they asked with; no language asked or chosen.
      email: 'ada@example.org',
      language: null,
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

describe('the language they are let in in, and what the account carries', () => {
  const PASSWORD = 'a long enough password';
  let dan: RequestDto;

  it('remembers the language a request was asked in, and offers it', async () => {
    createJoinRequest(db, {
      email: 'dan@example.org',
      name: 'Dan',
      language: 'he',
      shareToken: token,
    });
    dan = (await listed()).find((r) => r.email === 'dan@example.org')!;
    expect(dan.language).toBe('he');
  });

  it('lets them in in the language the admin chose', async () => {
    const res = await as('astra', `/api/join-requests/${dan.id}/approve`, 'POST', {
      language: 'ru',
    });
    expect(res.statusCode).toBe(200);
    const { request } = res.json() as { request: RequestDto };
    expect(request.invite?.language).toBe('ru');
    // ...and keeps the way in on the list until it is used.
    expect((await listed()).find((r) => r.id === dan.id)?.invite?.code).toBe(
      deriveInviteToken(SECRET, dan.id),
    );
  });

  it('refuses a language the app does not speak', async () => {
    createJoinRequest(db, { email: 'eve@example.org', shareToken: token });
    const eve = (await listed()).find((r) => r.email === 'eve@example.org')!;
    const res = await as('astra', `/api/join-requests/${eve.id}/approve`, 'POST', {
      language: 'xx',
    });
    expect(res.statusCode).toBe(400);
  });

  it('tells whoever holds the link which address and language it is for', async () => {
    const code = deriveInviteToken(SECRET, dan.id);
    const peek = await app.inject({ url: `/api/invites/${code}`, remoteAddress: '203.0.113.2' });
    expect(peek.json()).toMatchObject({ email: 'dan@example.org', language: 'ru' });
    // The share page they asked on hears it too, with the code.
    const status = await app.inject({
      url: `/api/share/${token}/join?email=dan@example.org`,
      remoteAddress: '203.0.113.2',
    });
    expect(status.json()).toMatchObject({ status: 'approved', inviteToken: code, language: 'ru' });
  });

  it('opens an account that carries the address and speaks the language', async () => {
    const code = deriveInviteToken(SECRET, dan.id);
    const res = await app.inject({
      url: `/api/invites/${code}/accept`,
      method: 'POST',
      remoteAddress: '203.0.113.2',
      headers: { 'x-rp-csrf': '1' },
      payload: { username: 'dan', password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { user: { id: string } }).user.id;
    expect(
      (db.prepare('SELECT email FROM users WHERE id = ?').get(id) as { email: string }).email,
    ).toBe('dan@example.org');
    const cookie = res.cookies.find((c) => c.name === 'rp_session')!.value;
    const me = await app.inject({ url: '/api/auth/me', cookies: { rp_session: cookie } });
    expect((me.json() as { locale: string | null }).locale).toBe('ru');
  });

  it('signs them in by that address, however it is capitalised', async () => {
    const login = (username: string, password = PASSWORD) =>
      app.inject({
        url: '/api/auth/login',
        method: 'POST',
        remoteAddress: '203.0.113.3',
        headers: { 'x-rp-csrf': '1' },
        payload: { username, password },
      });
    expect((await login('Dan@Example.org')).statusCode).toBe(200);
    expect((await login('dan')).statusCode).toBe(200);
    expect((await login('dan@example.org', 'not the password')).statusCode).toBe(401);
    expect((await login('nobody@example.org')).statusCode).toBe(401);
  });
});

describe('an admin choosing an account’s language and address', () => {
  type U = { id: string; email: string | null; locale: string | null };
  const send = (url: string, method: 'POST' | 'PATCH', payload: unknown) =>
    app.inject({
      url,
      method,
      remoteAddress: '10.0.0.5',
      headers: { 'x-rp-test-user': 'astra', 'x-rp-csrf': '1' },
      payload: payload as never,
    });
  let erin: U;

  it('gives an account it creates a language and an address from the start', async () => {
    const res = await send('/api/users', 'POST', {
      username: 'erin',
      password: 'a long enough password',
      email: 'Erin@Example.org',
      locale: 'fr',
    });
    expect(res.statusCode).toBe(201);
    erin = (res.json() as { user: U }).user;
    expect(erin).toMatchObject({ email: 'erin@example.org', locale: 'fr' });
  });

  it('changes either later, and hands the language back to their device', async () => {
    let res = await send(`/api/users/${erin.id}`, 'PATCH', { locale: 'de' });
    expect((res.json() as { user: U }).user.locale).toBe('de');
    res = await send(`/api/users/${erin.id}`, 'PATCH', { locale: null, email: null });
    expect((res.json() as { user: U }).user).toMatchObject({ locale: null, email: null });
    res = await send(`/api/users/${erin.id}`, 'PATCH', { email: 'erin@example.net' });
    expect((res.json() as { user: U }).user.email).toBe('erin@example.net');
  });

  it('never gives two accounts the same address', async () => {
    const taken = await send('/api/users', 'POST', {
      username: 'erin2',
      password: 'a long enough password',
      email: 'ERIN@example.net',
    });
    expect(taken.statusCode).toBe(409);
    expect((taken.json() as { error: string }).error).toBe('email-taken');
    const dan = db.prepare("SELECT id FROM users WHERE username = 'dan'").get() as { id: string };
    const moved = await send(`/api/users/${dan.id}`, 'PATCH', { email: 'erin@example.net' });
    expect(moved.statusCode).toBe(409);
  });

  it('refuses a language the app does not speak', async () => {
    expect((await send(`/api/users/${erin.id}`, 'PATCH', { locale: 'xx' })).statusCode).toBe(400);
  });

  it('puts an invitation it writes in a language, for an address', async () => {
    const res = await send('/api/invites', 'POST', {
      role: 'reader',
      email: 'fay@example.org',
      language: 'ja',
    });
    expect(res.statusCode).toBe(201);
    const { code } = res.json() as { code: string };
    const peek = await app.inject({ url: `/api/invites/${code}`, remoteAddress: '203.0.113.4' });
    expect(peek.json()).toMatchObject({ email: 'fay@example.org', language: 'ja' });
    const list = (
      (await as('astra', '/api/users')).json() as {
        invites: { email: string | null; language: string | null }[];
      }
    ).invites;
    expect(list).toContainEqual(
      expect.objectContaining({ email: 'fay@example.org', language: 'ja' }),
    );
  });
});
