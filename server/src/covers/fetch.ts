import { APP_VERSION } from '../util/version.js';

/**
 * The only way cover lookups reach the network.
 *
 * Every address is checked against a fixed list of hosts before it is
 * asked - and again at every redirect, which are followed here one at a
 * time rather than by the fetch implementation, so no answer can send the
 * server on to anywhere else (its own network, a metadata service, a host
 * nobody chose). HTTPS only, a few seconds each, and a body that stops
 * being read the moment it passes its limit.
 */

const ALLOWED_HOSTS: readonly RegExp[] = [
  // Open Library: its search, and its covers - which redirect into the
  // Internet Archive, where the images are kept.
  /^openlibrary\.org$/,
  /^covers\.openlibrary\.org$/,
  /^archive\.org$/,
  /^ia\d+\.us\.archive\.org$/,
  // Apple's search, and the servers its artwork is on.
  /^itunes\.apple\.com$/,
  /^is\d+-ssl\.mzstatic\.com$/,
  // Google Books: its catalogue, and the server its cover pictures are on.
  /^www\.googleapis\.com$/,
  /^books\.google\.com$/,
  /^books\.googleusercontent\.com$/,
  // Audible's catalogue, one address per store, and Amazon's image server
  // its covers are on.
  /^api\.audible\.(com|ca|co\.uk|com\.au|de|fr|it|es|in|co\.jp)$/,
  /^m\.media-amazon\.com$/,
];

const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 8_000;
const USER_AGENT = `ReadPort/${APP_VERSION} (+https://github.com/ilanKushnir/readport)`;

/** Whether ReadPort may ask this address at all. */
export function allowedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return ALLOWED_HOSTS.some((re) => re.test(url.hostname)) ? url : null;
}

export interface Fetched {
  bytes: Buffer;
  contentType: string;
}

export type FetchFn = typeof fetch;

/**
 * GET an allowed address, following allowed redirects, reading at most
 * `maxBytes`. Null for anything else: a refused host, a failure, a status
 * that is not 200, a body over the limit, too slow an answer.
 */
export async function fetchAllowed(
  raw: string,
  maxBytes: number,
  accept: string,
  fetchFn: FetchFn = fetch,
): Promise<Fetched | null> {
  let url = allowedUrl(raw);
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetchFn(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT, accept },
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      url = next ? allowedUrl(new URL(next, url).toString()) : null;
      continue;
    }
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      await res.body.cancel().catch(() => {});
      return null;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    } catch {
      return null;
    }
    return {
      bytes: Buffer.concat(chunks.map((c) => Buffer.from(c))),
      contentType: res.headers.get('content-type') ?? '',
    };
  }
  return null;
}

/**
 * GET an allowed address that answers JSON wrapped in a callback, as
 * Google's book viewer API does: `cb({...});`. Null for anything else.
 */
export async function fetchJsonp<T>(raw: string, fetchFn: FetchFn = fetch): Promise<T | null> {
  const got = await fetchAllowed(raw, 1_000_000, '*/*', fetchFn);
  if (!got) return null;
  const m = /^[^(]*\(([\s\S]*)\)\s*;?\s*$/.exec(got.bytes.toString('utf8'));
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as T;
  } catch {
    return null;
  }
}

/** GET an allowed address and parse its JSON; null for anything that is not a JSON answer. */
export async function fetchJson<T>(raw: string, fetchFn: FetchFn = fetch): Promise<T | null> {
  const got = await fetchAllowed(raw, 1_000_000, 'application/json', fetchFn);
  if (!got) return null;
  try {
    return JSON.parse(got.bytes.toString('utf8')) as T;
  } catch {
    return null;
  }
}
