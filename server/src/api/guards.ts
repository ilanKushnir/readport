import { type BlockList } from 'node:net';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { type AppContext } from '../context.js';
import { resolveSession, type SessionUser } from '../auth/sessions.js';
import { buildSourceList, proxyAuthUser } from '../auth/proxyAuth.js';
import { bearerToken, resolveApiKey } from '../auth/apikeys.js';
import { AGENT_SCOPE, agentRoute } from './agent-contract.js';

export { SESSION_COOKIE, sessionCookieOpts } from '../auth/cookie.js';
import { SESSION_COOKIE, sessionCookieOpts } from '../auth/cookie.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    /** How the request was authenticated (undefined when anonymous). */
    authVia?: 'session' | 'proxy' | 'apikey';
    apiKeyId?: string;
    agentScopes?: readonly string[];
    /**
     * Who to count rate limits against - see api/clientIp.ts. Only ever a
     * throttle key: never an identity, never an authorization input.
     */
    clientIp: string;
  }
}

const sourceLists = new WeakMap<AppContext, BlockList | null>();
function proxySources(ctx: AppContext): BlockList | null {
  if (!sourceLists.has(ctx)) {
    const list = buildSourceList(ctx.config.proxyAuthSources);
    if (ctx.config.proxyAuthHeader && !list) {
      ctx.log.warn(
        'RP_PROXY_AUTH_HEADER is set but RP_PROXY_AUTH_SOURCES is empty - proxy sign-in stays disabled (fail closed).',
      );
    }
    sourceLists.set(ctx, list);
  }
  return sourceLists.get(ctx) ?? null;
}

/**
 * CSRF defense in depth for cookie-authenticated mutations:
 *  1. Session cookie is SameSite=Lax (blocks cross-site POST subresources).
 *  2. Mutating requests must carry the custom `x-rp-csrf: 1` header, which a
 *     cross-origin form/img cannot set.
 *  3. When Origin / Sec-Fetch-Site headers are present they must indicate a
 *     same-origin request.
 */
export function csrfCheck(req: FastifyRequest): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (req.headers['x-rp-csrf'] !== '1') return false;
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && !['same-origin', 'none'].includes(secFetchSite)) {
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    const host = req.headers.host;
    try {
      const originHost = new URL(origin).host;
      if (host && originHost !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function attachUser(ctx: AppContext, req: FastifyRequest, reply?: FastifyReply): void {
  // An API key first: an agent sends no cookies, and a request carrying a key
  // is a key request even if a browser session happens to exist alongside it.
  const bearer = bearerToken(req.headers.authorization);
  if (req.headers.authorization !== undefined) {
    const keyUser = bearer ? resolveApiKey(ctx.db, bearer, new Date().toISOString()) : null;
    if (keyUser) {
      req.user = keyUser;
      req.authVia = 'apikey';
      req.apiKeyId = keyUser.apiKeyId;
      req.agentScopes = [AGENT_SCOPE];
      return;
    }
    // A presented-but-invalid key is not silently downgraded to anonymous:
    // leaving req.user null makes the route reply 401, which is the honest
    // answer and what a client can act on.
    req.user = null;
    return;
  }
  const token = (req.cookies ?? {})[SESSION_COOKIE];
  req.user = token
    ? resolveSession(ctx.db, ctx.config.sessionSecret, token, ctx.config.sessionDays)
    : null;
  if (req.user) {
    req.authVia = 'session';
    // The server slid this session forward, so the browser's copy has to move
    // with it - otherwise the cookie expires on the original schedule and the
    // sign-out still happens, taking this device's downloads with it.
    if (req.user.renewedUntil && reply) {
      reply.setCookie(SESSION_COOKIE, token!, sessionCookieOpts(ctx.config));
    }
    return;
  }
  const proxied = proxyAuthUser(ctx, req, proxySources(ctx));
  if (proxied) {
    req.user = proxied;
    req.authVia = 'proxy';
  }
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.user) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

/** Missing grants, unknown routes and every non-GET fail closed. */
export function apiKeyAllows(
  method: string,
  pathname: string,
  scopes: readonly string[] = [],
): boolean {
  return method === 'GET' && scopes.includes(AGENT_SCOPE) && agentRoute(pathname) !== undefined;
}
