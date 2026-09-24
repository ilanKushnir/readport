import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { type AppContext } from '../../context.js';
import { giveFolderCovers } from '../../jobs/handlers.js';
import { jpeg, png } from '../../covers/test-images.js';

/**
 * Covers for books without one, through the API: a curator's to ask for, the
 * network only when asked and only of the sources an admin chose, the
 * pictures served from ReadPort's own disk, and a pick that reaches the
 * book's other format too. The network is a fake that answers like Open
 * Library, Apple, Google Books and Audible do. Every book is invented.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-covers-'));
const db = openMemoryDatabase();
const config = loadConfig({
  dataDir: path.join(tmp, 'data'),
  cacheDir: path.join(tmp, 'cache'),
  sessionSecret: 'covers-test-secret-0123456789abcdef',
  logLevel: 'error',
  proxyAuthHeader: 'x-rp-test-user',
  proxyAuthSources: ['10.0.0.0/8'],
});
const log = { info() {}, warn() {}, error() {} };
const app = buildApp({ db, config, log });
const ctx = { db, config, log } as unknown as AppContext;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const as = (user: string, url: string, method: Method = 'GET', payload?: unknown) =>
  app.inject({
    url,
    method,
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': user, 'x-rp-csrf': '1' },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const now = new Date().toISOString();

const ISBN_COVER = png(400, 600);
const SEARCH_COVER = jpeg(500, 750);
const APPLE_COVER = png(667, 1000);
const GOOGLE_COVER = jpeg(800, 1200);
const AUDIBLE_COVER = jpeg(1000, 1000);
/** What Google sends for a volume it has no cover for: a drawn stand-in. */
const GOOGLE_STAND_IN = png(575, 750);
const asked: string[] = [];

