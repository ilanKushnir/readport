import { type AppContext } from '../context.js';
import { hasRole } from './roles.js';

/**
 * Who may drive first-run setup, in one place.
 *
 * This used to be written twice - once in routes/auth.ts for the wizard and
 * its folder helpers, once in routes/preflight.ts for the server self-check -
 * under a comment claiming they were "the same gate". Making the token
 * optional changed one copy and not the other, and the self-check went dead
 * on every default install without a single test noticing. So it is one
 * function now, and the comment is true because there is nothing left to
 * disagree with.
 */

const userCount = (ctx: AppContext): number =>
  (ctx.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;

/**
 * Whether this server demands a token to be set up at all.
 *
 * Read from the CONFIGURATION, deliberately, and never from whether the live
 * handle happens to be non-null. A null handle means two different things -
 * "no token was configured" and "the token has been consumed" - and if
 * locked-ness were inferred from it, anything that nulled the handle while
 * the users table was empty would silently turn a locked instance into an
 * open one. Asking the config cannot fail that way: an instance that set
 * RP_SETUP_TOKEN stays locked even if the handle is gone, in which case
 * nothing matches and it fails closed.
 */
export function setupIsLocked(ctx: AppContext): boolean {
  return !!ctx.config.setupToken;
}

/** Whether a presented token satisfies the lock (trivially true if unlocked). */
export function setupTokenAccepted(ctx: AppContext, presented: string | undefined): boolean {
  if (!setupIsLocked(ctx)) return true;
  return !!presented && !!ctx.setupToken && ctx.setupToken.matches(presented);
}

/**
 * Whether this request may use a wizard helper - the folder checks, the
 * folder browser, the preflight report.
 *
 * Afterwards: an admin session. Before an admin exists: whatever the wizard
 * itself answers to, because a helper that is stricter than the thing it
 * helps is just a broken wizard, and one that is looser would be a hole.
 */
export function setupHelperAllowed(
  ctx: AppContext,
  req: { user: { role: string } | null; headers: Record<string, unknown> },
): boolean {
  if (req.user) return hasRole(req.user.role, 'admin');
  if (userCount(ctx) > 0) return false;
  if (!setupIsLocked(ctx)) return true;
  const raw = req.headers['x-rp-setup-token'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  return typeof token === 'string' && setupTokenAccepted(ctx, token);
}
