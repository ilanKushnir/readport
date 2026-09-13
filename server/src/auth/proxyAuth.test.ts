import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp } from '../api/app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import { type AppContext } from '../context.js';
import { buildSourceList, normalizePeer, peerIsTrusted } from './proxyAuth.js';

let app: FastifyInstance;
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-proxyauth-'));
  const config = loadConfig({
    dataDir: path.join(tmp, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    sessionSecret: 'proxy-auth-test-secret-0123456789',
    setupToken: 'proxy-auth-setup-token',
    logLevel: 'error',
    proxyAuthHeader: 'x-authentik-username',
    proxyAuthSources: ['10.0.0.0/8', '192.168.1.50'],
    proxyAuthAdmins: ['ilan'],
  });
  const ctx: AppContext = {
    db: openDatabase(config.dataDir),
    config,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  app = buildApp(ctx);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('proxy header SSO', () => {
  it('parses sources and peers', () => {
    const list = buildSourceList(['192.168.1.50', '10.0.0.0/8']);
    expect(peerIsTrusted(list, '192.168.1.50')).toBe(true);
    expect(peerIsTrusted(list, '10.20.30.40')).toBe(true);
    expect(peerIsTrusted(list, '192.168.1.51')).toBe(false);
    expect(peerIsTrusted(null, '192.168.1.50')).toBe(false);
    expect(normalizePeer('::ffff:192.168.1.50')).toBe('192.168.1.50');
    expect(() => buildSourceList(['not-an-ip'])).toThrow();
  });

  it('ignores the header from an untrusted peer (direct LAN access cannot forge it)', async () => {
    const res = await app.inject({
      url: '/api/auth/me',
      remoteAddress: '192.168.1.99',
      headers: { 'x-authentik-username': 'mallory' },
    });
    expect(res.statusCode).toBe(401);
    const status = await app.inject({ url: '/api/setup/status', remoteAddress: '192.168.1.99' });
    expect(status.json()).toMatchObject({ needsSetup: true });
  });

  it('provisions the first proxied user as admin and later ones as users', async () => {
    const first = await app.inject({
      url: '/api/auth/me',
      remoteAddress: '192.168.1.50',
      headers: { 'x-authentik-username': 'dana' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ user: { username: 'dana', role: 'admin' }, via: 'proxy' });

    const second = await app.inject({
      url: '/api/auth/me',
      remoteAddress: '10.1.2.3',
      headers: { 'x-authentik-username': 'guest' },
    });
    expect(second.json()).toMatchObject({ user: { username: 'guest', role: 'reader' } });

    // Listed admins are admins regardless of order.
    const admin = await app.inject({
      url: '/api/auth/me',
      remoteAddress: '10.1.2.3',
      headers: { 'x-authentik-username': 'ilan' },
    });
    expect(admin.json()).toMatchObject({ user: { username: 'ilan', role: 'admin' } });

    // Setup is closed once a user exists; the token path cannot add another admin.
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      remoteAddress: '192.168.1.99',
      headers: { 'x-rp-csrf': '1', 'content-type': 'application/json' },
      payload: {
        username: 'late',
        password: 'long-enough-password',
        setupToken: 'proxy-auth-setup-token',
      },
    });
    expect(setup.statusCode).toBe(409);
  });

  it('rejects malformed header values', async () => {
    const res = await app.inject({
      url: '/api/auth/me',
      remoteAddress: '192.168.1.50',
      headers: { 'x-authentik-username': 'bad name; drop' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('proxied users cannot log in with a password (no usable hash)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '192.168.1.99',
      headers: { 'x-rp-csrf': '1', 'content-type': 'application/json' },
      payload: { username: 'dana', password: '!proxy-sso' },
    });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * Break-glass: a way back in that does not depend on the proxy.
 *
 * A provisioned account has no password, and until now could never get one -
 * so if the identity provider went down, or the gate in front of the app was
 * ever taken off to let other people in, the admin was locked out of their
 * own library. Setting a first password is therefore allowed WITHOUT proving
 * the old one, because there is no old one; every other case still must.
 */
describe('setting a first password on a provisioned account', () => {
  const asDana = (payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/password',
      remoteAddress: '192.168.1.50',
      headers: {
        'x-authentik-username': 'dana',
        'x-rp-csrf': '1',
        'content-type': 'application/json',
      },
      payload: payload as never,
    });

  it('says the account has no password of its own', async () => {
    const me = await app.inject({
      url: '/api/auth/me',
      remoteAddress: '192.168.1.50',
      headers: { 'x-authentik-username': 'dana' },
    });
    expect(me.json()).toMatchObject({ via: 'proxy', hasPassword: false });
  });

  it('still enforces the strength rule', async () => {
    expect((await asDana({ newPassword: 'short' })).statusCode).toBe(400);
  });

  it('sets one, and the account can then sign in without the proxy', async () => {
    expect((await asDana({ newPassword: 'a-real-password-now' })).statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      // Not the proxy: a direct peer, which is the whole point.
      remoteAddress: '192.168.1.99',
      headers: { 'x-rp-csrf': '1', 'content-type': 'application/json' },
      payload: { username: 'dana', password: 'a-real-password-now' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('will not skip the check a second time', async () => {
    // The account now HAS a password, so omitting the current one is refused
    // rather than treated as another first-time set.
    expect((await asDana({ newPassword: 'another-password-x' })).statusCode).toBe(403);
    expect(
      (
        await asDana({
          currentPassword: 'a-real-password-now',
          newPassword: 'another-password-x',
        })
      ).statusCode,
    ).toBe(200);
  });
});
