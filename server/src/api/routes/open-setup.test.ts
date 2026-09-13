import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openDatabase, type DB } from '../../db/index.js';
import { ensureSetupToken } from '../../auth/setupToken.js';

/**
 * First run with no RP_SETUP_TOKEN: the ordinary case.
 *
 * You start the container, open it, and make your account. No string to copy
 * out of `docker logs`, no file to cat. The existing integration test covers
 * the LOCKED instance in detail; this one exists because the unlocked path is
 * the default, and a default nobody exercises is a default that rots.
 *
 * The property that has to hold is the closing, not the opening: the window
 * is "no users yet", and once an admin exists it must be shut for good - no
 * second admin, no wizard helpers, no way back in through /api/setup.
 */

let tmp: string;
let db: DB;
let app: ReturnType<typeof buildApp>;
const warnings: string[] = [];

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-open-setup-'));
  const config = loadConfig({
    dataDir: path.join(tmp, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    sessionSecret: 'open-setup-test-secret-0123456789',
    logLevel: 'error',
    // Deliberately no setupToken.
  });
  db = openDatabase(config.dataDir);
  const ctx = {
    db,
    config,
    log: { info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} },
  };
  // Exactly what index.ts does at boot, so this exercises the real wiring
  // rather than a hand-set null.
  ctx.setupToken = ensureSetupToken(config, db, ctx.log);
  app = buildApp(ctx);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    payload: payload as never,
    headers: {
      'x-rp-csrf': '1',
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
  });

describe('an instance with no setup token', () => {
  it('tells the wizard not to ask for one', async () => {
    const res = await app.inject({ url: '/api/setup/status' });
    expect(res.json()).toMatchObject({ needsSetup: true, setupTokenRequired: false });
    // The value itself is never in the payload, locked or not.
    expect(JSON.stringify(res.json())).not.toContain('setupToken"');
  });

  it('opens the wizard helpers, which are only reachable while it is empty', async () => {
    expect(
      (await app.inject({ url: `/api/setup/browse?path=${encodeURIComponent(tmp)}` })).statusCode,
    ).toBe(200);
    expect((await post('/api/setup/test-paths', { paths: [tmp], kind: 'ebook' })).statusCode).toBe(
      200,
    );
  });

  it('answers the preflight self-check, which the wizard shows before writing anything', async () => {
    // The last wizard screen reports what the server can actually do -
    // ffmpeg, the ONNX runtime, free space, whether the alignment folder is
    // writable. It lived behind its own copy of the setup gate, so when the
    // token became optional it started refusing the default first run and
    // the checklist rendered "could not be checked" on every install.
    const res = await post('/api/preflight', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('aligner');
  });

  it('verify is a no-op rather than a refusal', async () => {
    // The wizard does not call it, but an older client might.
    expect((await post('/api/setup/verify', { setupToken: 'anything at all' })).statusCode).toBe(
      200,
    );
  });

  it('still enforces the account rules', async () => {
    expect((await post('/api/setup', { username: 'me', password: 'short' })).statusCode).toBe(400);
    expect(
      (await post('/api/setup', { username: 'x', password: 'long-enough-password' })).statusCode,
    ).toBe(400);
  });

  it('creates the admin with no token, and signs them in', async () => {
    const res = await post('/api/setup', {
      username: 'ilan',
      password: 'a-perfectly-good-password',
      displayName: 'Ilan',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { username: 'ilan', role: 'admin' } });
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const me = await app.inject({ url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ user: { username: 'ilan', role: 'admin' } });
  });
});

describe('once an admin exists', () => {
  it('shuts the door for good', async () => {
    expect((await app.inject({ url: '/api/setup/status' })).json()).toMatchObject({
      needsSetup: false,
      setupTokenRequired: false,
    });
    const second = await post('/api/setup', {
      username: 'someone-else',
      password: 'also-a-good-password',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'already-configured' });
    expect((await post('/api/setup/verify', { setupToken: 'x' })).statusCode).toBe(409);
    // And the helpers close with it - they were open because the instance was
    // empty, not because they are public.
    expect((await app.inject({ url: '/api/setup/browse?path=/' })).statusCode).toBe(403);
    expect((await post('/api/setup/test-paths', { paths: ['/'] })).statusCode).toBe(403);
    expect((await post('/api/preflight', {})).statusCode).toBe(403);
    // Exactly one account exists.
    expect((db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c).toBe(1);
  });
});

describe('the operator is told', () => {
  it('warns at boot that setup is open, and how to lock it', () => {
    // Discovering this from a blog post after someone else claimed your
    // server is too late.
    const all = warnings.join('\n');
    expect(all).toMatch(/OPEN/);
    expect(all).toMatch(/RP_SETUP_TOKEN/);
  });
});