/** Open Library and Apple, as far as these tests need them to answer. */
async function fakeNetwork(input: URL | RequestInfo): Promise<Response> {
  const url = String(input);
  asked.push(url);
  if (url === 'https://covers.openlibrary.org/b/isbn/9780000000019-L.jpg?default=false')
    return new Response(ISBN_COVER);
  if (url.startsWith('https://openlibrary.org/search.json'))
    return Response.json({
      docs: [
        { title: 'The Lantern of Ash Harbor', author_name: ['Rivka Sharon'], cover_i: 111 },
        { title: 'Saltmarsh Evenings', author_name: ['Oswin Pell'], cover_i: 222 },
      ],
    });
  if (url === 'https://covers.openlibrary.org/b/id/111-L.jpg')
    return new Response(null, {
      status: 302,
      headers: { location: 'https://archive.org/download/111.jpg' },
    });
  if (url === 'https://archive.org/download/111.jpg') return new Response(SEARCH_COVER);
  if (url.startsWith('https://itunes.apple.com/search'))
    return Response.json({
      results: [
        {
          trackName: 'The Lantern of Ash Harbor',
          artistName: 'Rivka Sharon',
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/x/lantern.jpg/100x100bb.jpg',
        },
      ],
    });
  if (url === 'https://is1-ssl.mzstatic.com/image/thumb/x/lantern.jpg/1000x1000bb.jpg')
    return new Response(APPLE_COVER);
  if (url.startsWith('https://books.google.com/books?')) {
    const keys = new URL(url).searchParams.get('bibkeys') ?? '';
    const vol = (isbn: string, id: string) => ({
      [`ISBN:${isbn}`]: {
        thumbnail_url: `https://books.google.com/books/content?id=${id}&printsec=frontcover&img=1&zoom=5`,
      },
    });
    return new Response(
      `rp(${JSON.stringify({
        ...(keys.includes('9780000000019') ? vol('9780000000019', 'LanternVol01') : {}),
        ...(keys.includes('9780000000026') ? vol('9780000000026', 'NoCoverVol02') : {}),
      })});`,
    );
  }
  if (url.startsWith('https://books.google.com/books/content?id=LanternVol01&'))
    return new Response(GOOGLE_COVER);
  if (url.startsWith('https://books.google.com/books/content?id=NoCoverVol02&'))
    return new Response(GOOGLE_STAND_IN);
  if (url.startsWith('https://api.audible.com/1.0/catalog/products?'))
    return Response.json({
      products: [
        {
          title: 'The Lantern of Ash Harbor',
          authors: [{ name: 'Rivka Sharon' }],
          product_images: { 500: 'https://m.media-amazon.com/images/I/51Lantern-Ash._SL500_.jpg' },
        },
      ],
    });
  if (url === 'https://m.media-amazon.com/images/I/51Lantern-Ash._SL1000_.jpg')
    return new Response(AUDIBLE_COVER);
  return new Response('not here', { status: 404 });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(fakeNetwork));
  await app.ready();
  const add = (
    id: string,
    kind: 'ebook' | 'audio',
    title: string,
    extra: Record<string, unknown> = {},
  ) =>
    db
      .prepare(
        `INSERT INTO books (id,kind,root_dir,rel_path,format,title,author,language,identifiers_json,cover_path,scan_state,added_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'ready',?)`,
      )
      .run(
        id,
        kind,
        String(extra.root ?? tmp),
        String(extra.rel ?? id),
        kind === 'ebook' ? 'epub' : 'm4b',
        title,
        String(extra.author ?? 'Rivka Sharon'),
        'en',
        JSON.stringify(extra.identifiers ?? {}),
        (extra.cover as string | undefined) ?? null,
        now,
      );
  add('lantern-e', 'ebook', 'The Lantern of Ash Harbor: A Novel', {
    identifiers: { isbn: '978-0-00-000001-9' },
  });
  add('lantern-a', 'audio', 'The Lantern of Ash Harbor');
  // A paired book whose ebook has a cover of its own and whose audiobook has none.
  const clockCover = path.join(tmp, 'clock.png');
  fs.writeFileSync(clockCover, png(300, 450));
  add('clock-e', 'ebook', "The Clockmaker's Garden", { author: 'Noa Adler', cover: clockCover });
  add('clock-a', 'audio', "The Clockmaker's Garden", { author: 'Noa Adler' });
  // An ebook whose own cover is drawn (SVG), and its coverless audiobook.
  const harborCover = path.join(tmp, 'harbor.svg');
  fs.writeFileSync(
    harborCover,
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#2f4a5c"/></svg>',
  );
  add('harbor-e', 'ebook', 'Harbor Lights at Dusk', { author: 'Noa Adler', cover: harborCover });
  add('harbor-a', 'audio', 'Harbor Lights at Dusk', { author: 'Noa Adler' });
  add('kettle-e', 'ebook', 'A Kettle for the Tide', {
    author: 'Oswin Pell',
    identifiers: { isbn: '9780000000026' },
  });
  const pair = db.prepare(
    "INSERT INTO pairs (id,ebook_id,audio_id,status,score,created_at) VALUES (?,?,?,'confirmed',1,?)",
  );
  pair.run('p-lantern', 'lantern-e', 'lantern-a', now);
  pair.run('p-clock', 'clock-e', 'clock-a', now);
  pair.run('p-harbor', 'harbor-e', 'harbor-a', now);

  await as('astra', '/api/auth/me');
  await as('dana', '/api/auth/me');
  await as('cyd', '/api/auth/me');
  db.prepare("UPDATE users SET role = 'curator' WHERE username = 'cyd'").run();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('finding a cover', () => {
  it('is a curator’s to ask for', async () => {
    expect((await as('dana', '/api/books/lantern-e/cover-suggestions')).statusCode).toBe(403);
  });

  it('asks nobody until someone asks, or an admin says it may', async () => {
    const res = await as('cyd', '/api/books/lantern-e/cover-suggestions');
    expect(res.json()).toEqual({ state: 'ask', auto: false, canLook: true, suggestions: [] });
    expect(asked).toEqual([]);
  });

  it('offers the other format’s own cover without asking anyone', async () => {
    const res = (await as('cyd', '/api/books/clock-a/cover-suggestions')).json();
    expect(res.state).toBe('found');
    expect(res.suggestions).toEqual([
      expect.objectContaining({ n: 0, source: 'edition', width: 300, height: 450 }),
    ]);
    expect(asked).toEqual([]);
  });

  it('looks when asked: the ISBN’s own covers first, then every source in turn', async () => {
    const res = (await as('cyd', '/api/books/lantern-e/cover-suggestions?look=1')).json();
    expect(res.state).toBe('found');
    expect(res.canLook).toBe(true);
    expect(
      res.suggestions.map((s: { source: string; width: number }) => [s.source, s.width]),
    ).toEqual([
      ['google', 800],
      ['openlibrary', 400],
      ['apple', 667],
      ['openlibrary', 500],
    ]);
    // A different book by a different author was never fetched, and an
    // ebook's cover is not looked for in a catalogue of audiobooks.
    expect(asked).not.toContain('https://covers.openlibrary.org/b/id/222-L.jpg');
    expect(asked.some((u) => u.includes('audible'))).toBe(false);
  });

  it('never offers the stand-in Google draws for a book it has no cover for', async () => {
    const res = (await as('cyd', '/api/books/kettle-e/cover-suggestions?look=1')).json();
    expect(asked.some((u) => u.includes('id=NoCoverVol02'))).toBe(true);
    expect(res.suggestions.some((s: { source: string }) => s.source === 'google')).toBe(false);
  });

  it('serves the pictures from its own disk, checked', async () => {
    const res = await as('cyd', '/api/books/lantern-e/cover-suggestions/1/image');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.equals(ISBN_COVER)).toBe(true);
  });

  it('keeps the pick as the cover of both formats', async () => {
    const res = await as('cyd', '/api/books/lantern-e/cover-suggestions/3/accept', 'POST');
    expect(res.statusCode).toBe(200);
    expect(res.json().ids).toEqual(['lantern-e', 'lantern-a']);
    expect(res.json().book).toMatchObject({ hasCover: true, coverFound: 'openlibrary' });
    const cover = await as('dana', '/api/books/lantern-a/cover');
    expect(cover.statusCode).toBe(200);
    expect(cover.rawPayload.equals(SEARCH_COVER)).toBe(true);
    // Kept on ReadPort's data volume, not in the library.
    const row = db.prepare("SELECT found_cover_path FROM books WHERE id = 'lantern-e'").get() as {
      found_cover_path: string;
    };
    expect(row.found_cover_path.startsWith(path.join(tmp, 'data'))).toBe(true);
  });

  it('gives an audiobook its ebook’s drawn cover, kept as a drawing', async () => {
    const offered = (await as('cyd', '/api/books/harbor-a/cover-suggestions')).json();
    expect(offered.suggestions[0]).toMatchObject({ source: 'edition', width: 600, height: 900 });
    const pic = await as('cyd', '/api/books/harbor-a/cover-suggestions/0/image');
    expect(pic.headers['content-type']).toBe('image/svg+xml');
    expect(pic.headers['content-security-policy']).toContain("default-src 'none'");
    await as('cyd', '/api/books/harbor-a/cover-suggestions/0/accept', 'POST');
    const cover = await as('dana', '/api/books/harbor-a/cover');
    expect(cover.statusCode).toBe(200);
    expect(cover.headers['content-type']).toBe('image/svg+xml');
  });

  it('takes a picked cover off again', async () => {
    const res = await as('cyd', '/api/books/lantern-a/found-cover', 'DELETE');
    expect(res.json().book).toMatchObject({ hasCover: false });
    expect(res.json().book.coverFound).toBeUndefined();
    expect((await as('dana', '/api/books/lantern-a/cover')).statusCode).toBe(404);
  });

  it('offers nothing more for a book a curator said no to, until they ask again', async () => {
    await as('cyd', '/api/books/clock-a/cover-suggestions/dismiss', 'POST');
    expect((await as('cyd', '/api/books/clock-a/cover-suggestions')).json().state).toBe(
      'dismissed',
    );
    expect((await as('cyd', '/api/books/clock-a/cover-suggestions?look=1')).json().state).toBe(
      'found',
    );
  });

  it('looks by itself once an admin has turned suggestions on, Audible first for an audiobook', async () => {
    expect((await as('astra', '/api/settings', 'PUT', { coverSuggestions: true })).statusCode).toBe(
      200,
    );
    const res = (await as('cyd', '/api/books/lantern-a/cover-suggestions')).json();
    expect(res.auto).toBe(true);
    expect(res.state).toBe('found');
    expect(res.suggestions[0]).toMatchObject({ source: 'audible', width: 1000 });
  });

  it('asks only the sources an admin chose, and shows only what they found', async () => {
    await as('astra', '/api/settings', 'PUT', { coverSources: ['openlibrary'] });
    const before = asked.length;
    const shown = (await as('cyd', '/api/books/lantern-a/cover-suggestions')).json();
    expect(shown.suggestions.map((s: { source: string }) => s.source)).toEqual(['openlibrary']);
    await as('cyd', '/api/books/lantern-a/cover-suggestions?look=1');
    expect(asked.slice(before).every((u) => /openlibrary|archive\.org/.test(u))).toBe(true);
  });

  it('asks nobody at all when an admin chose no sources', async () => {
    await as('astra', '/api/settings', 'PUT', { coverSources: [] });
    const before = asked.length;
    const res = (await as('cyd', '/api/books/kettle-e/cover-suggestions?look=1')).json();
    expect(res.canLook).toBe(false);
    expect(asked.length).toBe(before);
    // Its other format's own cover is still offered: that needs nobody.
    expect((await as('cyd', '/api/books/clock-a/cover-suggestions')).json().state).toBe('found');
    await as('astra', '/api/settings', 'PUT', {
      coverSources: ['apple', 'audible', 'google', 'openlibrary'],
    });
  });
});

