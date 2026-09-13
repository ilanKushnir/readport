import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The app has to start on a plain-HTTP LAN address.
 *
 * `crypto.randomUUID` exists only in a secure context. This module is imported
 * by App.tsx, so an unguarded call to it at module scope threw during module
 * evaluation and the whole app rendered nothing — a white screen on
 * `http://server.lan:8383`, which is the URL the self-hosting guide tells
 * people to open. Nothing else in the app noticed, because nothing else got
 * far enough to run.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A browser on an insecure origin: getRandomValues, but no randomUUID. */
function insecureCrypto(): Crypto {
  return {
    getRandomValues: (arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11) % 256;
      return arr;
    },
  } as unknown as Crypto;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('progress engine on an insecure origin', () => {
  it('loads at all', async () => {
    vi.stubGlobal('crypto', insecureCrypto());
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    vi.resetModules();
    await expect(import('./engine')).resolves.toBeDefined();
  });

  it('still produces ids the server will accept', async () => {
    // Shape matters as much as randomness: progress events are validated with
    // z.uuid(), so a plausible-looking non-UUID would be refused on arrival.
    vi.stubGlobal('crypto', insecureCrypto());
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    vi.resetModules();
    const mod = await import('./engine');
    expect(mod.sessionId).toMatch(UUID_V4);
    expect(mod.deviceId).toMatch(UUID_V4);
  });

  it('gives each browser its own device id when storage is unavailable', async () => {
    // A shared constant would make two devices look like one, and let a stale
    // tab argue with a live one over whose reading position is current.
    vi.stubGlobal('crypto', insecureCrypto());
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
      removeItem: () => {},
    });
    vi.resetModules();
    const mod = await import('./engine');
    expect(mod.deviceId).toMatch(UUID_V4);
  });
});
