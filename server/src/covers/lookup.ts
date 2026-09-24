import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { type AppContext } from '../context.js';
import { type DB, nowIso } from '../db/index.js';
import { normalizeTitle, stringSimilarity, tokenize, tokenSimilarity } from '../util/text.js';
import { realResolveWithin } from '../util/paths.js';
import { authorSimilarity, nameForms } from '../translations/suggest.js';
import { type CoverSourceName } from '@readport/shared';
import { fetchAllowed, fetchJson, fetchJsonp, type FetchFn } from './fetch.js';
import { coverWorthy, IMAGE_EXT, imageFacts, svgFacts, type ImageKind } from './image.js';

/**
 * Covers for books that have none.
 *
 * A book's own cover - embedded in its file, or the `cover.jpg` beside it in
 * a folder of its own - always comes first and is found by indexing. What
 * is here is for the books with neither: a cover a curator picks from what
 * the book's paired edition has, or from what the catalogues an admin chose
 * (the `coverSources` setting) have for its ISBN, title and author. The
 * pick is kept on ReadPort's own data volume; the library itself is never
 * written.
 *
 * Nothing leaves the server for this unless someone asks: a curator pressing
 * Find a cover, or an admin having turned on suggestions for every book
 * without one (the `coverSuggestions` setting). The addresses asked are
 * fixed (fetch.ts), and every image is checked from its own bytes before it
 * is offered, let alone kept.
 */

export type CoverSource = 'edition' | CoverSourceName;

export interface Candidate {
  source: CoverSource;
  /** What the source calls the book, to show beside the picture. */
  title: string | null;
  author: string | null;
  width: number;
  height: number;
  kind: ImageKind;
  /** Where the image is: a file in the book's candidate folder, or another book's own cover. */
  file: string;
}

/** A lookup this old is asked again, when asking is allowed. */
const FRESH_MS = 14 * 24 * 60 * 60_000;
const MAX_CANDIDATES = 6;
/** Pictures fetched for one lookup, at most: the best few matches, not every edition there is. */
const MAX_FETCHES = 9;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function candidateDir(ctx: AppContext, bookId: string): string {
  if (!SAFE_ID.test(bookId)) throw new Error('not a book id');
  return path.join(ctx.config.cacheDir, 'cover-candidates', bookId);
}

function foundDir(ctx: AppContext): string {
  return path.join(ctx.config.dataDir, 'found-covers');
}

interface BookFacts {
  id: string;
  kind: 'ebook' | 'audio';
  title: string;
  author: string | null;
  language: string | null;
  identifiers: Record<string, string>;
  cover_path: string | null;
  found_cover_path: string | null;
}

function bookFacts(db: DB, bookId: string): BookFacts | null {
  const row = db
    .prepare(
      `SELECT id, kind, title, author, language, identifiers_json, cover_path, found_cover_path
         FROM books WHERE id = ?`,
    )
    .get(bookId) as
    | (Omit<BookFacts, 'identifiers' | 'kind'> & { kind: string; identifiers_json: string | null })
    | undefined;
  if (!row) return null;
  let identifiers: Record<string, string> = {};
  try {
    identifiers = JSON.parse(row.identifiers_json ?? '{}') as Record<string, string>;
  } catch {
    identifiers = {};
  }
  return {
    ...row,
    kind: row.kind === 'audio' ? 'audio' : 'ebook',
    identifiers,
  };
}

const present = (p: string | null | undefined): p is string => !!p && fs.existsSync(p);

/** Whether a book has a cover of its own: one from its file or its folder, not one picked for it. */
export function hasOwnCover(book: Pick<BookFacts, 'cover_path' | 'found_cover_path'>): boolean {
  return present(book.cover_path) && book.cover_path !== book.found_cover_path;
}

/* ---------------------------------------------------------------- ISBNs */

function isbn13ok(s: string): boolean {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(s[12]);
}

function isbn10ok(s: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = s[i]!;
    const v = c === 'X' || c === 'x' ? 10 : Number(c);
    if (Number.isNaN(v) || (v === 10 && i !== 9)) return false;
    sum += v * (10 - i);
  }
  return sum % 11 === 0;
}