describe('covers the library already has', () => {
  it('takes the cover.jpg beside an ebook in a folder of its own, and not in a shared one', async () => {
    const lib = path.join(tmp, 'library');
    fs.mkdirSync(path.join(lib, 'Rivka Sharon', 'Fog Signals (7)'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'Rivka Sharon', 'Fog Signals (7)', 'Fog Signals.epub'), 'x');
    fs.writeFileSync(
      path.join(lib, 'Rivka Sharon', 'Fog Signals (7)', 'cover.jpg'),
      jpeg(400, 600),
    );
    fs.mkdirSync(path.join(lib, 'Shared'), { recursive: true });
    for (const f of ['One.epub', 'Two.epub']) fs.writeFileSync(path.join(lib, 'Shared', f), 'x');
    fs.writeFileSync(path.join(lib, 'Shared', 'cover.jpg'), jpeg(400, 600));
    const add = db.prepare(
      `INSERT INTO books (id,kind,root_dir,rel_path,format,title,scan_state,added_at)
       VALUES (?, 'ebook', ?, ?, 'epub', ?, 'ready', ?)`,
    );
    add.run('fog', lib, 'Rivka Sharon/Fog Signals (7)/Fog Signals.epub', 'Fog Signals', now);
    add.run('one', lib, 'Shared/One.epub', 'One', now);
    expect(giveFolderCovers(ctx)).toBe(1);
    const cover = (id: string) =>
      (
        db.prepare('SELECT cover_path FROM books WHERE id = ?').get(id) as {
          cover_path: string | null;
        }
      ).cover_path;
    expect(cover('fog')).toBeTruthy();
    expect(cover('one')).toBeNull();
  });
});
