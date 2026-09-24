import { describe, expect, it, vi } from 'vitest';
import { coverWorthy, imageFacts, svgFacts } from './image.js';
import { allowedUrl, fetchAllowed } from './fetch.js';
import { inTurns, isbnsOf, searchAuthor, searchTitle, titleMatch } from './lookup.js';
import { jpeg, png } from './test-images.js';

/**
 * Covers found elsewhere: the image checks, the host allowlist, and the
 * matching that decides what is worth showing. Titles and people invented.
 */

describe('imageFacts', () => {
  it('reads the kind and size of a PNG and a JPEG from their bytes', () => {
    expect(imageFacts(png(400, 600))).toEqual({ kind: 'png', width: 400, height: 600 });
    expect(imageFacts(jpeg(667, 1000))).toEqual({ kind: 'jpeg', width: 667, height: 1000 });
  });

  it('refuses what is not a picture, or is too small to be a cover', () => {
    expect(imageFacts(Buffer.from('<html><body>not found</body></html>'))).toBeNull();
    expect(coverWorthy(imageFacts(png(84, 140)))).toBe(false);
    expect(coverWorthy(imageFacts(png(300, 450)))).toBe(true);
  });
});

describe('svgFacts', () => {
  it('reads the size a drawn cover says it is, from its size or its viewBox', () => {
    const svg = (attrs: string) =>
      Buffer.from(
        `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect/></svg>`,
      );
    expect(svgFacts(svg('width="800" height="1200"'))).toEqual({
      kind: 'svg',
      width: 800,
      height: 1200,
    });
    expect(svgFacts(svg('viewBox="0 0 600 900"'))).toEqual({
      kind: 'svg',
      width: 600,
      height: 900,
    });
    expect(svgFacts(svg('width="100%" viewBox="0 0 600 900"'))).toEqual({
      kind: 'svg',
      width: 600,
      height: 900,
    });
  });

  it('is never taken for a picture from elsewhere', () => {
    expect(
      imageFacts(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"></svg>'),
      ),
    ).toBeNull();
  });
});

describe('the hosts a lookup may ask', () => {
  it('allows Open Library, the Internet Archive and Apple, over https only', () => {
    expect(allowedUrl('https://covers.openlibrary.org/b/id/1-L.jpg')).not.toBeNull();
    expect(allowedUrl('https://ia902809.us.archive.org/view_archive.php?x=1')).not.toBeNull();
    expect(
      allowedUrl('https://is1-ssl.mzstatic.com/image/thumb/a.jpg/1000x1000bb.jpg'),
    ).not.toBeNull();
    expect(allowedUrl('http://covers.openlibrary.org/b/id/1-L.jpg')).toBeNull();
    expect(allowedUrl('https://covers.openlibrary.org.example.net/x')).toBeNull();
    expect(allowedUrl('https://169.254.169.254/latest/meta-data')).toBeNull();
    expect(allowedUrl('https://user@openlibrary.org/')).toBeNull();
    expect(allowedUrl('https://openlibrary.org:8443/')).toBeNull();
  });

  it('follows a redirect only to another allowed host', async () => {
    const fetchFn = vi.fn(async (url: URL | RequestInfo) => {
      const u = String(url);
      if (u.startsWith('https://covers.openlibrary.org/'))
        return new Response(null, {
          status: 302,
          headers: { location: 'https://archive.org/download/x.jpg' },
        });
      if (u.startsWith('https://archive.org/'))
        return new Response(null, {
          status: 302,
          headers: { location: 'http://10.0.0.5/private' },
        });
      return new Response('secret');
    });
    expect(
      await fetchAllowed('https://covers.openlibrary.org/b/id/1-L.jpg', 1000, 'image/*', fetchFn),
    ).toBeNull();
    // Never asked the private address.
    expect(fetchFn.mock.calls.map(([u]) => String(u))).toEqual([
      'https://covers.openlibrary.org/b/id/1-L.jpg',
      'https://archive.org/download/x.jpg',
    ]);
  });

  it('stops reading an answer past its limit', async () => {
    const fetchFn = vi.fn(async () => new Response(Buffer.alloc(5000)));
    expect(
      await fetchAllowed('https://openlibrary.org/search.json', 1000, 'application/json', fetchFn),
    ).toBeNull();
  });
});

describe('what to search for, and what counts as found', () => {
  it('keeps only real ISBNs, whatever they were filed under', () => {
    expect(
      isbnsOf({
        isbn: '978-0-00-000001-9',
        id: 'urn:isbn:0306406152',
        calibre: '42',
        uuid: 'abc',
        bad: '9780000000017',
      }),
    ).toEqual(['9780000000019', '0306406152']);
  });

  it('searches for the main title, without series or subtitle, and the author first-name first', () => {
    expect(searchTitle('The Lantern of Ash Harbor: A Novel (Ash Harbor, #1)')).toBe(
      'The Lantern of Ash Harbor',
    );
    expect(searchTitle('Fog Signals - Stories')).toBe('Fog Signals');
    expect(searchAuthor('Sharon, Rivka')).toBe('Rivka Sharon');
    expect(searchAuthor('Rivka Sharon & Oswin Pell')).toBe('Rivka Sharon');
  });

  it('takes an alternative title for a subtitle', () => {
    expect(searchTitle('Fog Signals, or The Keeper’s Year')).toBe('Fog Signals');
    expect(searchTitle('Fog Signals; or, The Keeper’s Year')).toBe('Fog Signals');
  });

  it('does not take a sequel or a box set for the book', () => {
    expect(titleMatch('Fog Signals', 'Fog Signals Returning')).toBeLessThan(0.8);
    expect(titleMatch('Fog Signals', 'Fog Signals & The Tide Clock [boxed set]')).toBeLessThan(0.8);
    expect(titleMatch('Fog Signals, or The Keeper’s Year', 'Fog Signals')).toBeGreaterThanOrEqual(
      0.9,
    );
    expect(titleMatch('Fog Signals', 'Fog Signals (Unabridged)')).toBeGreaterThanOrEqual(0.9);
  });

  it('forgives a missing subtitle, and not a different book', () => {
    expect(
      titleMatch('The Lantern of Ash Harbor: A Novel', 'The Lantern of Ash Harbor'),
    ).toBeGreaterThanOrEqual(0.9);
    expect(titleMatch('The Lantern of Ash Harbor', 'the lantern of ash harbor')).toBe(1);
    expect(titleMatch('The Lantern of Ash Harbor', 'Saltmarsh Evenings')).toBeLessThan(0.5);
  });
});

describe('the order covers are offered in', () => {
  it('lets every source show its best before any shows its second', () => {
    const found = [
      { source: 'apple', score: 1.9 },
      { source: 'apple', score: 1.8 },
      { source: 'apple', score: 1.7 },
      { source: 'openlibrary', score: 10 },
      { source: 'google', score: 1.6 },
    ];
    expect(inTurns(found).map((f) => `${f.source} ${f.score}`)).toEqual([
      'openlibrary 10',
      'apple 1.9',
      'google 1.6',
      'apple 1.8',
      'apple 1.7',
    ]);
  });
});