/** The real ISBNs among a book's identifiers, whatever scheme they were filed under. */
export function isbnsOf(identifiers: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const raw of Object.values(identifiers)) {
    const s = String(raw)
      .replace(/^urn:isbn:/i, '')
      .replace(/[\s-]/g, '');
    if (/^\d{13}$/.test(s) && isbn13ok(s)) out.add(s);
    else if (/^\d{9}[\dXx]$/.test(s) && isbn10ok(s)) out.add(s.toUpperCase());
  }
  return [...out].slice(0, 3);
}

/* -------------------------------------------------------------- matching */

/**
 * The title to search for: without a series in brackets, and without its
 * subtitle - after a colon or a dash, or an alternative title after "or".
 */
export function searchTitle(title: string): string {
  const bare = title
    .replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const main = bare.split(/\s+[-\u2013\u2014]\s+|:\s+|[,;]\s+or,?\s+/i)[0]!.trim();
  return main.length >= 2 ? main : bare;
}

/** The first author, as a search would want them: "First Last", not "Last, First". */
export function searchAuthor(author: string | null): string | null {
  if (!author) return null;
  const first = author.split(/\s*(?:;|&|\band\b)\s*/i)[0]!.trim();
  const flipped = /^[^,]+,\s*[^,]+$/.test(first)
    ? first.split(/,\s*/).reverse().join(' ')
    : first.split(',')[0]!;
  return flipped.trim() || null;
}

/**
 * How well a found title matches the book's: 0-1, forgiving a subtitle one
 * of them leaves out - but not a title that merely starts the same way, as
 * a sequel's or a box set's does.
 */
export function titleMatch(mine: string, theirs: string): number {
  const a = normalizeTitle(mine);
  const b = normalizeTitle(theirs);
  if (!a || !b) return 0;
  const alike = Math.max(stringSimilarity(a, b), tokenSimilarity(tokenize(a), tokenize(b)));
  const ma = normalizeTitle(searchTitle(mine));
  const mb = normalizeTitle(searchTitle(theirs));
  if (ma === mb) return Math.max(alike, 0.9);
  // One main title running on past the other's is another book.
  if (mb.startsWith(`${ma} `) || ma.startsWith(`${mb} `)) return Math.min(alike, 0.7);
  return alike;
}

function authorMatch(mine: string | null, theirs: string | null, language: string | null): number {
  if (!mine || !theirs) return 0.5; // not known: neither for nor against
  return authorSimilarity(nameForms(mine, language), nameForms(theirs, language));
}

/** Good enough to show a curator: the title agrees, and the author does not disagree. */
function matches(book: BookFacts, title: string | null, author: string | null): number {
  if (!title) return 0;
  const t = titleMatch(book.title, title);
  const a = authorMatch(book.author, author, book.language);
  return t >= 0.8 && a >= 0.6 ? t + a : 0;
}

/** Apple's store for a language: a Russian book is in the Russian store, not the American one. */
const APPLE_COUNTRY: Record<string, string> = {
  en: 'us',
  ru: 'ru',
  uk: 'ua',
  he: 'il',
  ar: 'sa',
  de: 'de',
  fr: 'fr',
  es: 'es',
  it: 'it',
  pt: 'pt',
  nl: 'nl',
  pl: 'pl',
  cs: 'cz',
  sv: 'se',
  da: 'dk',
  nb: 'no',
  no: 'no',
  fi: 'fi',
  el: 'gr',
  tr: 'tr',
  ro: 'ro',
  ja: 'jp',
  ko: 'kr',
  zh: 'cn',
};

/* --------------------------------------------------------------- sources */

interface Found {
  source: CoverSource;
  url: string;
  title: string | null;
  author: string | null;
  /** Higher is a better match; an ISBN's own cover beats every search. */
  score: number;
}

async function openLibrary(book: BookFacts, fetchFn: FetchFn): Promise<Found[]> {
  const out: Found[] = [];
  for (const isbn of isbnsOf(book.identifiers))
    out.push({
      source: 'openlibrary',
      url: `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`,
      title: book.title,
      author: book.author,
      score: 10,
    });
  const author = searchAuthor(book.author);
  const q = new URLSearchParams({
    title: searchTitle(book.title),
    limit: '8',
    fields: 'title,author_name,cover_i',
  });
  if (author) q.set('author', author);
  const res = await fetchJson<{
    docs?: { title?: string; author_name?: string[]; cover_i?: number }[];
  }>(`https://openlibrary.org/search.json?${q}`, fetchFn);
  for (const doc of res?.docs ?? []) {
    if (!doc.cover_i || !Number.isInteger(doc.cover_i)) continue;
    const score = matches(book, doc.title ?? null, doc.author_name?.[0] ?? null);
    if (score > 0)
      out.push({
        source: 'openlibrary',
        url: `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`,
        title: doc.title ?? null,
        author: doc.author_name?.[0] ?? null,
        score,
      });
  }
  return out;
}

