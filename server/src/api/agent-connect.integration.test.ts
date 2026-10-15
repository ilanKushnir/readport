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
import { CONNECT_RETRY_GRACE_MS, CONNECT_TTL_MS, redeemConnectCode } from '../auth/connect.js';

/**
 * Connecting an agent with a one-time code.
 *
 * The promise: the message pasted into a chat holds no working credential
 * once it has been used, the key reaches only the agent that redeemed it, and
 * nothing about the code path widens what a key can do.
 */

let dir: string;
let db: DB;
let app: ReturnType<typeof buildApp>;
let cookie = '';
const logs: string[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-connect-'));
  const config = loadConfig({
    dataDir: path.join(dir, 'data'),
    cacheDir: path.join(dir, 'cache'),
    sessionSecret: 'connect-test-secret-0123456789abc',
    logLevel: 'error',
    agentUrl: 'http://10.0.0.5:7323',
  });
  db = openDatabase(config.dataDir);
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, can_export, display_name, status, created_at)
     VALUES (?, 'admin', ?, 'admin', 1, 'Ada', 'active', ?)`,
  ).run(newId('user'), await hashPassword('admin-password-123'), nowIso());
  app = buildApp({
    db,
    config,
    log: { info: (m) => logs.push(String(m)), warn: () => {}, error: (m) => console.error(m) },
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
      host: 'readport.example',
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
  });

/** As an agent would: no cookie, no CSRF header, nothing but the code. */
const redeem = (code: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/agent/v1/connect',
    payload: { code } as never,
    headers: { 'content-type': 'application/json', host: 'readport.example', ...headers },
  });

async function newConnect(name = 'Hermes') {
  const res = await withSession({ method: 'POST', url: '/api/keys/connect', payload: { name } });
  expect(res.statusCode).toBe(200);
  const connect = res.json().connect as { id: string; brief: string; expiresAt: string };
  const code = /Connect code: (rpc_[0-9a-f]{32})/.exec(connect.brief)![1]!;
  return { ...connect, code };
}

const agentGet = (key: string, url: string) =>
  app.inject({ url, headers: { authorization: `Bearer ${key}`, host: 'readport.example' } });

describe('the connect message', () => {
  it('carries a one-time code and the way to use it, never a key', async () => {
    const { brief, code } = await newConnect();
    expect(brief).not.toMatch(/rp_[0-9a-f]{8}_/);
    expect(brief).toContain('http://readport.example/api/agent/v1/connect');
    expect(brief).toContain('http://readport.example/api/agent/v1/skill.md');
    // The direct address is offered only as the way round a refusal.
    expect(brief).toContain('POST http://10.0.0.5:7323/api/agent/v1/connect');
    // Only a hash is stored.
    const rows = db.prepare('SELECT code_hash FROM agent_connect_codes').all() as {
      code_hash: string;
    }[];
    expect(rows.every((r) => r.code_hash !== code)).toBe(true);
  });

  it('is listed as pending until used, and can be cancelled', async () => {
    const { id, code } = await newConnect('Cancelled');
    const pending = (await withSession({ url: '/api/keys' })).json().pending as { id: string }[];
    expect(pending.some((p) => p.id === id)).toBe(true);
    expect(
      (await withSession({ method: 'DELETE', url: `/api/keys/connect/${id}` })).statusCode,
    ).toBe(200);
    expect((await withSession({ url: `/api/keys/connect/${id}` })).json().status).toBe('cancelled');
    expect((await redeem(code)).statusCode).toBe(401);
  });

  it('cannot be made with a key', async () => {
    const { code } = await newConnect();
    const key = (await redeem(code)).json().apiKey as string;
    const res = await app.inject({
      method: 'POST',
      url: '/api/keys/connect',
      payload: { name: 'x' },
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('redeeming a code', () => {
  it('hands the agent a working read-only key and where to use it', async () => {
    const { id, code } = await newConnect('Hermes');
    const res = await redeem(code);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.apiKey).toMatch(KEY_RE);
    expect(body.baseUrl).toBe('http://10.0.0.5:7323/api/agent/v1');
    expect(body.publicBaseUrl).toBe('http://readport.example/api/agent/v1');
    expect(body.skillUrl).toBe('http://readport.example/api/agent/v1/skill.md');
    expect(body.user.username).toBe('admin');
    expect(body.service.name).toBe('readport');

    const me = await agentGet(body.apiKey, '/api/agent/v1/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().service.version).toBe(body.service.version);
    expect((await withSession({ url: `/api/keys/connect/${id}` })).json().status).toBe('connected');
    const keys = (await withSession({ url: '/api/keys' })).json();
    expect(keys.keys.some((k: { name: string }) => k.name === 'Hermes')).toBe(true);
    expect(keys.pending.some((p: { id: string }) => p.id === id)).toBe(false);
    // The audit line names the key, never the key or the code.
    const line = logs.find((l) => l.includes('agent-connect'))!;
    expect(line).not.toContain(code);
    expect(line).not.toContain(body.apiKey);
  });

  it('a retry within the grace replaces the key; after it, the code is spent', async () => {
    const { code } = await newConnect('Retry');
    const first = (await redeem(code)).json().apiKey as string;
    const second = (await redeem(code)).json().apiKey as string;
    expect(second).not.toBe(first);
    expect((await agentGet(first, '/api/agent/v1/me')).statusCode).toBe(401);
    expect((await agentGet(second, '/api/agent/v1/me')).statusCode).toBe(200);

    const later = new Date(Date.now() + CONNECT_RETRY_GRACE_MS + 1000).toISOString();
    expect(redeemConnectCode(db, code, later)).toEqual({ ok: false, error: 'code-expired' });
    expect((await agentGet(second, '/api/agent/v1/me')).statusCode).toBe(200);
  });

  it('refuses an expired, unknown or malformed code', async () => {
    const { code } = await newConnect('Late');
    const later = new Date(Date.now() + CONNECT_TTL_MS + 1000).toISOString();
    expect(redeemConnectCode(db, code, later)).toEqual({ ok: false, error: 'code-expired' });
    expect((await redeem(`rpc_${'0'.repeat(32)}`)).json().error).toBe('invalid-code');
    expect((await redeem('rp_12345678_' + '0'.repeat(48))).statusCode).toBe(401);
    expect((await redeem(42)).statusCode).toBe(400);
  });

  it('refuses a code whose account was disabled', async () => {
    const { code } = await newConnect('Disabled');
    db.prepare("UPDATE users SET status = 'disabled'").run();
    try {
      expect((await redeem(code)).statusCode).toBe(401);
    } finally {
      db.prepare("UPDATE users SET status = 'active'").run();
    }
  });

  it('meters attempts by address', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.9' };
    db.prepare("DELETE FROM login_throttle WHERE key LIKE 'agent:connect:%'").run();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await redeem('nope', headers)).statusCode);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    db.prepare("DELETE FROM login_throttle WHERE key LIKE 'agent:connect:%'").run();
  });
});

describe('the skill', () => {
  it('is public, holds no secret, and names this server', async () => {
    const res = await app.inject({ url: '/api/agent/v1/skill.md', headers: { host: 'x.example' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toMatch(/^---\nname: readport\n/);
    expect(res.body).toContain('http://10.0.0.5:7323/api/agent/v1');
    for (const route of ['/me', '/books', '/reading-list', '/annotations', '/shelves']) {
      expect(res.body).toContain(`\`${route}`);
    }
    expect(res.body).not.toMatch(/rp_[0-9a-f]{8}_|rpc_[0-9a-f]{32}/);
  });

  it('is still served to an agent that sends its key', async () => {
    const { code } = await newConnect('Habit');
    const key = (await redeem(code)).json().apiKey as string;
    expect((await agentGet(key, '/api/agent/v1/skill.md')).statusCode).toBe(200);
  });
});
