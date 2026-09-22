import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { type AppContext } from '../context.js';
import { buildClientIp, isPrivateAddress } from './clientIp.js';
import { buildSourceList } from '../auth/proxyAuth.js';
import { apiKeyAllows, attachUser, csrfCheck, requireUser } from './guards.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerPrefsRoutes } from './routes/prefs.js';
import { registerReaderRoutes } from './routes/reader.js';
import { registerAudioRoutes } from './routes/audio.js';
import { registerProgressRoutes } from './routes/progress.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerFriendRoutes } from './routes/friends.js';
import { registerAnnotationRoutes } from './routes/annotations.js';
import { registerShelfRoutes } from './routes/shelves.js';
import { registerPairRoutes } from './routes/pairs.js';
import { registerJobRoutes, registerOfflineRoutes, registerSettingsRoutes } from './routes/misc.js';
import { registerModelRoutes } from './routes/models.js';
import { registerPreflightRoutes } from './routes/preflight.js';
import { registerUserRoutes } from './routes/users.js';
import { registerKeyRoutes } from './routes/keys.js';
import {
  registerAgentRoutes,
  agentRetryAfterSeconds,
  allowAgentRead,
  allowAgentRejection,
} from './routes/agent.js';
import { agentRoute, AGENT_BASE, AGENT_RESPONSE_BYTES } from './agent-contract.js';
import { APP_VERSION } from '../util/version.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Route is reachable without a session (still CSRF-checked). */
    public?: boolean;
  }
}

/**
 * Decoded request path. The router matches on the DECODED path, so a guard
 * keyed on the raw `req.url` would let `/%61pi/...` reach `/api/...` routes
 * unauthenticated. Returns null for malformed encodings.
 */
export function decodedPathname(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url, 'http://readport.invalid').pathname);
  } catch {
    return null;
  }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
  "worker-src 'self'",
].join('; ');

export interface BuildAppOptions {
  /** Absolute path of the built web app (index.html etc). Optional in tests. */
  webDist?: string;
}