async function apple(book: BookFacts, fetchFn: FetchFn): Promise<Found[]> {
  const author = searchAuthor(book.author);
  const q = new URLSearchParams({
    term: [searchTitle(book.title), author].filter(Boolean).join(' '),
    media: book.kind === 'audio' ? 'audiobook' : 'ebook',
    limit: '8',
    country: APPLE_COUNTRY[book.language ?? ''] ?? 'us',
  });
  const res = await fetchJson<{
    results?: {
      trackName?: string;
      collectionName?: string;
      artistName?: string;
      artworkUrl100?: string;
    }[];
  }>(`https://itunes.apple.com/search?${q}`, fetchFn);
  const out: Found[] = [];
  for (const r of res?.results ?? []) {
    const title = (book.kind === 'audio' ? r.collectionName : r.trackName) ?? null;
    const art = r.artworkUrl100;
    if (!art || !/\/\d+x\d+bb\.(jpg|png)$/.test(art)) continue;
    const score = matches(book, title, r.artistName ?? null);
    if (score > 0)
      out.push({
        source: 'apple',
        // The same artwork, asked for at a size fit for a cover.
        url: art.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/1000x1000bb.$1'),
        title,
        author: r.artistName ?? null,
        score,
      });
  }
  return out;
}

/**
 * A Google Books volume's front cover, at the largest size Google keeps for
 * it: up to 1200px tall for a book it can preview, 300px wide for one it
 * cannot - never enlarged past what it has.
 */
const googleCover = (id: string) =>
  `https://books.google.com/books/content?id=${encodeURIComponent(id)}&printsec=frontcover&img=1&zoom=1&fife=w800-h1200`;

const GOOGLE_ID = /^[\w-]{6,24}$/;

function googleVolume(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const id = new URL(url).searchParams.get('id');
    return id && GOOGLE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Google Books: the book's own edition by its ISBN, which Google answers
 * without a key, and - when the server has a Google Books API key - a
 * search by title and author as well.
 */
async function google(book: BookFacts, fetchFn: FetchFn, key: string | null): Promise<Found[]> {
  const out: Found[] = [];
  const isbns = isbnsOf(book.identifiers);
  if (isbns.length) {
    const q = new URLSearchParams({
      bibkeys: isbns.map((i) => `ISBN:${i}`).join(','),
      jscmd: 'viewapi',
      callback: 'rp',
    });
    const res = await fetchJsonp<Record<string, { thumbnail_url?: string }>>(
      `https://books.google.com/books?${q}`,
      fetchFn,
    );
    for (const isbn of isbns) {
      const id = googleVolume(res?.[`ISBN:${isbn}`]?.thumbnail_url);
      if (id)
        out.push({
          source: 'google',
          url: googleCover(id),
          title: book.title,
          author: book.author,
          score: 10,
        });
    }
  }
  if (!key) return out;
  const author = searchAuthor(book.author);
  const q = new URLSearchParams({
    q: [`intitle:"${searchTitle(book.title)}"`, author ? `inauthor:"${author}"` : '']
      .filter(Boolean)
      .join(' '),
    maxResults: '8',
    printType: 'books',
    fields: 'items(id,volumeInfo(title,authors,imageLinks/thumbnail))',
    key,
  });
  const res = await fetchJson<{
    items?: {
      id?: string;
      volumeInfo?: { title?: string; authors?: string[]; imageLinks?: { thumbnail?: string } };
    }[];
  }>(`https://www.googleapis.com/books/v1/volumes?${q}`, fetchFn);
  for (const item of res?.items ?? []) {
    // A volume Google has no picture for says so by leaving imageLinks out.
    if (!item.id || !GOOGLE_ID.test(item.id) || !item.volumeInfo?.imageLinks?.thumbnail) continue;
    const title = item.volumeInfo.title ?? null;
    const who = item.volumeInfo.authors?.[0] ?? null;
    const score = matches(book, title, who);
    if (score > 0)
      out.push({ source: 'google', url: googleCover(item.id), title, author: who, score });
  }
  return out;
}

/** Audible's store for a language; English, and every language without a store of its own, the American one. */
const AUDIBLE_HOST: Record<string, string> = {
  de: 'api.audible.de',
  fr: 'api.audible.fr',
  it: 'api.audible.it',
  es: 'api.audible.es',
  ja: 'api.audible.co.jp',
};

const AUDIBLE_ART =
  /^https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%+-]+\._SL\d+_\.(jpg|png)$/;

