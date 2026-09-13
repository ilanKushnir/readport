import { type BlockList } from 'node:net';
import { type FastifyRequest } from 'fastify';
import { type EnvConfig } from '../config.js';
import { normalizePeer, peerIsTrusted } from '../auth/proxyAuth.js';

/**
 * Who to count rate limits against.
 *
 * `req.ip` is right for a plain deployment and for one behind a single
 * reverse proxy. It is wrong behind a tunnel: with Cloudflare in front,
 * ReadPort's own measurements showed EVERY request from the internet
 * arriving as one address - the tunnel daemon - because `X-Forwarded-For`
 * only gets walked back through the hops named in RP_TRUST_PROXY, and the
 * tunnel is a hop further out than the proxy.
 *
 * One address for the whole internet means one bucket for the whole
 * internet, which turns every limit here into a lever a stranger can pull on
 * the owner: thirty wrong tokens and nobody can finish setup; ten wrong
 * passwords against a guessed username and the real owner cannot log in,
 * repeatable for as long as the attacker cares to keep going.
 *
 * So: a header may name the client instead. `RP_CLIENT_IP_HEADER`
 * (`cf-connecting-ip` for Cloudflare) is read ONLY when the TCP peer that
 * delivered the request is in `RP_CLIENT_IP_SOURCES` - checked on the socket,
 * never on a forwarded header, the same rule proxy SSO uses. A client that
 * reaches the port directly is never a trusted peer, so it cannot pick its
 * own bucket.
 *
 * Two deliberate limits on the blast radius:
 *
 *  - This value is used for RATE-LIMIT KEYS AND NOTHING ELSE. It is not an
 *    identity, it never reaches an authorization decision, and it does not
 *    feed Fastify's `trustProxy`. The worst a misconfiguration can do is
 *    count the wrong bucket; it can never let anybody in.
 *  - It fails back, not open. No header configured, no sources configured,
 *    an untrusted peer, a missing or malformed value - every one of them
 *    falls through to `req.ip`, which is exactly today's behaviour.
 */

/** Cheap sanity check: an address-shaped token, nothing exotic. */
const ADDRESS_RE = /^[0-9a-fA-F:.]{3,45}$/;

export interface ClientIpResolver {
  (req: FastifyRequest): string;
}

export function buildClientIp(
  config: Pick<EnvConfig, 'clientIpHeader' | 'clientIpSources'>,
  sources: BlockList | null,
  log?: { warn: (m: string) => void },
): ClientIpResolver {
  const header = config.clientIpHeader.trim().toLowerCase();
  if (!header) return (req) => req.ip;
  if (!sources) {
    // Fail closed and say so, rather than quietly trusting anybody: the same
    // shape of mistake as configuring proxy SSO with no sources.
    log?.warn(
      'RP_CLIENT_IP_HEADER is set but RP_CLIENT_IP_SOURCES is empty - rate limits keep using the socket address.',
    );
    return (req) => req.ip;
  }
  return (req) => {
    if (!peerIsTrusted(sources, normalizePeer(req.raw.socket?.remoteAddress))) return req.ip;
    const raw = req.headers[header];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    // Cloudflare sends exactly one address here and overwrites whatever the
    // client sent. Anything else is a proxy we do not understand, so ignore
    // it rather than guess which comma-separated part is the client.
    if (!value || !ADDRESS_RE.test(value)) return req.ip;
    return value;
  };
}

/**
 * Whether an address is one that cannot be a client on the public internet.
 *
 * Used only to notice a misconfiguration out loud: if rate limits are being
 * counted against a private address while requests carry X-Forwarded-For,
 * a hop is missing from the trust chain and every real client is sharing one
 * bucket. Deliberately conservative - it is a diagnostic, not a gate.
 */
export function isPrivateAddress(addr: string): boolean {
  const a = normalizePeer(addr) ?? addr;
  if (a === '::1' || a === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(a);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return (
    x === 10 ||
    x === 127 ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 169 && y === 254) ||
    (x === 100 && y >= 64 && y <= 127)
  );
}
