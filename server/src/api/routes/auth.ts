import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loginSchema, setupSchema, testPathsSchema, LANGUAGES } from '@readport/shared';
import { type AppContext } from '../../context.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../../auth/passwords.js';
import { createSession, destroySession, LoginThrottle } from '../../auth/sessions.js';
import { newId } from '../../util/ids.js';
import { nowIso } from '../../db/index.js';
import { SESSION_COOKIE } from '../guards.js';
import { sessionCookieOpts } from '../../auth/cookie.js';
import { enqueueJob } from '../../jobs/queue.js';
import { alignmentRoots, libraryRoots, saveSettings } from '../../domain/settings.js';
import { browseDirectories, checkLibraryPath } from '../../setup/paths.js';
import { mayExport } from '../../auth/roles.js';
import { setupHelperAllowed, setupIsLocked, setupTokenAccepted } from '../../auth/setupGate.js';
import { hasUsablePassword } from '../../auth/proxyAuth.js';

const ATTEMPT_LIMIT = 10;
const IP_ATTEMPT_LIMIT = 30;
const WINDOW_MS = 5 * 60_000;

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;
  const accountThrottle = new LoginThrottle(db, ATTEMPT_LIMIT, WINDOW_MS);
  const ipThrottle = new LoginThrottle(db, IP_ATTEMPT_LIMIT, WINDOW_MS);

  const cookieOpts = () => sessionCookieOpts(config);

  const userCount = () => (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;

  app.get('/api/setup/status', { config: { public: true } }, async () => {
    const needsSetup = userCount() === 0;
    const roots = libraryRoots(db, config);
    return {
      needsSetup,
      // Whether the wizard must ask for RP_SETUP_TOKEN. Normally false - the
      // owner just creates their account. Saying so is safe: it reveals only
      // that a lock exists, never the token, which is never sent over HTTP.
      setupTokenRequired: needsSetup && setupIsLocked(ctx),
      // What the wizard can and cannot change (env-pinned roots are shown, not edited).
      libraries: needsSetup
        ? {
            ebookDirs: roots.ebookDirs,
            audiobookDirs: roots.audiobookDirs,
            alignmentDirs: alignmentRoots(db, config),
            envPinned: {
              ebookDirs: config.envPinned.includes('ebookDirs'),
              audiobookDirs: config.envPinned.includes('audiobookDirs'),
              alignmentDirs: config.envPinned.includes('alignmentDirs'),
              // The wizard already renders a disabled language step and the
              // RP_DEFAULT_LANGUAGE note, but the pin was never reported - so
              // on every compose first run that sets it, the operator picked a
              // language and the choice was silently discarded.
              defaultLanguage: config.envPinned.includes('defaultLanguage'),
            },
          }
        : null,
      languages: needsSetup ? LANGUAGES.map((l) => ({ code: l.code, label: l.label })) : null,
      defaultLanguage: needsSetup ? config.defaultLanguage : null,
    };
  });

  /** Wizard helpers: see auth/setupGate.ts. Nothing here writes to disk. */
  const helperAllowed = (req: {
    user: { role: string } | null;
    headers: Record<string, unknown>;
  }) => setupHelperAllowed(ctx, req);

  app.post('/api/setup/verify', { config: { public: true } }, async (req, reply) => {
    if (userCount() > 0) return reply.code(409).send({ error: 'already-configured' });
    // Nothing to verify on an unlocked instance; the wizard does not call it.
    if (!setupIsLocked(ctx)) return { ok: true };
    if (!ipThrottle.allow(`setup:${req.clientIp}`))
      return reply.code(429).send({ error: 'rate-limited' });
    const body = z.object({ setupToken: z.string().min(1).max(512) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    if (!setupTokenAccepted(ctx, body.data.setupToken)) {
      return reply.code(403).send({ error: 'bad-setup-token' });
    }
    return { ok: true };
  });

  app.post('/api/setup/test-paths', { config: { public: true } }, async (req, reply) => {
    if (!helperAllowed(req)) return reply.code(403).send({ error: 'forbidden' });
    const body = testPathsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    return { results: body.data.paths.map((p) => checkLibraryPath(p, body.data.kind)) };
  });

  app.get('/api/setup/browse', { config: { public: true } }, async (req, reply) => {
    if (!helperAllowed(req)) return reply.code(403).send({ error: 'forbidden' });
    const q = req.query as { path?: string };
    const p = typeof q.path === 'string' && q.path.length <= 1024 ? q.path : undefined;
    return browseDirectories(p || undefined);
  });

  // First-run admin creation. Open until an admin exists, then closed for
  // good; RP_SETUP_TOKEN locks the window shut (see auth/setupToken.ts). No
  // default credentials exist either way.
  app.post('/api/setup', { config: { public: true } }, async (req, reply) => {
    if (userCount() > 0) return reply.code(409).send({ error: 'already-configured' });
    if (!ipThrottle.allow(`setup:${req.clientIp}`)) {
      return reply.code(429).send({ error: 'rate-limited' });
    }
    const body = setupSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid', detail: body.error.issues[0]?.message });
    }
    // `setupToken` is optional in the schema, so an unlocked instance accepts
    // a request without one. A locked instance refuses one that omits it, and
    // refuses it even if the token handle has somehow gone: locked-ness is a
    // property of the config, so the failure direction is closed.
    if (!setupTokenAccepted(ctx, body.data.setupToken)) {
      return reply.code(403).send({ error: 'bad-setup-token' });
    }
    const passwordHash = await hashPassword(body.data.password);
    const id = newId('user');
    // Transactional create: two racing setup calls cannot both succeed.
    db.exec('BEGIN IMMEDIATE');
    try {
      const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
      if (count > 0) {
        db.exec('ROLLBACK');
        return reply.code(409).send({ error: 'already-configured' });
      }
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, display_name, status, created_at, last_login_at)
         VALUES (?, ?, ?, 'admin', ?, 'active', ?, ?)`,
      ).run(
        id,
        body.data.username,
        passwordHash,
        body.data.displayName ?? null,
        nowIso(),
        nowIso(),
      );
      // Library roots and language chosen in the wizard (env pins win).
      const patch: Record<string, unknown> = {};
      if (body.data.ebookDirs && !config.envPinned.includes('ebookDirs')) {
        patch.ebookDirs = body.data.ebookDirs;
      }
      if (body.data.audiobookDirs && !config.envPinned.includes('audiobookDirs')) {
        patch.audiobookDirs = body.data.audiobookDirs;
      }
      if (body.data.defaultLanguage && !config.envPinned.includes('defaultLanguage')) {
        patch.defaultLanguage = body.data.defaultLanguage;
      }
      // The admin creating the account is also the person who knows the
      // address their friends will use.
      if (body.data.publicUrl !== undefined) patch.publicUrl = body.data.publicUrl;
      if (body.data.autoAlign !== undefined) patch.autoAlign = body.data.autoAlign;
      if (body.data.importSavedAlignments !== undefined) {
        patch.importSavedAlignments = body.data.importSavedAlignments;
      }
      if (body.data.alignmentDirs) patch.alignmentDirs = body.data.alignmentDirs;
      if (Object.keys(patch).length) saveSettings(db, patch);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    // Setup is over for good: an admin exists, so userCount() closes the
    // route from here on. Consuming the token as well is belt and braces for
    // the locked case, and a no-op when there was none.
    ctx.setupToken?.consume();
    ctx.setupToken = null;
    const session = createSession(
      db,
      config.sessionSecret,
      id,
      config.sessionDays,
      req.headers['user-agent'],
    );
    reply.setCookie(SESSION_COOKIE, session.token, cookieOpts());
    // Kick off the first library scan right away (if there is anything to scan).
    const roots = libraryRoots(db, config);
    const scanJobId =
      roots.ebookDirs.length || roots.audiobookDirs.length
        ? enqueueJob(db, 'scan', {}, { dedupeKey: 'scan' })
        : null;
    return {
      user: {
        id,
        username: body.data.username,
        role: 'admin',
        displayName: body.data.displayName ?? null,
      },
      scanJobId,
    };
  });

  app.post('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    const body = loginSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    // Throttle by (account, client IP) AND by client IP alone. req.ip only
    // reflects forwarded headers when RP_TRUST_PROXY explicitly trusts the
    // proxy, so a direct attacker cannot rotate X-Forwarded-For past the
    // limits - and a remote attacker cannot lock the real owner out of a
    // known username by burning its attempts from elsewhere.
    const acctKey = `acct:${body.data.username.toLowerCase()}@${req.clientIp}`;
    const ipKey = `ip:${req.clientIp}`;
    if (!accountThrottle.allow(acctKey) || !ipThrottle.allow(ipKey)) {
      return reply.code(429).send({ error: 'rate-limited' });
    }
    const row = db
      .prepare(
        'SELECT id, username, password_hash, role, display_name, status FROM users WHERE lower(username) = lower(?)',
      )
      .get(body.data.username) as
      | {
          id: string;
          username: string;
          password_hash: string;
          role: string;
          display_name: string | null;
          status: string;
        }
      | undefined;
    // Constant-shape response AND constant work: unknown users verify against
    // a dummy hash so timing does not reveal account existence.
    if (!row) {
      await verifyAgainstDummy(body.data.password);
      return reply.code(401).send({ error: 'bad-credentials' });
    }
    if (!(await verifyPassword(body.data.password, row.password_hash))) {
      return reply.code(401).send({ error: 'bad-credentials' });
    }
    if (row.status !== 'active') return reply.code(403).send({ error: 'account-disabled' });
    accountThrottle.reset(acctKey);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
    const session = createSession(
      db,
      config.sessionSecret,
      row.id,
      config.sessionDays,
      req.headers['user-agent'],
    );
    reply.setCookie(SESSION_COOKIE, session.token, cookieOpts());
    return {
      user: { id: row.id, username: row.username, role: row.role, displayName: row.display_name },
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = (req.cookies ?? {})[SESSION_COOKIE];
    if (token) destroySession(db, config.sessionSecret, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    const roots = libraryRoots(db, config);
    return {
      // Read fresh rather than carried in the session, so revoking the
      // capability takes effect on the next page load rather than in a month.
      user: { ...req.user, canExport: mayExport(db, req.user) },
      via: req.authVia ?? 'session',
      // Whether this account can sign in WITHOUT the proxy. Not the same
      // question as `via`: someone can arrive through their identity
      // provider on an account that also has a password, and someone
      // provisioned by the proxy has none until they set one.
      hasPassword: hasUsablePassword(db, req.user.id),
      // An admin who has not pointed the server at any library yet still has
      // setup to finish. This is the normal path behind reverse-proxy SSO,
      // where the first user is provisioned automatically and never sees the
      // first-run screen: the wizard resumes at the Libraries step.
      needsLibraries:
        req.user.role === 'admin' &&
        roots.ebookDirs.length === 0 &&
        roots.audiobookDirs.length === 0,
      librariesEnvPinned:
        config.envPinned.includes('ebookDirs') || config.envPinned.includes('audiobookDirs'),
    };
  });
}