/** A language's English name, lower case, as Audible writes it: "de" is "german". */
function languageName(code: string | null): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code)?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** Audible's catalogue: audiobook covers as they are sold. Asked for audiobooks only. */
async function audible(book: BookFacts, fetchFn: FetchFn): Promise<Found[]> {
  if (book.kind !== 'audio') return [];
  const author = searchAuthor(book.author);
  const q = new URLSearchParams({
    title: searchTitle(book.title),
    num_results: '10',
    products_sort_by: 'Relevance',
    response_groups: 'media,contributors',
  });
  if (author) q.set('author', author);
  const host = AUDIBLE_HOST[book.language ?? ''] ?? 'api.audible.com';
  const res = await fetchJson<{
    products?: {
      title?: string;
      language?: string;
      authors?: { name?: string }[];
      product_images?: Record<string, string>;
    }[];
  }>(`https://${host}/1.0/catalog/products?${q}`, fetchFn);
  const language = languageName(book.language);
  const out: Found[] = [];
  for (const p of res?.products ?? []) {
    const art = p.product_images?.['500'];
    if (!art || !AUDIBLE_ART.test(art)) continue;
    // Audible names a product's language in English ("german"): a
    // translation's cover is another edition's, not this one's.
    if (language && p.language && p.language.toLowerCase() !== language) continue;
    const title = p.title ?? null;
    const who = p.authors?.[0]?.name ?? null;
    const score = matches(book, title, who);
    if (score > 0)
      out.push({
        source: 'audible',
        // The same picture, asked for at up to 1000px rather than 500.
        url: art.replace(/\._SL\d+_\./, '._SL1000_.'),
        title,
        author: who,
        score,
      });
  }
  return out;
}

/** How well a source's pictures suit a kind of book, beyond how well they matched it. */
const SUITS: Record<BookFacts['kind'], Record<CoverSourceName, number>> = {
  audio: { audible: 0.2, apple: 0.1, google: 0, openlibrary: 0 },
  ebook: { apple: 0.1, google: 0.05, openlibrary: 0.05, audible: 0 },
};

/**
 * The order to offer what was found in: each source's best match first,
 * sources taking turns - the one with the best match leading - so every
 * source that was asked is seen before any is seen twice.
 */
export function inTurns<T extends { source: string; score: number }>(found: T[]): T[] {
  const bySource = new Map<string, T[]>();
  for (const f of [...found].sort((a, b) => b.score - a.score)) {
    const list = bySource.get(f.source) ?? [];
    list.push(f);
    bySource.set(f.source, list);
  }
  const lists = [...bySource.values()];
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++)
    for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

/* ------------------------------------------------------------ candidates */

/** What a book's own cover is: a picture, or the drawing an EPUB may carry instead. */
const ownCoverFacts = (b: Buffer) => imageFacts(b) ?? svgFacts(b);

/** The cover of the book's other format, when it has one of its own: no network needed. */
function editionCandidate(db: DB, bookId: string): Candidate | null {
  const row = db
    .prepare(
      `SELECT b.id, b.title, b.author, b.cover_path, b.found_cover_path FROM pairs p
         JOIN books b ON b.id = CASE WHEN p.ebook_id = ? THEN p.audio_id ELSE p.ebook_id END
        WHERE (p.ebook_id = ? OR p.audio_id = ?) AND p.status IN ('auto','confirmed')
        ORDER BY CASE p.status WHEN 'confirmed' THEN 0 ELSE 1 END LIMIT 1`,
    )
    .get(bookId, bookId, bookId) as
    | {
        id: string;
        title: string;
        author: string | null;
        cover_path: string | null;
        found_cover_path: string | null;
      }
    | undefined;
  if (!row || !hasOwnCover(row)) return null;
  let facts;
  try {
    facts = ownCoverFacts(fs.readFileSync(row.cover_path!));
  } catch {
    return null;
  }
  if (!coverWorthy(facts)) return null;
  return {
    source: 'edition',
    title: row.title,
    author: row.author,
    width: facts.width,
    height: facts.height,
    kind: facts.kind,
    file: row.cover_path!,
  };
}

