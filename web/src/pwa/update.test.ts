import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answer to /api/health, or a failure to get one. */
let answer: () => Promise<Response>;
const health =
  (version: unknown, status = 200) =>
  () =>
    Promise.resolve(new Response(JSON.stringify({ status: 'ok', version }), { status }));

async function load() {
  vi.resetModules();
  return import('./update');
}

beforeEach(() => {
  answer = health('0.23.0');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => answer()),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('askServer', () => {
  it('passes on a version newer than the one running', async () => {
    const { askServer, newVersion, subscribeNewVersion } = await load();
    const heard: string[] = [];
    subscribeNewVersion((v) => heard.push(v));
    answer = health('0.24.0');
    expect(await askServer('0.23.0')).toBe('0.24.0');
    expect(newVersion()).toBe('0.24.0');
    expect(heard).toEqual(['0.24.0']);
  });

  it('compares versions as numbers, so 0.10.0 is newer than 0.9.7', async () => {
    const { askServer } = await load();
    answer = health('0.10.0');
    expect(await askServer('0.9.7')).toBe('0.10.0');
  });

  it('says nothing when the server runs the same version, or an older one', async () => {
    const { askServer, subscribeNewVersion } = await load();
    const heard: string[] = [];
    subscribeNewVersion((v) => heard.push(v));
    answer = health('0.23.0');
    expect(await askServer('0.23.0')).toBeNull();
    answer = health('0.22.1');
    expect(await askServer('0.23.0')).toBeNull();
    expect(heard).toEqual([]);
  });

  it('tells each listener about a version once, and again about a newer one', async () => {
    const { askServer, subscribeNewVersion } = await load();
    const heard: string[] = [];
    subscribeNewVersion((v) => heard.push(v));
    answer = health('0.24.0');
    await askServer('0.23.0');
    await askServer('0.23.0');
    answer = health('0.25.0');
    await askServer('0.23.0');
    expect(heard).toEqual(['0.24.0', '0.25.0']);
  });

  it('keeps what it knew when the server cannot be reached, or answers oddly', async () => {
    const { askServer } = await load();
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await askServer('0.23.0')).toBeNull();
    answer = health('0.24.0');
    await askServer('0.23.0');
    answer = health('0.25.0', 502);
    expect(await askServer('0.23.0')).toBe('0.24.0');
    answer = health(undefined);
    expect(await askServer('0.23.0')).toBe('0.24.0');
  });

  it('never reads the answer from a cache', async () => {
    const { askServer } = await load();
    await askServer('0.23.0');
    expect(fetch).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });
});
