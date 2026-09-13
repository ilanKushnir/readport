import { describe, expect, it } from 'vitest';
import { type FastifyRequest } from 'fastify';
import { buildClientIp, isPrivateAddress } from './clientIp.js';
import { buildSourceList } from '../auth/proxyAuth.js';

/**
 * Which address the rate limiters count.
 *
 * The failure this exists to prevent has two opposite halves, and only one of
 * them is obvious. Counting too COARSELY - every client behind a tunnel
 * sharing one bucket - lets a stranger lock the owner out of their own login
 * with ten wrong passwords. Counting whatever the client ASKS to be counted
 * as removes the limit altogether, which is worse: an attacker rotates the
 * header and brute-forces unthrottled.
 *
 * So the header is honoured only from a peer on the list, and every other
 * path falls back to the socket address - never open, never absent.
 */

const req = (opts: {
  ip?: string;
  peer?: string;
  headers?: Record<string, string | string[]>;
}): FastifyRequest =>
  ({
    ip: opts.ip ?? '172.18.0.2',
    headers: opts.headers ?? {},
    raw: { socket: { remoteAddress: opts.peer ?? '192.168.1.50' } },
  }) as unknown as FastifyRequest;

const CONFIG = { clientIpHeader: 'cf-connecting-ip', clientIpSources: ['192.168.1.50/32'] };
const SOURCES = buildSourceList(CONFIG.clientIpSources);

describe('with a client-ip header configured', () => {
  const clientIp = buildClientIp(CONFIG, SOURCES);

  it('counts the real client when the tunnel delivered the request', () => {
    expect(clientIp(req({ headers: { 'cf-connecting-ip': '203.0.113.9' } }))).toBe('203.0.113.9');
  });

  it('ignores the header from any other peer', () => {
    // Someone on the LAN hitting the published port directly. Their peer is
    // their own address, so they cannot choose their bucket.
    expect(
      clientIp(
        req({
          peer: '192.168.1.77',
          ip: '192.168.1.77',
          headers: { 'cf-connecting-ip': '1.2.3.4' },
        }),
      ),
    ).toBe('192.168.1.77');
  });

  it('falls back rather than trusting junk', () => {
    for (const bad of [
      '',
      '   ',
      'not an address',
      '203.0.113.9, 10.0.0.1',
      '<script>',
      'x'.repeat(80),
    ]) {
      expect(clientIp(req({ headers: { 'cf-connecting-ip': bad } })), bad).toBe('172.18.0.2');
    }
    // Absent entirely.
    expect(clientIp(req({}))).toBe('172.18.0.2');
  });

  it('takes the first value when the header arrives more than once', () => {
    expect(clientIp(req({ headers: { 'cf-connecting-ip': ['203.0.113.9', '1.2.3.4'] } }))).toBe(
      '203.0.113.9',
    );
  });

  it('accepts IPv6', () => {
    expect(clientIp(req({ headers: { 'cf-connecting-ip': '2001:db8::1' } }))).toBe('2001:db8::1');
  });

  it('matches the header case-insensitively, as HTTP requires', () => {
    // Fastify lowercases incoming header names; the config value might not be.
    const upper = buildClientIp({ ...CONFIG, clientIpHeader: 'CF-Connecting-IP' }, SOURCES);
    expect(upper(req({ headers: { 'cf-connecting-ip': '203.0.113.9' } }))).toBe('203.0.113.9');
  });
});

describe('when it is not configured, or configured wrongly', () => {
  it('uses the socket address when no header is named', () => {
    const clientIp = buildClientIp({ clientIpHeader: '', clientIpSources: [] }, null);
    expect(clientIp(req({ headers: { 'cf-connecting-ip': '203.0.113.9' } }))).toBe('172.18.0.2');
  });

  it('refuses to honour a header with no sources, and says so', () => {
    // Fail closed and loudly: the same shape of mistake as proxy SSO with no
    // sources, which would otherwise let anyone pick their own bucket.
    const warnings: string[] = [];
    const clientIp = buildClientIp(
      { clientIpHeader: 'cf-connecting-ip', clientIpSources: [] },
      null,
      {
        warn: (m) => warnings.push(m),
      },
    );
    expect(clientIp(req({ headers: { 'cf-connecting-ip': '203.0.113.9' } }))).toBe('172.18.0.2');
    expect(warnings.join('\n')).toMatch(/RP_CLIENT_IP_SOURCES/);
  });
});

describe('the misconfiguration detector', () => {
  it('recognises the addresses that cannot be internet clients', () => {
    for (const a of [
      '10.1.2.3',
      '127.0.0.1',
      '172.18.0.2', // the docker bridge this whole change is about
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.50',
      '169.254.1.1',
      '100.64.0.1', // CGNAT / tailscale
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1', // IPv4-mapped
    ]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
  });

  it('leaves real client addresses alone', () => {
    for (const a of ['203.0.113.9', '8.8.8.8', '172.32.0.1', '172.15.0.1', '2001:db8::1']) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });
});
