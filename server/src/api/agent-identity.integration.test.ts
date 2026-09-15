import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createApiKey } from '../auth/apikeys.js';
import { openDatabase, type DB } from '../db/index.js';
import { loadConfig } from '../config.js';
import { AGENT_REJECT_LIMIT } from './agent-contract.js';

/**
 * Who may reach the agent API, and what a refusal costs.
 *
 * A browser session and a proxy identity are people; a key is an agent. The
 * agent routes answer only keys, and refusals - a key that does not resolve,
 * a key on a route it may not read - are counted by address so an address
 * cannot try forever.
 */

let dir: string;
let db: DB;
let app: ReturnType<typeof buildApp>;
let key: string;
const now = '2026-09-14T00:00:00.000Z';

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-agent-identity-'));
  db = openDatabase(dir);
  db.prepare(
    "INSERT INTO users (id,username,password_hash,role,created_at) VALUES ('u','reader','unused','reader',?)",
  ).run(now);
  key = createApiKey(db, { id: 'k', userId: 'u', name: 'test', now }).key;
  app = buildApp({
    db,
    config: loadConfig({
      dataDir: dir,
      cacheDir: path.join(dir, 'cache'),
      logLevel: 'fatal',
      proxyAuthHeader: 'x-rp-test-user',
      proxyAuthSources: ['10.0.0.0/8'],
    }),
    log: { info() {}, warn() {}, error() {} },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('a proxy identity - a person - cannot read the agent API, and a key can', async () => {
  const asPerson = await app.inject({
    url: '/api/agent/v1/me',
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': 'reader' },
  });
  expect(asPerson.statusCode).toBe(403);
  // The same person reaches the ordinary API through the proxy as before.
  const ordinary = await app.inject({
    url: '/api/auth/me',
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': 'reader' },
  });
  expect(ordinary.statusCode).toBe(200);
  const asAgent = await app.inject({
    url: '/api/agent/v1/me',
    headers: { authorization: `Bearer ${key}` },
  });
  expect(asAgent.statusCode).toBe(200);
});

it('refusals are metered by address: a storm of bad keys becomes 429, and the real key still works elsewhere', async () => {
  const bad = () =>
    app.inject({
      url: '/api/agent/v1/me',
      remoteAddress: '203.0.113.9',
      headers: { authorization: 'Bearer rp_00000000_' + '0'.repeat(48) },
    });
  for (let i = 0; i < AGENT_REJECT_LIMIT; i++) expect((await bad()).statusCode).toBe(401);
  const capped = await bad();
  expect(capped.statusCode).toBe(429);
  expect(capped.headers['retry-after']).toBe('60');
  // Another address is unaffected, and so is a valid key from this one.
  const elsewhere = await app.inject({
    url: '/api/agent/v1/me',
    remoteAddress: '198.51.100.7',
    headers: { authorization: 'Bearer rp_00000000_' + '0'.repeat(48) },
  });
  expect(elsewhere.statusCode).toBe(401);
  const valid = await app.inject({
    url: '/api/agent/v1/me',
    remoteAddress: '203.0.113.9',
    headers: { authorization: `Bearer ${key}` },
  });
  expect(valid.statusCode).toBe(200);
});

it('a valid key on a forbidden route is metered the same way', async () => {
  const forbidden = () =>
    app.inject({
      method: 'POST',
      url: '/api/agent/v1/me',
      remoteAddress: '203.0.113.10',
      headers: { authorization: `Bearer ${key}` },
    });
  for (let i = 0; i < AGENT_REJECT_LIMIT; i++) expect((await forbidden()).statusCode).toBe(403);
  expect((await forbidden()).statusCode).toBe(429);
});

it('says how long a read budget takes to open again, not a round number', async () => {
  for (let i = 0; i < 120; i++) {
    const r = await app.inject({
      url: '/api/agent/v1/me',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(r.statusCode).toBe(200);
  }
  const limited = await app.inject({
    url: '/api/agent/v1/me',
    headers: { authorization: `Bearer ${key}` },
  });
  expect(limited.statusCode).toBe(429);
  const seconds = Number(limited.headers['retry-after']);
  expect(seconds).toBeGreaterThanOrEqual(1);
  expect(seconds).toBeLessThanOrEqual(60);
});
