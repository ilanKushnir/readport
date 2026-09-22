import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, isUnauthorized, setUnauthorizedHandler } from '../api/client';
import { purgeOfflineData } from '../offline/downloads';
import { idbClear, STORES } from '../progress/idb';
import {
  claimProgressQueue,
  flushPending,
  purgeProgressQueue,
  releaseProgressSession,
  resumeStoredProgressSession,
} from '../progress/engine';

export interface User {
  id: string;
  username: string;
  role: string;
  displayName?: string | null;
  /** May download the original file, not just read it in the app. */
  canExport?: boolean;
}

/** How the current session was established (reverse-proxy SSO vs. password). */
export type AuthVia = 'session' | 'proxy';

interface SessionCtx {
  user: User | null;
  via: AuthVia;
  /**
   * Whether this account can sign in without the proxy. Distinct from `via`:
   * an account provisioned by an identity provider has no password until its
   * owner sets one, and someone can arrive through the proxy on an account
   * that has had one all along.
   */
  hasPassword: boolean;
  /** Signed in as an admin, but no library folders configured yet. */
  needsLibraries: boolean;
  /** 'loading' | 'setup' | 'login' | 'ready' | 'offline' */
  phase: 'loading' | 'setup' | 'login' | 'ready' | 'offline';
  /** The interface language this account chose, or null to follow the browser. */
  locale: string | null;
  /** undefined until /api/auth/me answers; see whatsnew/changelog.ts. */
  whatsNewSeen: string | null | undefined;
  /** Friend requests waiting on you plus recommendations you have not seen. */
  friendsAttention: number;
  /** People who asked to join through a share link and await an admin; 0 unless one. */
  joinRequests: number;
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionCtx>({
  user: null,
  via: 'session',
  hasPassword: true,
  needsLibraries: false,
  phase: 'loading',
  locale: null,
  whatsNewSeen: undefined,
  friendsAttention: 0,
  joinRequests: 0,
  refresh: async () => {},
  setUser: () => {},
  logout: async () => {},
});
export const useSession = () => useContext(Ctx);

/**
 * A network that accepts the connection but never answers - captive portal,
 * half-up VPN, a wedged server - makes fetch hang instead of rejecting. The
 * session check must not hold the whole app on a loading spinner for it:
 * downloaded titles are on this device and readable without an answer. Only
 * this request is bounded; content requests must stay open long enough for
 * the service worker to fall back to the offline copy.
 */
const SESSION_CHECK_TIMEOUT_MS = 10_000;
const sessionCheckSignal = (): AbortSignal | undefined =>
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS)
    : undefined;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [via, setVia] = useState<AuthVia>('session');
  const [hasPassword, setHasPassword] = useState(true);
  const [needsLibraries, setNeedsLibraries] = useState(false);
  const [phase, setPhase] = useState<SessionCtx['phase']>('loading');
  const [locale, setLocale] = useState<string | null>(null);
  const [whatsNewSeen, setWhatsNewSeen] = useState<string | null | undefined>(undefined);
  const [friendsAttention, setFriendsAttention] = useState(0);
  const [joinRequests, setJoinRequests] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{
        user: User;
        via?: AuthVia;
        hasPassword?: boolean;
        needsLibraries?: boolean;
        locale?: string | null;
        whatsNewSeen?: string | null;
        friendRequests?: number;
        recommendations?: number;
        joinRequests?: number;
      }>('/api/auth/me', { signal: sessionCheckSignal() });
      // Before anything can be delivered: queued checkpoints belong to the
      // account that recorded them. The same person keeps a backlog written
      // while their session was expired; a different person starts empty.
      await claimProgressQueue(me.user.id).catch(() => {});
      setUser(me.user);
      setVia(me.via ?? 'session');
      // Default true: an older server does not send it, and offering to "add
      // a password" to an account that already has one is the worse mistake.
      setHasPassword(me.hasPassword !== false);
      setNeedsLibraries(me.needsLibraries === true);
      setLocale(me.locale ?? null);
      setWhatsNewSeen(me.whatsNewSeen ?? null);
      setFriendsAttention((me.friendRequests ?? 0) + (me.recommendations ?? 0));
      setJoinRequests(me.joinRequests ?? 0);
      setPhase('ready');
      return;
    } catch (err) {
      if (isUnauthorized(err)) {
        // Session expired or revoked: logout-as-revocation removes the
        // offline copies of server content this browser held for the
        // signed-out user (docs/security.md). Awaited - revocation fails
        // closed before the login screen appears. (The global unauthorized
        // handler has already purged once inside api(); this is idempotent
        // belt and braces for the /api/auth/me path.) Un-synced checkpoints
        // survive: they are the reader's own writes, and signing back in
        // delivers them.
        await purgeOfflineData().catch(() => {});
        // Delivery stops here: the queue stays for its owner, but this page
        // has nobody signed in to deliver it for, and the browser's cookie
        // may soon belong to someone else.
        releaseProgressSession();
        try {
          const s = await api<{ needsSetup: boolean }>('/api/setup/status');
          setUser(null);
          setPhase(s.needsSetup ? 'setup' : 'login');
        } catch {
          setPhase('login');
        }
        return;
      }
      // Network failure: allow offline reading of downloaded titles - and
      // record it. Delivery resumes for whoever this device last had signed
      // in (see resumeStoredProgressSession); without this the reader writes
      // nothing at all offline, which is the one case the durable queue is
      // for.
      resumeStoredProgressSession();
      setPhase('offline');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Fail-closed revocation, from either discovery path:
  //  - ANY API request answered 401 runs this handler (awaited inside the
  //    fetch wrapper) - downloads aborted, offline content purged - before
  //    the caller sees the error. It must never call api() (see the handler
  //    contract in api/client.ts), so no flush is attempted here; the queue
  //    is kept and delivered when this account signs in again.
  //  - The service worker's own online revocation check posts
  //    'rp-unauthorized' after purging the offline cache; the page then
  //    clears its IndexedDB state and drops to the login screen.
  useEffect(() => {
    const invalidate = async () => {
      await purgeOfflineData().catch(() => {});
      releaseProgressSession();
      setUser(null);
      setPhase('login');
    };
    const unset = setUnauthorizedHandler(invalidate);
    const onSwMessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string } | null;
      if (msg?.type === 'rp-unauthorized') void invalidate();
      // The service worker found this device's cached books belonged to a
      // different account and deleted them. Nothing is wrong, but the registry
      // still lists them as available offline, and a book that claims to be
      // downloaded and is not is worse than one that never claimed it.
      if (msg?.type === 'rp-offline-purged') void idbClear(STORES.downloads).catch(() => {});
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    return () => {
      unset();
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
    };
  }, []);

  const logout = useCallback(async () => {
    try {
      // Best-effort: deliver any queued progress before the session dies.
      await flushPending().catch(() => {});
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      // Logout removes this browser's offline book content and per-user
      // state; a fresh login re-downloads what is wanted (docs/security.md).
      // The queue goes too - but only here, after the flush above had its
      // chance, because signing out is a deliberate "leave nothing behind".
      await purgeOfflineData().catch(() => {});
      await purgeProgressQueue().catch(() => {});
      setUser(null);
      setPhase('login');
    }
  }, []);

  // Connectivity came back while the app was running in offline mode: pick
  // the session back up so the library, covers and sync resume on their own
  // instead of waiting for the reader to guess and reload. Coming back to
  // the tab counts too - a captive portal that has since been signed into
  // never fires an 'online' event.
  useEffect(() => {
    if (phase !== 'offline') return;
    const retry = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
    };
  }, [phase, refresh]);

  return (
    <Ctx.Provider
      value={{
        user,
        via,
        hasPassword,
        needsLibraries,
        phase,
        locale,
        whatsNewSeen,
        friendsAttention,
        joinRequests,
        refresh,
        logout,
        setUser: (u) => {
          setUser(u);
          if (u) {
            // Claim before any flusher can run: a backlog left by whoever
            // used this browser last must never be posted to this account.
            void claimProgressQueue(u.id);
            setPhase('ready');
            // Pick up server-side setup state (needsLibraries) that only
            // /api/auth/me reports - otherwise a fresh sign-in lands on an
            // empty library instead of the unfinished wizard.
            void refresh();
          }
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