/**
 * Ask the chosen sources for a book's cover, and keep what they have -
 * checked, and no bigger than it should be - in the book's candidate folder.
 * The best matches first, every source taking its turn; the same picture
 * from two places once.
 */
export async function lookOnline(
  ctx: AppContext,
  bookId: string,
  sources: readonly CoverSourceName[],
  fetchFn: FetchFn = fetch,
): Promise<Candidate[]> {
  const book = bookFacts(ctx.db, bookId);
  if (!book || sources.length === 0) return [];
  const key = ctx.config.googleBooksKey ?? null;
  const asks: Record<CoverSourceName, () => Promise<Found[]>> = {
    apple: () => apple(book, fetchFn),
    audible: () => audible(book, fetchFn),
    google: () => google(book, fetchFn, key),
    openlibrary: () => openLibrary(book, fetchFn),
  };
  const answers = await Promise.allSettled([...new Set(sources)].map((s) => asks[s]()));
  const found = inTurns(
    answers
      .flatMap((a) => (a.status === 'fulfilled' ? a.value : []))
      .map((f) => ({ ...f, score: f.score + SUITS[book.kind][f.source as CoverSourceName] })),
  ).slice(0, MAX_FETCHES);

  const pictures = await Promise.all(
    found.map((f) => fetchAllowed(f.url, MAX_IMAGE_BYTES, 'image/*', fetchFn)),
  );
  const dir = candidateDir(ctx, bookId);
  fs.rmSync(dir, { recursive: true, force: true });
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const [i, f] of found.entries()) {
    const got = pictures[i];
    if (out.length >= MAX_CANDIDATES || !got) continue;
    const facts = imageFacts(got.bytes);
    if (!coverWorthy(facts)) continue;
    // Google answers a volume it has no cover for with a drawn stand-in or
    // a scan of its title page, both PNGs; its real covers are JPEGs.
    if (f.source === 'google' && facts.kind !== 'jpeg') continue;
    const hash = createHash('sha256').update(got.bytes).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${out.length}.${IMAGE_EXT[facts.kind]}`;
    fs.writeFileSync(path.join(dir, file), got.bytes);
    out.push({
      source: f.source,
      title: f.title,
      author: f.author,
      width: facts.width,
      height: facts.height,
      kind: facts.kind,
      file,
    });
  }
  return out;
}

/* --------------------------------------------------------------- storage */

interface LookupRow {
  looked_at: string | null;
  candidates_json: string;
  dismissed_at: string | null;
  looked_sources: string | null;
}

function readLookup(db: DB, bookId: string): LookupRow | null {
  return (
    (db
      .prepare(
        `SELECT looked_at, candidates_json, dismissed_at, looked_sources
           FROM cover_lookups WHERE book_id = ?`,
      )
      .get(bookId) as LookupRow | undefined) ?? null
  );
}

function lookedSources(row: LookupRow | null): string[] {
  try {
    const list = JSON.parse(row?.looked_sources ?? '[]') as unknown;
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}

function storedCandidates(
  ctx: AppContext,
  bookId: string,
  row: LookupRow | null,
  sources: readonly CoverSourceName[],
): Candidate[] {
  if (!row) return [];
  try {
    const list = JSON.parse(row.candidates_json) as Candidate[];
    // A candidate whose picture has gone (the cache was cleared) is no
    // candidate, and neither is one from a source an admin has since turned off.
    return list.filter(
      (c) =>
        (sources as readonly string[]).includes(c.source) &&
        fs.existsSync(path.join(candidateDir(ctx, bookId), c.file)),
    );
  } catch {
    return [];
  }
}

function saveLookup(
  db: DB,
  bookId: string,
  candidates: Candidate[],
  sources: readonly CoverSourceName[],
): void {
  db.prepare(
    `INSERT INTO cover_lookups (book_id, looked_at, candidates_json, looked_sources)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (book_id) DO UPDATE SET looked_at = excluded.looked_at,
         candidates_json = excluded.candidates_json, looked_sources = excluded.looked_sources`,
  ).run(bookId, nowIso(), JSON.stringify(candidates), JSON.stringify(sources));
}

/** Everything on offer for a book, in the order it is shown: its other format's cover, then what was found. */
function offered(
  ctx: AppContext,
  bookId: string,
  row: LookupRow | null,
  sources: readonly CoverSourceName[],
): Candidate[] {
  const local = editionCandidate(ctx.db, bookId);
  return [...(local ? [local] : []), ...storedCandidates(ctx, bookId, row, sources)].slice(
    0,
    MAX_CANDIDATES + 1,
  );
}

export type SuggestionState = 'has-cover' | 'found' | 'none' | 'ask' | 'dismissed';

export interface Suggestions {
  state: SuggestionState;
  candidates: Candidate[];
}

/** One lookup at a time per book: a second page asking while the first is out joins it. */
const inFlight = new Map<string, Promise<Candidate[]>>();

/**
 * What to offer for a book's cover.
 *
 * `look` is a curator asking now; `auto` is an admin having said every book
 * without a cover may be asked about. Without either, a lookup already done
 * is still shown, and a book never looked up says it can be (`ask`).
 * `sources` are the ones an admin chose; with none, nothing is asked.
 */
export async function coverSuggestions(
  ctx: AppContext,
  bookId: string,
  opts: {
    look: boolean;
    auto: boolean;
    sources: readonly CoverSourceName[];
    fetchFn?: FetchFn;
  },
): Promise<Suggestions> {
  const book = bookFacts(ctx.db, bookId);
  if (!book) return { state: 'none', candidates: [] };
  if (hasOwnCover(book)) return { state: 'has-cover', candidates: [] };
  const sources = [...new Set(opts.sources)];
  let row = readLookup(ctx.db, bookId);
  if (row?.dismissed_at && !opts.look) return { state: 'dismissed', candidates: [] };
  // A lookup is still good for a fortnight - unless a source has been turned on since.
  const asked = lookedSources(row);
  const fresh =
    !!row?.looked_at &&
    Date.now() - Date.parse(row.looked_at) < FRESH_MS &&
    sources.every((s) => asked.includes(s));
  if (sources.length > 0 && (opts.look || (opts.auto && !fresh))) {
    let pending = inFlight.get(bookId);
    if (!pending) {
      pending = lookOnline(ctx, bookId, sources, opts.fetchFn).finally(() =>
        inFlight.delete(bookId),
      );
      inFlight.set(bookId, pending);
    }
    const online = await pending;
    saveLookup(ctx.db, bookId, online, sources);
    if (opts.look)
      ctx.db
        .prepare(
          'UPDATE cover_lookups SET dismissed_at = NULL, dismissed_by = NULL WHERE book_id = ?',
        )
        .run(bookId);
    row = readLookup(ctx.db, bookId);
  }
  const candidates = offered(ctx, bookId, row, sources);
  if (candidates.length) return { state: 'found', candidates };
  return { state: row?.looked_at ? 'none' : 'ask', candidates: [] };
}

/** The picture of candidate `n`, as the page was shown it, as a file to send or keep. */
export function candidateFile(
  ctx: AppContext,
  bookId: string,
  n: number,
  sources: readonly CoverSourceName[],
): Candidate | null {
  const c = offered(ctx, bookId, readLookup(ctx.db, bookId), sources)[n];
  if (!c) return null;
  return c.source === 'edition' ? c : { ...c, file: path.join(candidateDir(ctx, bookId), c.file) };
}

/** "Not these": the book is not offered covers again until a curator asks. */
export function dismissSuggestions(db: DB, bookId: string, by: string): void {
  db.prepare(
    `INSERT INTO cover_lookups (book_id, looked_at, candidates_json, dismissed_at, dismissed_by)
       VALUES (?, NULL, '[]', ?, ?)
       ON CONFLICT (book_id) DO UPDATE SET dismissed_at = excluded.dismissed_at,
         dismissed_by = excluded.dismissed_by`,
  ).run(bookId, nowIso(), by);
}

/** The books a cover picked for this one also goes to: its other format, when that has none of its own. */
function coverlessPartners(db: DB, bookId: string): string[] {
  const rows = db
    .prepare(
      `SELECT b.id, b.cover_path, b.found_cover_path FROM pairs p
         JOIN books b ON b.id = CASE WHEN p.ebook_id = ? THEN p.audio_id ELSE p.ebook_id END
        WHERE (p.ebook_id = ? OR p.audio_id = ?) AND p.status IN ('auto','confirmed')`,
    )
    .all(bookId, bookId, bookId) as {
    id: string;
    cover_path: string | null;
    found_cover_path: string | null;
  }[];
  return rows.filter((r) => !hasOwnCover(r)).map((r) => r.id);
}

/** Keep a picture as a book's found cover, and use it while the book has no cover of its own. */
function keepFound(
  ctx: AppContext,
  bookId: string,
  bytes: Buffer,
  kind: ImageKind,
  source: CoverSource,
): void {
  if (!SAFE_ID.test(bookId)) throw new Error('not a book id');
  const dir = foundDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${bookId}.${IMAGE_EXT[kind]}`);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
  const before = ctx.db.prepare('SELECT found_cover_path FROM books WHERE id = ?').get(bookId) as
    { found_cover_path: string | null } | undefined;
  if (before?.found_cover_path && before.found_cover_path !== dest)
    fs.rmSync(before.found_cover_path, { force: true });
  ctx.db
    .prepare(
      `UPDATE books SET found_cover_path = ?, found_cover_source = ?,
         cover_path = CASE WHEN cover_path IS NULL OR cover_path = ? THEN ? ELSE cover_path END
       WHERE id = ?`,
    )
    .run(dest, source, before?.found_cover_path ?? '', dest, bookId);
  // A cover_path still pointing at a file that has gone is no cover either.
  const now = ctx.db.prepare('SELECT cover_path FROM books WHERE id = ?').get(bookId) as {
    cover_path: string | null;
  };
  if (!present(now.cover_path))
    ctx.db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(dest, bookId);
}

