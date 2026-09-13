import { type EnvConfig } from '../config.js';

/** Name of the session cookie, and the only place its options are decided. */
export const SESSION_COOKIE = 'rp_session';

/**
 * How the session cookie is written.
 *
 * One definition, used by sign-in, by accepting an invitation, and by the
 * request hook that slides a live session forward - three places that must
 * agree about `secure` and `maxAge` or a session survives on the server while
 * the browser quietly drops it.
 */
export function sessionCookieOpts(config: EnvConfig) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.trustHttps,
    maxAge: config.sessionDays * 86400,
  };
}
