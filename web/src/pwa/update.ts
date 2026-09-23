import { useEffect, useState } from 'react';
import { olderThan } from '../lib/version';

/**
 * Noticing that the server has moved on to a newer ReadPort than the one on
 * screen.
 *
 * An app added to a home screen is seldom reloaded: it is put away and
 * picked up again, for weeks on end, still running the version it started
 * with long after a newer one was deployed. The server says which version it
 * runs (/api/health). This asks it when the app opens, when the app comes
 * back to the front, and every so often while it stays there, and passes on
 * a version newer than this page's own.
 */

export const updateTiming = {
  /** The first question waits for the page's own requests to go first. */
  firstAskMs: 3_000,
  /** However often the app comes and goes, the server is asked no more often than this. */
  minGapMs: 5 * 60_000,
  /** And again, while the app stays on screen. */
  everyMs: 15 * 60_000,
};

let newer: string | null = null;
let askedAt = 0;
const listeners = new Set<(version: string) => void>();

/** A version newer than this page's, once the server has named one; null until then. */
export function newVersion(): string | null {
  return newer;
}

/** Hear about a newer version the moment the server names one. */
export function subscribeNewVersion(fn: (version: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Ask the server which version it runs, and keep it if it is newer than
 * `running`. Offline, or a server restarting into that newer version, is
 * no answer at all: the next question will get one.
 */
export async function askServer(running: string = __APP_VERSION__): Promise<string | null> {
  askedAt = Date.now();
  try {
    const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return newer;
    const body = (await res.json()) as { version?: unknown };
    const version = typeof body.version === 'string' ? body.version : null;
    if (version && version !== newer && olderThan(running, version)) {
      newer = version;
      for (const fn of listeners) fn(version);
    }
  } catch {
    /* asked again later */
  }
  return newer;
}

/** The newer version, while the component asking is on screen to show it. */
export function useNewVersion(): string | null {
  const [version, setVersion] = useState(newer);
  useEffect(() => {
    const off = subscribeNewVersion(setVersion);
    const maybeAsk = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - askedAt < updateTiming.minGapMs) return;
      void askServer();
    };
    const first = window.setTimeout(maybeAsk, updateTiming.firstAskMs);
    const every = window.setInterval(maybeAsk, updateTiming.everyMs);
    document.addEventListener('visibilitychange', maybeAsk);
    window.addEventListener('online', maybeAsk);
    return () => {
      off();
      window.clearTimeout(first);
      window.clearInterval(every);
      document.removeEventListener('visibilitychange', maybeAsk);
      window.removeEventListener('online', maybeAsk);
    };
  }, []);
  return version;
}

/**
 * Start using the newest version: reload the page, which fetches the new app
 * from the network. The service worker is asked to update first, so that
 * what it keeps for starting offline is the new version too - but not for
 * long, because the reload brings the new version either way.
 */
export async function refreshToLatest(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await Promise.race([reg.update(), new Promise((r) => setTimeout(r, 3_000))]);
  } catch {
    /* no worker, or it could not be fetched: the reload still loads the new version */
  }
  window.location.reload();
}