/**
 * Use candidate `n` as the book's cover - and its other format's, when that
 * has none of its own either. Returns the books whose cover changed.
 */
export function acceptCandidate(
  ctx: AppContext,
  bookId: string,
  n: number,
  sources: readonly CoverSourceName[],
): string[] {
  const c = candidateFile(ctx, bookId, n, sources);
  if (!c) return [];
  const bytes = fs.readFileSync(c.file);
  // A drawn cover is taken only from the book's other format, never from elsewhere.
  const facts = c.source === 'edition' ? ownCoverFacts(bytes) : imageFacts(bytes);
  if (!coverWorthy(facts)) return [];
  const targets = [bookId, ...coverlessPartners(ctx.db, bookId)];
  for (const id of targets) {
    keepFound(ctx, id, bytes, facts.kind, c.source);
    ctx.db.prepare('DELETE FROM cover_lookups WHERE book_id = ?').run(id);
    fs.rmSync(candidateDir(ctx, id), { recursive: true, force: true });
  }
  return targets;
}

/** Take a found cover off a book: it goes back to having none, and can be offered covers again. */
export function removeFoundCover(ctx: AppContext, bookId: string): boolean {
  const row = ctx.db
    .prepare('SELECT cover_path, found_cover_path FROM books WHERE id = ?')
    .get(bookId) as { cover_path: string | null; found_cover_path: string | null } | undefined;
  if (!row?.found_cover_path) return false;
  fs.rmSync(row.found_cover_path, { force: true });
  ctx.db
    .prepare(
      `UPDATE books SET found_cover_path = NULL, found_cover_source = NULL,
         cover_path = CASE WHEN cover_path = ? THEN NULL ELSE cover_path END
       WHERE id = ?`,
    )
    .run(row.found_cover_path, bookId);
  return true;
}

/* ------------------------------------------------------- the library's own */

/**
 * The folder an ebook sits in, when it is that book's own folder - the one
 * EPUB in it, as Calibre and Calibre-Web lay a library out - and so the
 * `cover.jpg` beside it is its cover. A folder of many EPUBs has no one
 * book's cover in it, and the library's root folder is nobody's.
 */
export function ownFolderOf(rootDir: string, relPath: string): string | null {
  const relDir = path.dirname(relPath);
  if (relDir === '.' || relDir === '') return null;
  let names: string[];
  try {
    names = fs.readdirSync(realResolveWithin(rootDir, relDir));
  } catch {
    return null;
  }
  return names.filter((n) => n.toLowerCase().endsWith('.epub')).length === 1 ? relDir : null;
}

/** A book's found cover, when it has one and the file is still there. */
export function foundCoverOf(db: DB, bookId: string): string | null {
  const row = db.prepare('SELECT found_cover_path FROM books WHERE id = ?').get(bookId) as
    { found_cover_path: string | null } | undefined;
  return present(row?.found_cover_path) ? row!.found_cover_path : null;
}