export function buildApp(ctx: AppContext, opts: BuildAppOptions = {}): FastifyInstance {
  // Per instance, not per module: a module-level flag makes one test's
  // warning suppress another's.
  let warnedProxy = false;
  const clientIp = buildClientIp(ctx.config, buildSourceList(ctx.config.clientIpSources), ctx.log);

  const app = Fastify({
    logger: {
      level: ctx.config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      // The request line without its query string. A search term, a library
      // query, an agent's `?query=` - what someone looked for is theirs, and
      // the audit line already says which route answered and how.
      serializers: {
        req(req: { id?: unknown; method?: string; url?: string; ip?: string }) {
          return {
            id: req.id,
            method: req.method,
            url: (req.url ?? '').split('?')[0],
            remoteAddress: req.ip,
          };
        },
      },
    },
    bodyLimit: 2 * 1024 * 1024,
    // Default false: forwarded headers are ignored so clients cannot spoof
    // their IP (rate-limit keys). Operators behind a reverse proxy opt in
    // with RP_TRUST_PROXY (see config.ts).
    trustProxy: ctx.config.trustProxy,
  });

  app.register(fastifyCookie);
  // Every response went out uncompressed, including the library listing and
  // the JS bundle. The threshold keeps it off the small stuff, where the CPU
  // costs more than the bytes saved; audio and images are already compressed
  // and the plugin skips them by content type.
  app.register(fastifyCompress, { global: true, encodings: ['br', 'gzip'], threshold: 1024 });

  // Body-less mutations (confirm/unlink/align/…) may arrive through proxies
  // that add a content type; an unknown type with an EMPTY body is harmless
  // and must not be a 415. Non-empty bodies of unknown types stay rejected.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
    if ((body as Buffer).length === 0) return done(null, undefined);
    const err = new Error('Unsupported Media Type') as Error & { statusCode?: number };
    err.statusCode = 415;
    done(err, undefined);
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    if (!(decodedPathname(req.url) ?? '').startsWith('/api/books/')) {
      // Book chapter fragments/assets carry their own stricter handling.
      reply.header('content-security-policy', CSP);
    }
    // An API answer is one person's data, and it used to go out with no cache
    // directive at all - which leaves it to a shared cache's heuristics. The
    // audience for this server is someone putting a reverse proxy in front of
    // it, and "cache everything" is one rule away in every CDN dashboard: a
    // cached /api/auth/me or /api/annotations is one reader's account handed
    // to the next. Set the safe default here and let the routes that really
    // do serve cacheable content - covers, chapters, assets, tracks - replace
    // it with their own `private, max-age=…` afterwards. Offline downloads
    // are unaffected: the service worker stores them through the Cache
    // Storage API, which does not consult HTTP cache directives.
    if ((decodedPathname(req.url) ?? '').startsWith('/api/')) {
      reply.header('cache-control', 'private, no-store');
    }
    // Who this request counts as, for rate limiting only.
    req.clientIp = clientIp(req);
    // Said once, at the moment it is demonstrably wrong: a forwarded header
    // arrived and the address we ended up counting is still a private one,
    // so a hop in the chain is not trusted and every client outside it
    // shares a single bucket. That covers RP_TRUST_PROXY being unset AND the
    // subtler case of it naming the proxy but not the tunnel in front of it,
    // which looks correct and is not.
    if (!warnedProxy && req.headers['x-forwarded-for'] && isPrivateAddress(req.clientIp)) {
      warnedProxy = true;
      ctx.log.warn(
        `Requests carry X-Forwarded-For but rate limits are counting ${req.clientIp}, a private ` +
          'address - so every client outside it shares one bucket and a stranger can lock the ' +
          'owner out of their own sign-in. Name every hop in RP_TRUST_PROXY, or set ' +
          'RP_CLIENT_IP_HEADER (+ RP_CLIENT_IP_SOURCES) behind a tunnel.',
      );
    }
    const hasAuthorization = req.headers.authorization !== undefined;
    const rawHeaders = req.raw.rawHeaders;
    const authHeaderCount = rawHeaders.filter(
      (h, i) => i % 2 === 0 && h.toLowerCase() === 'authorization',
    ).length;
    if (hasAuthorization || (decodedPathname(req.url) ?? '').startsWith(AGENT_BASE)) {
      reply.header('cache-control', 'no-store');
    }
    if (authHeaderCount > 1) return reply.code(401).send({ error: 'unauthorized' });
    // A refusal, metered by address before it is answered: the answer stays
    // 401 or 403 - never an identity - until an address has earned a 429.
    const refuse = (status: 401 | 403, body: Record<string, string>) =>
      allowAgentRejection(ctx.db, req.clientIp ?? req.ip)
        ? reply.code(status).send(body)
        : reply.header('retry-after', '60').code(429).send({ error: 'rate-limited' });
    attachUser(ctx, req, reply);
    // Authorization takes precedence over cookies, proxy SSO, public routes,
    // static assets and the not-found handler. Never downgrade bad credentials.
    if (hasAuthorization && req.authVia !== 'apikey') {
      return refuse(401, { error: 'unauthorized' });
    }
    if (req.authVia === 'apikey') {
      // Use the unnormalized origin-form path. URL() normalizes dot segments;
      // decoding permits aliases. Neither is appropriate for a closed grant.
      const rawPath = req.url.split('?')[0]!;
      if (
        !apiKeyAllows(req.method, rawPath, req.agentScopes) ||
        agentRoute(rawPath) !== req.routeOptions.url
      ) {
        return refuse(403, {
          error: 'read-only',
          detail: 'This API key may only read the agent API',
        });
      }
      if (!allowAgentRead(ctx.db, req.user!.id)) {
        return reply
          .header('retry-after', String(agentRetryAfterSeconds(ctx.db, req.user!.id)))
          .code(429)
          .send({ error: 'rate-limited' });
      }
      if (
        req.url.length > 2048 ||
        req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
      ) {
        return reply.code(400).send({ error: 'bad-request' });
      }
    }
    const pathname = decodedPathname(req.url);
    if (pathname === null) return reply.code(400).send({ error: 'bad-url' });
    // Gate on BOTH the matched route pattern and the decoded path, so an
    // encoded prefix can neither reach a route nor dodge the check.
    const routeUrl = req.routeOptions?.url ?? '';
    const isApi = routeUrl.startsWith('/api/') || pathname.startsWith('/api/');
    if (!isApi) return;
    if (!csrfCheck(req)) return reply.code(403).send({ error: 'csrf' });
    if (req.routeOptions?.config?.public === true) return;
    if (!requireUser(req, reply)) return reply;
  });

  app.addHook('preSerialization', async (req, reply, payload) => {
    if (
      (req.routeOptions.url ?? '').startsWith(AGENT_BASE) &&
      Buffer.byteLength(JSON.stringify(payload)) > AGENT_RESPONSE_BYTES
    ) {
      reply.code(413);
      return { error: 'response-too-large', detail: 'Request a smaller page' };
    }
    return payload;
  });
  app.addHook('onResponse', async (req, reply) => {
    if (req.headers.authorization !== undefined) {
      // Only catalog route templates and verified identities, not URLs,
      // query strings, request bodies, credentials or book content.
      ctx.log.info(
        JSON.stringify({
          event: 'agent-api',
          keyId: req.apiKeyId ?? null,
          userId: req.authVia === 'apikey' ? req.user?.id : null,
          route: agentRoute(req.url.split('?')[0]!) ?? 'forbidden',
          method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)
            ? req.method
            : 'OTHER',
          outcome:
            reply.statusCode < 400
              ? 'success'
              : reply.statusCode === 401
                ? 'unauthorized'
                : reply.statusCode === 403
                  ? 'forbidden'
                  : reply.statusCode === 404
                    ? 'not-found'
                    : reply.statusCode === 429
                      ? 'rate-limited'
                      : reply.statusCode === 413
                        ? 'too-large'
                        : reply.statusCode < 500
                          ? 'bad-request'
                          : 'server-error',
          status: reply.statusCode,
        }),
      );
    }
  });

  // Never leak internal error messages (paths, SQL, stack fragments).
  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err as { statusCode?: number; code?: string };
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled route error');
      return reply.code(500).send({ error: 'internal' });
    }
    return reply.code(status).send({ error: typeof e.code === 'string' ? e.code : 'error' });
  });

  app.get('/api/health', { config: { public: true } }, async () => ({
    status: 'ok',
    version: APP_VERSION,
    time: new Date().toISOString(),
  }));

  registerAuthRoutes(app, ctx);
  registerLibraryRoutes(app, ctx);
  registerPrefsRoutes(app, ctx);
  registerReaderRoutes(app, ctx);
  registerAudioRoutes(app, ctx);
  registerProgressRoutes(app, ctx);
  // What the progress pipeline wrote down, read back as a reader's own stats.
  registerStatsRoutes(app, ctx);
  // Friends sit here too: who may see this reader's place in a book is the
  // reader's own to give, like a shelf.
  registerFriendRoutes(app, ctx);
  registerAnnotationRoutes(app, ctx);
  // Personal-data neighbourhood: shelves belong next to the other things a
  // reader owns rather than beside the library-wide routes.
  registerShelfRoutes(app, ctx);
  registerPairRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerKeyRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerOfflineRoutes(app, ctx);
  registerModelRoutes(app, ctx);
  registerPreflightRoutes(app, ctx);
  registerUserRoutes(app, ctx);

  // Static web app + SPA fallback (everything not under /api).
  if (opts.webDist && fs.existsSync(path.join(opts.webDist, 'index.html'))) {
    app.register(fastifyStatic, {
      root: opts.webDist,
      wildcard: false,
      index: ['index.html'],
      setHeaders: (reply, filePath) => {
        if (/\.(js|css|woff2|png|svg)$/.test(filePath) && /-[A-Za-z0-9_-]{8}\./.test(filePath)) {
          reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else {
          reply.header('cache-control', 'no-cache');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if ((decodedPathname(req.url) ?? '/api/').startsWith('/api/')) {
        return reply.code(404).send({ error: 'not-found' });
      }
      reply.header('content-security-policy', CSP);
      reply.header('cache-control', 'no-cache');
      return reply.type('text/html').send(fs.readFileSync(path.join(opts.webDist!, 'index.html')));
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if ((decodedPathname(req.url) ?? '/api/').startsWith('/api/')) {
        return reply.code(404).send({ error: 'not-found' });
      }
      return reply
        .code(503)
        .type('text/plain')
        .send('ReadPort web assets are not built. Run: npm run build');
    });
  }

  return app;
}
