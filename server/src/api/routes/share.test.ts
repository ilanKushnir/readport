import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { saveSettings } from '../../domain/settings.js';
import { SHARE_TOKEN_RE } from '@readport/shared';
import { renderSvgToPng } from '../../share/image.js';

/**
 * Share links: the one public page about a book, and the way in through it.
 *
 * Pinned from both sides: what a stranger with the link gets (the teaser,
 * the crawler HTML, the picture, the cover - and nothing about the sharer's
 * account), what they do not get once the link is revoked, and the whole
 * road from "ask to join" through an admin's approval to an account that
 * lands with the book on its reading list, credited to the sharer.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-share-'));
const webDist = path.join(tmp, 'dist');
fs.mkdirSync(webDist);
const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="Read and listen in perfect tandem." />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="ReadPort" />
    <meta property="og:image" content="/share.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <title>ReadPort</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`;
fs.writeFileSync(path.join(webDist, 'index.html'), INDEX_HTML);

const db = openMemoryDatabase();
const app = buildApp(
  {
    db,
    config: loadConfig({
      dataDir: tmp,
      cacheDir: tmp,
      sessionSecret: 'share-test-secret-0123456789abcdef',
      logLevel: 'error',
      proxyAuthHeader: 'x-rp-test-user',
      proxyAuthSources: ['10.0.0.0/8'],
    }),
    log: { info() {}, warn() {}, error() {} },
  },
  { webDist },
);

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
/** A signed-in request, through the test proxy identity. */
const as = (user: string, url: string, method: Method = 'GET', payload?: unknown) =>
  app.inject({
    url,
    method,
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': user, 'x-rp-csrf': '1' },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
/** A stranger: no cookie, no proxy header - what a crawler or a link-follower is. */
const anon = (
  url: string,
  method: Method = 'GET',
  payload?: unknown,
  opts: { ip?: string; cookie?: string } = {},
) =>
  app.inject({
    url,
    method,
    remoteAddress: opts.ip ?? '203.0.113.7',
    headers: { 'x-rp-csrf': '1', ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

const ids: Record<string, string> = {};

beforeAll(async () => {
  await app.ready();
  // The first proxied account is the admin; the rest are readers.
  for (const u of ['astra', 'bob', 'carol']) {
    ids[u] = ((await as(u, '/api/auth/me')).json() as { user: { id: string } }).user.id;
  }
  db.prepare("UPDATE users SET display_name = 'Bob Bookish' WHERE id = ?").run(ids.bob);
  const cover = path.join(tmp, 'b1.png');
  fs.writeFileSync(
    cover,
    renderSvgToPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#2F4A5C"/></svg>',
    ),
  );
  const now = new Date().toISOString();
  const book = db.prepare(
    `INSERT INTO books (id,kind,root_dir,rel_path,format,title,author,scan_state,cover_path,added_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  book.run(
    'b1',
    'ebook',
    tmp,
    'b1.epub',
    'epub',
    'Tin & "Tallow" <Lamps>',
    'M. Vale',
    'ready',
    cover,
    now,
  );
  book.run(
    'b2',
    'audio',
    tmp,
    'b2',
    'm4b',
    'Семнадцать воздушных змеев',
    'Ирина Мармелева',
    'ready',
    null,
    now,
  );
  book.run(
    'b3',
    'ebook',
    tmp,
    'b3.epub',
    'epub',
    'אורות לאורך השדרה',
    'יעל ברק',
    'ready',
    null,
    now,
  );
  book.run('b4', 'ebook', tmp, 'b4.epub', 'epub', 'Gone', null, 'missing', null, now);
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let token = '';

describe('making a share link', () => {
  it('answers exactly {url, token}, and the same token while the share lives', async () => {
    const res = await as('bob', '/api/books/b1/share', 'POST');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; token: string };
    expect(Object.keys(body).sort()).toEqual(['token', 'url']);
    expect(body.token).toMatch(SHARE_TOKEN_RE);
    expect(body.token.length).toBeGreaterThanOrEqual(22);
    expect(body.url).toBe(`http://localhost:80/s/${body.token}`);
    token = body.token;
    const again = (await as('bob', '/api/books/b1/share', 'POST')).json() as { token: string };
    expect(again.token).toBe(token);
  });

  it('builds the link from the public address once one is configured', async () => {
    saveSettings(db, { publicUrl: 'https://books.example/' });
    const body = (await as('bob', '/api/books/b1/share', 'POST')).json() as { url: string };
    expect(body.url).toBe(`https://books.example/s/${token}`);
  });

  it('needs a session, and a book that is here', async () => {
    expect((await anon('/api/books/b1/share', 'POST')).statusCode).toBe(401);
    expect((await as('bob', '/api/books/b4/share', 'POST')).statusCode).toBe(404);
    expect((await as('bob', '/api/books/nope/share', 'POST')).statusCode).toBe(404);
  });
});

describe('what a stranger with the link gets', () => {
  it('the teaser: the book and a display name, nothing that names the account', async () => {
    const res = await anon(`/api/share/${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      valid: true,
      book: {
        id: 'b1',
        title: 'Tin & "Tallow" <Lamps>',
        author: 'M. Vale',
        kind: 'ebook',
        hasCover: true,
      },
      sharedBy: { displayName: 'Bob Bookish' },
    });
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('{valid: false} for a token nobody minted, with no hint why', async () => {
    expect((await anon('/api/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).json()).toEqual({
      valid: false,
    });
    expect((await anon('/api/share/short')).json()).toEqual({ valid: false });
  });

  it('the page, with the book in Open Graph tags and every value escaped', async () => {
    const res = await anon(`/s/${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    const html = res.body;
    expect(html).toContain('<meta property="og:type" content="book" />');
    expect(html).toContain(
      '<meta property="og:title" content="Tin &amp; &quot;Tallow&quot; &lt;Lamps&gt;" />',
    );
    expect(html).toContain(
      '<meta property="og:description" content="M. Vale · Shared with you on ReadPort" />',
    );
    expect(html).toContain(`<meta property="og:url" content="https://books.example/s/${token}" />`);
    expect(html).toContain(
      `<meta property="og:image" content="https://books.example/s/${token}/image.png" />`,
    );
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<title>Tin &amp; &quot;Tallow&quot; &lt;Lamps&gt; · ReadPort</title>');
    // The app's own tags make way rather than sitting beside the book's.
    expect(html).not.toContain('<meta property="og:title" content="ReadPort" />');
    expect(html).not.toContain('content="/share.png"');
    // The raw title never appears unescaped anywhere in the document.
    expect(html).not.toContain('<Lamps>');
    // Still the app shell: the bundle loads and the app takes over.
    expect(html).toContain(
      '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
    );
    expect(html).toContain('<div id="root"></div>');
  });

  it('the page unchanged for a dead token, so the app can say so', async () => {
    const res = await anon('/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('the picture: a 1200x630 PNG, cacheable by anyone, the same bytes twice', async () => {
    const res = await anon(`/s/${token}/image.png`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    const png = res.rawPayload;
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    const again = await anon(`/s/${token}/image.png`);
    expect(again.rawPayload.equals(png)).toBe(true);
    expect((await anon('/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/image.png')).statusCode).toBe(404);
  });

  it('a picture for a title the fonts cannot shape, and for a book with no cover', async () => {
    const hebrew = (await as('carol', '/api/books/b3/share', 'POST')).json() as { token: string };
    const res = await anon(`/s/${hebrew.token}/image.png`);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.readUInt32BE(16)).toBe(1200);
    const cyrillic = (await as('carol', '/api/books/b2/share', 'POST')).json() as {
      token: string;
    };
    expect((await anon(`/s/${cyrillic.token}/image.png`)).statusCode).toBe(200);
    expect((await anon(`/s/${cyrillic.token}/cover`)).statusCode).toBe(404);
  });

  it('the cover on its own, for the teaser', async () => {
    const res = await anon(`/s/${token}/cover`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });
});

describe('revoking', () => {
  it('is for the creator or an admin; anyone else sees a 404, not a 403', async () => {
    expect((await as('carol', `/api/share/${token}`, 'DELETE')).statusCode).toBe(404);
    expect((await anon(`/api/share/${token}`, 'DELETE')).statusCode).toBe(401);
    expect((await as('bob', `/api/share/${token}`, 'DELETE')).json()).toEqual({ ok: true });
    expect((await as('bob', `/api/share/${token}`, 'DELETE')).statusCode).toBe(404);
  });

  it('turns everything under the link off, and the next share is a new token', async () => {
    expect((await anon(`/api/share/${token}`)).json()).toEqual({ valid: false });
    expect((await anon(`/s/${token}/image.png`)).statusCode).toBe(404);
    expect((await anon(`/s/${token}/cover`)).statusCode).toBe(404);
    expect((await anon(`/s/${token}`)).body).toBe(INDEX_HTML);
    const fresh = (await as('bob', '/api/books/b1/share', 'POST')).json() as { token: string };
    expect(fresh.token).not.toBe(token);
    token = fresh.token;
  });

  it("an admin can revoke somebody else's share", async () => {
    const carols = (await as('carol', '/api/books/b1/share', 'POST')).json() as {
      token: string;
    };
    expect((await as('astra', `/api/share/${carols.token}`, 'DELETE')).json()).toEqual({
      ok: true,
    });
    expect((await anon(`/api/share/${carols.token}`)).json()).toEqual({ valid: false });
  });
});

describe('asking to join, and being let in', () => {
  let link = '';
  const email = 'dana@example.org';
  let inviteToken = '';
  let cookie = '';

  beforeAll(async () => {
    link = ((await as('carol', '/api/books/b2/share', 'POST')).json() as { token: string }).token;
  });

  it('takes an address, a name and a line; asking twice is the same answer', async () => {
    const res = await anon(`/api/share/${link}/join`, 'POST', {
      email: '  Dana@Example.ORG ',
      name: ' Dana ',
      message: 'Carol said I should read this.',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ status: 'pending' });
    const again = await anon(`/api/share/${link}/join`, 'POST', { email });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ status: 'pending' });
    const rows = db.prepare('SELECT email, name, message FROM join_requests').all();
    expect(rows).toEqual([{ email, name: 'Dana', message: 'Carol said I should read this.' }]);
  });

  it('refuses a bad address, and a dead link', async () => {
    expect(
      (await anon(`/api/share/${link}/join`, 'POST', { email: 'not an address' })).statusCode,
    ).toBe(400);
    expect(
      (await anon('/api/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/join', 'POST', { email }))
        .statusCode,
    ).toBe(404);
  });

  it('reports the request only for its own address on its own link', async () => {
    expect((await anon(`/api/share/${link}/join?email=${email}`)).json()).toEqual({
      status: 'pending',
    });
    expect((await anon(`/api/share/${link}/join?email=DANA@example.org`)).json()).toEqual({
      status: 'pending',
    });
    expect((await anon(`/api/share/${link}/join?email=someone@example.org`)).json()).toEqual({
      status: 'none',
    });
    expect((await anon(`/api/share/${token}/join?email=${email}`)).json()).toEqual({
      status: 'none',
    });
    expect((await anon(`/api/share/${link}/join`)).statusCode).toBe(400);
  });

  it('is counted for admins on /api/auth/me, and for nobody else', async () => {
    const admin = (await as('astra', '/api/auth/me')).json() as { joinRequests?: number };
    expect(admin.joinRequests).toBe(1);
    const reader = (await as('bob', '/api/auth/me')).json() as { joinRequests?: number };
    expect(reader.joinRequests).toBeUndefined();
  });

  it('shows an admin who asked, for what, shared by whom', async () => {
    expect((await as('bob', '/api/join-requests')).statusCode).toBe(403);
    const res = await as('astra', '/api/join-requests');
    expect(res.statusCode).toBe(200);
    const { requests } = res.json() as {
      requests: {
        id: string;
        email: string;
        name: string;
        message: string;
        status: string;
        book: { id: string; title: string } | null;
        sharedBy: { displayName: string } | null;
      }[];
    };
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      email,
      name: 'Dana',
      message: 'Carol said I should read this.',
      status: 'pending',
      book: { id: 'b2', title: 'Семнадцать воздушных змеев', kind: 'audio', hasCover: false },
      sharedBy: { displayName: 'carol' },
    });
    expect(JSON.stringify(requests[0])).not.toContain(ids.carol!);
  });

  it('approval mints a reader invitation the link then hands to that address', async () => {
    const id = ((await as('astra', '/api/join-requests')).json() as { requests: { id: string }[] })
      .requests[0]!.id;
    expect((await as('bob', `/api/join-requests/${id}/approve`, 'POST')).statusCode).toBe(403);
    const res = await as('astra', `/api/join-requests/${id}/approve`, 'POST');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { request: { status: string } }).request.status).toBe('approved');
    expect(res.body).not.toMatch(/inviteToken|token_hash/);
    expect((await as('astra', `/api/join-requests/${id}/approve`, 'POST')).statusCode).toBe(409);

    const status = (await anon(`/api/share/${link}/join?email=${email}`)).json() as {
      status: string;
      inviteToken?: string;
    };
    expect(status.status).toBe('approved');
    expect(status.inviteToken).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    inviteToken = status.inviteToken!;
    // Only that address, only that link.
    expect((await anon(`/api/share/${link}/join?email=other@example.org`)).json()).toEqual({
      status: 'none',
    });
    expect((await anon(`/api/share/${token}/join?email=${email}`)).json()).toEqual({
      status: 'none',
    });
    // The invitation is an ordinary one: a reader, named after the request.
    const peek = (await anon(`/api/invites/${inviteToken}`)).json() as {
      role: string;
      displayName: string | null;
    };
    expect(peek).toMatchObject({ role: 'reader', displayName: 'Dana' });
    // And the admin's count is back to nothing.
    expect(
      ((await as('astra', '/api/auth/me')).json() as { joinRequests: number }).joinRequests,
    ).toBe(0);
  });

  it('accepting the invitation makes the account and signs it in', async () => {
    const res = await anon(`/api/invites/${inviteToken}/accept`, 'POST', {
      username: 'dana',
      password: 'a-long-enough-password',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      user: { username: 'dana', role: 'reader', displayName: 'Dana' },
    });
    cookie = String(res.headers['set-cookie']).split(';')[0]!;
    // Used up: the link no longer says the code.
    expect((await anon(`/api/share/${link}/join?email=${email}`)).json()).toEqual({
      status: 'approved',
    });
  });

  it('puts the shared book on the new reading list, credited to the sharer', async () => {
    const add = await anon(`/api/share/${link}/add`, 'POST', undefined, { cookie });
    expect(add.statusCode).toBe(200);
    expect(add.json()).toEqual({ added: true, bookId: 'b2' });
    const list = (await anon('/api/reading-list', 'GET', undefined, { cookie })).json() as {
      items: { book: { id: string }; recommendedBy: { userId: string; displayName: string } }[];
    };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.book.id).toBe('b2');
    expect(list.items[0]!.recommendedBy).toMatchObject({ userId: ids.carol, displayName: 'carol' });
    expect((await anon(`/api/share/${link}/add`, 'POST', undefined, { cookie })).json()).toEqual({
      added: false,
      bookId: 'b2',
    });
    expect((await anon(`/api/share/${link}/add`, 'POST')).statusCode).toBe(401);
  });

  it('a declined request is a kind word, and asking again is allowed', async () => {
    const other = 'eve@example.org';
    await anon(`/api/share/${link}/join`, 'POST', { email: other });
    const id = (
      (await as('astra', '/api/join-requests')).json() as {
        requests: { id: string; email: string; status: string }[];
      }
    ).requests.find((r) => r.email === other && r.status === 'pending')!.id;
    const res = await as('astra', `/api/join-requests/${id}/decline`, 'POST');
    expect((res.json() as { request: { status: string } }).request.status).toBe('declined');
    expect((await as('astra', `/api/join-requests/${id}/decline`, 'POST')).statusCode).toBe(409);
    expect((await as('astra', '/api/join-requests/nope/decline', 'POST')).statusCode).toBe(404);
    expect((await anon(`/api/share/${link}/join?email=${other}`)).json()).toEqual({
      status: 'declined',
    });
    const again = await anon(`/api/share/${link}/join`, 'POST', { email: other });
    expect(again.statusCode).toBe(201);
    expect((await anon(`/api/share/${link}/join?email=${other}`)).json()).toEqual({
      status: 'pending',
    });
  });

  it('is rate limited per address and per email', async () => {
    const ip = '198.51.100.9';
    for (let i = 0; i < 10; i++) {
      const res = await anon(
        `/api/share/${link}/join`,
        'POST',
        { email: `p${i}@example.org` },
        { ip },
      );
      expect(res.statusCode).toBe(201);
    }
    expect(
      (await anon(`/api/share/${link}/join`, 'POST', { email: 'p10@example.org' }, { ip }))
        .statusCode,
    ).toBe(429);
    const ip2 = '198.51.100.10';
    for (let i = 0; i < 5; i++) {
      await anon(`/api/share/${link}/join`, 'POST', { email: 'same@example.org' }, { ip: ip2 });
    }
    expect(
      (await anon(`/api/share/${link}/join`, 'POST', { email: 'same@example.org' }, { ip: ip2 }))
        .statusCode,
    ).toBe(429);
  });
});

describe('the app shell', () => {
  it('serves the index with an absolute preview image of its own', async () => {
    const res = await anon('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.body).toContain(
      '<meta property="og:image" content="https://books.example/share.png" />',
    );
    expect(res.body).toContain('<meta property="og:title" content="ReadPort" />');
    expect(res.body).not.toContain('og:type" content="book"');
  });
});

describe('looking for a link without making one', () => {
  it('answers null until a share exists, then that share, then null again once withdrawn', async () => {
    expect((await as('astra', '/api/books/b1/share')).json()).toEqual({ url: null, token: null });
    const made = (await as('astra', '/api/books/b1/share', 'POST')).json() as {
      url: string;
      token: string;
    };
    expect((await as('astra', '/api/books/b1/share')).json()).toEqual(made);
    // Somebody else's link for the same book is not this caller's.
    const bobs = (await as('bob', '/api/books/b1/share')).json() as { token: string | null };
    expect(bobs.token).not.toBe(made.token);
    await as('astra', `/api/share/${made.token}`, 'DELETE');
    expect((await as('astra', '/api/books/b1/share')).json()).toEqual({ url: null, token: null });
    expect((await as('astra', '/api/books/nope/share')).statusCode).toBe(404);
  });
});
