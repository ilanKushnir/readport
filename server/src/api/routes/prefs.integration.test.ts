import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';

/**
 * Reading settings, as two devices change them: each change is applied on
 * its own, so neither device can hand back an older copy of the other's.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-prefs-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: path.join(tmp, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    sessionSecret: 'prefs-test-secret-0123456789abcdef',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});
const headers = (user: string) => ({ 'x-rp-test-user': user, 'x-rp-csrf': '1' });
const send = (user: string, method: 'GET' | 'PUT' | 'PATCH', payload?: unknown) =>
  app.inject({
    method,
    url: '/api/prefs/reader',
    payload: payload as never,
    remoteAddress: '10.0.0.5',
    headers: headers(user),
  });

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a reading setting changed on one device', () => {
  it('starts the document, and reads back as it was sent', async () => {
    const res = await send('dana', 'PATCH', {
      shared: { voiceMark: 'wash' },
      byDevice: { phone: { size: 18 } },
      updatedAt: '2026-09-01T08:00:00.000Z',
    });
    expect(res.statusCode).toBe(200);
    expect((await send('dana', 'GET')).json().reader).toEqual({
      shared: { voiceMark: 'wash' },
      byDevice: { phone: { size: 18 } },
      updatedAt: '2026-09-01T08:00:00.000Z',
    });
  });

  it('leaves what another device chose where it was', async () => {
    const res = await send('dana', 'PATCH', {
      shared: { theme: 'sepia' },
      byDevice: { tablet: { margin: 'wide' } },
      updatedAt: '2026-09-01T09:00:00.000Z',
    });
    expect(res.json().reader).toEqual({
      shared: { voiceMark: 'wash', theme: 'sepia' },
      byDevice: { phone: { size: 18 }, tablet: { margin: 'wide' } },
      updatedAt: '2026-09-01T09:00:00.000Z',
    });
  });

  it('is removed when put back to its default', async () => {
    const res = await send('dana', 'PATCH', {
      shared: { voiceMark: 'margin' },
      byDevice: {},
      updatedAt: '2026-09-01T10:00:00.000Z',
    });
    expect(res.json().reader.shared).toEqual({ theme: 'sepia' });
  });

  it('is refused when it is not a setting this server knows how to keep', async () => {
    const base = { shared: {}, byDevice: {}, updatedAt: '2026-09-01T11:00:00.000Z' };
    expect(
      (await send('dana', 'PATCH', { ...base, byDevice: { phone: { size: 99 } } })).statusCode,
    ).toBe(400);
    expect((await send('dana', 'PATCH', { ...base, shared: { washOpacity: 2 } })).statusCode).toBe(
      400,
    );
    expect((await send('dana', 'PATCH', { shared: {} })).statusCode).toBe(400);
  });

  it('is one person’s own', async () => {
    expect((await send('astra', 'GET')).json().reader).toBeNull();
  });
});

describe('a whole document, from a client before patches', () => {
  it('is stored without settings filed in the wrong bucket', async () => {
    const res = await send('astra', 'PUT', {
      shared: { voiceMark: 'wash', autoScroll: false },
      byDevice: { phone: { size: 20, voiceMark: 'margin' } },
      updatedAt: '2026-09-02T08:00:00.000Z',
    });
    expect(res.statusCode).toBe(200);
    expect((await send('astra', 'GET')).json().reader).toEqual({
      shared: { voiceMark: 'wash' },
      byDevice: { phone: { size: 20 } },
      updatedAt: '2026-09-02T08:00:00.000Z',
    });
  });
});
