import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openMemoryDatabase, nowIso, type DB } from '../db/index.js';
import { ensureSetupToken } from './setupToken.js';
import { setupHelperAllowed, setupIsLocked, setupTokenAccepted } from './setupGate.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
import { LoginThrottle } from './sessions.js';

let tmp: string;
const silentLog = { info: () => {}, warn: () => {} };

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-auth-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function freshDb(): DB {
  return openMemoryDatabase();
}

describe('setup token', () => {
  it('uses the env token when provided and never writes it to disk', () => {
    const dataDir = path.join(tmp, 'env-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const handle = ensureSetupToken(
      { dataDir, setupToken: 'operator-chosen-token' },
      freshDb(),
      silentLog,
    )!;
    expect(handle.source).toBe('env');
    expect(fs.existsSync(path.join(dataDir, 'setup-token'))).toBe(false);
    expect(handle.matches('operator-chosen-token')).toBe(true);
    expect(handle.matches('wrong')).toBe(false);
    expect(handle.matches('')).toBe(false);
  });

  it('is absent when none is configured - setup is open, and says so', () => {
    // No token is ever GENERATED. The distinction matters: a generated token
    // would mean "locked, and the operator must go and find it", which is
    // exactly the friction first-run should not have. Null means open.
    const dataDir = path.join(tmp, 'open-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const warnings: string[] = [];
    const handle = ensureSetupToken({ dataDir, setupToken: undefined }, freshDb(), {
      info: () => {},
      warn: (m) => warnings.push(m),
    });
    expect(handle).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'setup-token'))).toBe(false);
    // Open is a thing an operator should learn from the log, not discover.
    expect(warnings.join('\n')).toMatch(/OPEN/);
    expect(warnings.join('\n')).toMatch(/RP_SETUP_TOKEN/);
  });

  it('removes a token file left by an older version', () => {
    // Pre-0.11 wrote a generated token here. Leaving it would have someone
    // typing a token this server has never heard of.
    const dataDir = path.join(tmp, 'legacy-data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'setup-token'), 'a-token-from-an-older-version');
    expect(ensureSetupToken({ dataDir, setupToken: undefined }, freshDb(), silentLog)).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'setup-token'))).toBe(false);
  });

  it('consume() disables a configured token', () => {
    const dataDir = path.join(tmp, 'consume-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const handle = ensureSetupToken(
      { dataDir, setupToken: 'operator-chosen-token' },
      freshDb(),
      silentLog,
    )!;
    expect(handle.matches('operator-chosen-token')).toBe(true);
    handle.consume();
    expect(handle.matches('operator-chosen-token')).toBe(false);
  });

  it('returns null (and cleans up) once users exist', () => {
    const dataDir = path.join(tmp, 'done-data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'setup-token'), 'leftover-token');
    const db = freshDb();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','a','h','admin',?)`,
    ).run(nowIso());
    expect(ensureSetupToken({ dataDir, setupToken: undefined }, db, silentLog)).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'setup-token'))).toBe(false);
  });
});

describe('async passwords', () => {
  it('hash/verify round-trips; wrong password fails', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('dummy verification (unknown-user path) completes and burns real scrypt work', async () => {
    const t0 = performance.now();
    await verifyAgainstDummy('any password');
    // scrypt N=32768 cannot complete instantaneously; this guards against
    // the dummy path being optimized into a no-op (timing oracle).
    expect(performance.now() - t0).toBeGreaterThan(2);
  });
});

describe('LoginThrottle (durable)', () => {
  it('limits per key, resets, and persists across instances sharing the DB', () => {
    const db = freshDb();
    const throttle = new LoginThrottle(db, 3, 60_000);
    expect(throttle.allow('acct:alice')).toBe(true);
    expect(throttle.allow('acct:alice')).toBe(true);
    expect(throttle.allow('acct:alice')).toBe(true);
    expect(throttle.allow('acct:alice')).toBe(false);
    // A different key is unaffected.
    expect(throttle.allow('acct:bob')).toBe(true);
    // A new instance (process restart) sees the same counters.
    const restarted = new LoginThrottle(db, 3, 60_000);
    expect(restarted.allow('acct:alice')).toBe(false);
    // Successful login clears the account counter.
    restarted.reset('acct:alice');
    expect(restarted.allow('acct:alice')).toBe(true);
  });

  it('window expiry re-admits', () => {
    const db = freshDb();
    const throttle = new LoginThrottle(db, 1, 60_000);
    expect(throttle.allow('k')).toBe(true);
    expect(throttle.allow('k')).toBe(false);
    db.prepare('UPDATE login_throttle SET reset_at = ? WHERE key = ?').run(Date.now() - 1, 'k');
    expect(throttle.allow('k')).toBe(true);
  });
});

describe('the setup gate', () => {
  /**
   * Locked-ness is read from the configuration, never from whether the token
   * handle is still alive. The two states a null handle can mean - "none was
   * configured" and "it has been consumed" - are opposites, and conflating
   * them would make anything that drops the handle silently unlock a server
   * whose owner asked for a lock.
   */
  const ctxWith = (setupToken: string | undefined, handle: unknown, db: DB) =>
    ({ db, config: { setupToken }, setupToken: handle }) as unknown as Parameters<
      typeof setupIsLocked
    >[0];

  it('calls an instance locked when RP_SETUP_TOKEN is set, whatever the handle is doing', () => {
    const db = freshDb();
    expect(setupIsLocked(ctxWith('a-token', null, db))).toBe(true);
    expect(setupIsLocked(ctxWith(undefined, null, db))).toBe(false);
  });

  it('fails closed when a locked instance has lost its handle', () => {
    const db = freshDb();
    // Not "open": nothing is accepted, including the right token.
    const orphaned = ctxWith('a-token', null, db);
    expect(setupTokenAccepted(orphaned, 'a-token')).toBe(false);
    expect(setupTokenAccepted(orphaned, undefined)).toBe(false);
    expect(setupHelperAllowed(orphaned, { user: null, headers: {} })).toBe(false);
  });

  it('accepts anything on an unlocked instance, and nothing once an account exists', () => {
    const db = freshDb();
    const open = ctxWith(undefined, null, db);
    expect(setupTokenAccepted(open, undefined)).toBe(true);
    expect(setupHelperAllowed(open, { user: null, headers: {} })).toBe(true);
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','a','h','admin',?)`,
    ).run(nowIso());
    expect(setupHelperAllowed(open, { user: null, headers: {} })).toBe(false);
    // An admin session still gets in; a reader never does.
    expect(setupHelperAllowed(open, { user: { role: 'admin' }, headers: {} })).toBe(true);
    expect(setupHelperAllowed(open, { user: { role: 'reader' }, headers: {} })).toBe(false);
  });
});
