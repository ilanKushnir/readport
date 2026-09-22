import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { writeFacets } from '../../library/facets.js';
import { recomputeBookLanguage } from '../../library/language.js';
import { LANGUAGE_BACKFILL_JOB } from '../../library/redetect.js';

/**
 * The library seen through its languages: a French audiobook paired with an
 * English ebook is a French audiobook, whatever card the open shelf shows;
 * a book with no language is browsable as Unknown; several languages are
 * one question; and the counts beside the sidebar describe the view in
 * front of the reader.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-library-language-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: tmp,
    cacheDir: tmp,
    sessionSecret: 'library-language-test-secret-0123456789',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});
const request = (url: string, method: 'GET' | 'POST' = 'GET', payload?: unknown, user = 'admin') =>
  app.inject({
    url,
    method,
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': user, 'x-rp-csrf': '1' },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const ids = (res: { json: () => { books: { id: string }[] } }) =>
  res
    .json()
    .books.map((b) => b.id)
    .sort();

beforeAll(async () => {
  await app.ready();
  const add = (id: string, kind: 'ebook' | 'audio', metadata: string | null, title = id) => {
    db.prepare(
      `INSERT INTO books (id,kind,root_dir,rel_path,format,title,scan_state,added_at,language_metadata)
       VALUES (?,?,?,?,?,?,'ready',?,?)`,
    ).run(
      id,
      kind,
      tmp,
      id,
      kind === 'ebook' ? 'epub' : 'mp3',
      title,
      new Date().toISOString(),
      metadata,
    );
    recomputeBookLanguage(db, id);
  };
  add('en-ebook', 'ebook', 'en', 'The Lantern');
  add('fr-audio', 'audio', 'fr', 'La Lanterne');
  add('de-ebook', 'ebook', 'de', 'Die Laterne');
  add('untagged', 'ebook', null, 'Mystery');
  // Genres, so that a count beside another grouping can be seen to follow
  // the language chips while the languages themselves do not.
  writeFacets(db, 'en-ebook', [{ kind: 'genre', value: 'Sea' }]);
  writeFacets(db, 'fr-audio', [{ kind: 'genre', value: 'Sea' }]);
  writeFacets(db, 'de-ebook', [{ kind: 'genre', value: 'Land' }]);
  db.prepare(
    "INSERT INTO pairs (id,ebook_id,audio_id,status,score,created_at) VALUES ('pair','en-ebook','fr-audio','confirmed',1,?)",
  ).run(new Date().toISOString());
  // The first user through the proxy is the admin; everyone after is a reader.
  await request('/api/auth/me');
  await request('/api/auth/me', 'GET', undefined, 'reader');
});
afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('browsing by language', () => {
  it('the open shelf collapses the pair to the ebook, and the French audiobook is still under French', async () => {
    expect(ids(await request('/api/library'))).toEqual(['de-ebook', 'en-ebook', 'untagged']);
    expect(ids(await request('/api/library?facet=language:fr'))).toEqual(['fr-audio']);
    expect(ids(await request('/api/library?facet=language:en'))).toEqual(['en-ebook']);
  });
  it('several languages are one question, and Unknown is a language to ask about', async () => {
    expect(ids(await request('/api/library?facet=language:fr%2Bde'))).toEqual([
      'de-ebook',
      'fr-audio',
    ]);
    expect(ids(await request('/api/library?facet=language:unknown'))).toEqual(['untagged']);
    expect(ids(await request('/api/library?facet=language:de%2Bunknown'))).toEqual([
      'de-ebook',
      'untagged',
    ]);
  });
  it('a shelf whose members are chosen elsewhere can ask for both halves of a pair', async () => {
    expect(ids(await request('/api/library?collapse=none'))).toEqual([
      'de-ebook',
      'en-ebook',
      'fr-audio',
      'untagged',
    ]);
  });
});

describe('the language chips: several languages at once, composable with everything', () => {
  it('keep the books in the listed languages, by effective language, Unknown included', async () => {
    expect(ids(await request('/api/library?lang=fr,de'))).toEqual(['de-ebook', 'fr-audio']);
    expect(ids(await request('/api/library?lang=unknown'))).toEqual(['untagged']);
    expect(ids(await request('/api/library?lang=de,unknown'))).toEqual(['de-ebook', 'untagged']);
    // The French audiobook is half of a pair whose surviving card is the
    // English ebook: asked for French, the audiobook itself is the answer.
    expect(ids(await request('/api/library?lang=fr'))).toEqual(['fr-audio']);
  });
  it('compose with the format, the search and a facet', async () => {
    expect(ids(await request('/api/library?lang=en,fr&kind=audio'))).toEqual(['fr-audio']);
    expect(ids(await request('/api/library?lang=en,fr&kind=ebook'))).toEqual(['en-ebook']);
    expect(ids(await request('/api/library?lang=de,en&query=laterne'))).toEqual(['de-ebook']);
    expect(ids(await request('/api/library?lang=de,en&facet=genre:sea'))).toEqual(['en-ebook']);
  });
  it('accept any spelling a tag might use, and ignore what is not a language', async () => {
    expect(ids(await request('/api/library?lang=eng'))).toEqual(['en-ebook']);
    expect(ids(await request('/api/library?lang=DE-de,%20fr'))).toEqual(['de-ebook', 'fr-audio']);
    // Nothing usable is no narrowing, not an empty shelf.
    expect(ids(await request('/api/library?lang=,x1,'))).toEqual([
      'de-ebook',
      'en-ebook',
      'untagged',
    ]);
    expect(ids(await request('/api/library?lang=xx'))).toEqual([]);
  });
});

describe('facet counts', () => {
  const groupCounts = (
    res: {
      json: () => { groups: { kind: string; values: { value: string; count: number }[] }[] };
    },
    kind: string,
  ) =>
    Object.fromEntries(
      (res.json().groups.find((g) => g.kind === kind)?.values ?? []).map((v) => [
        v.value.toLowerCase(),
        v.count,
      ]),
    );
  const languages = (res: Parameters<typeof groupCounts>[0]) => groupCounts(res, 'language');
  it('count editions for the whole library, Unknown included', async () => {
    expect(languages(await request('/api/facets'))).toEqual({ de: 1, en: 1, fr: 1, unknown: 1 });
  });
  it('describe the view in front of the reader when told what it is', async () => {
    expect(languages(await request('/api/facets?kind=audio'))).toEqual({ fr: 1 });
    expect(languages(await request('/api/facets?query=laterne'))).toEqual({ de: 1 });
    expect(languages(await request('/api/facets?ids=fr-audio,untagged'))).toEqual({
      fr: 1,
      unknown: 1,
    });
  });
  it('follow the language chips everywhere except in the languages themselves', async () => {
    // Every other count describes the narrowed view; the language counts
    // say what tapping another chip would add, so they ignore the chips.
    const narrowed = await request('/api/facets?lang=fr');
    expect(groupCounts(narrowed, 'genre')).toEqual({ sea: 1 });
    expect(languages(narrowed)).toEqual({ de: 1, en: 1, fr: 1, unknown: 1 });
    const two = await request('/api/facets?lang=de,unknown');
    expect(groupCounts(two, 'genre')).toEqual({ land: 1 });
    expect(languages(two)).toEqual({ de: 1, en: 1, fr: 1, unknown: 1 });
    // And the chips compose with the rest of the view for both.
    const audio = await request('/api/facets?lang=fr,en&kind=audio');
    expect(groupCounts(audio, 'genre')).toEqual({ sea: 1 });
    expect(languages(audio)).toEqual({ fr: 1 });
  });
});

describe('on startup', () => {
  it('queues one re-read of the books the current detector has not seen, and only one', () => {
    const jobs = db.prepare(`SELECT state FROM jobs WHERE type = ?`).all(LANGUAGE_BACKFILL_JOB) as {
      state: string;
    }[];
    expect(jobs).toEqual([{ state: 'queued' }]);
  });
});

describe("a curator's word", () => {
  it('sets the language, names the source, reaches the paired edition, and survives', async () => {
    const before = (await request('/api/books/fr-audio')).json().book;
    expect(before).toMatchObject({ language: 'fr', languageSource: 'metadata' });
    const res = await request('/api/books/en-ebook/language', 'POST', { language: 'he' });
    expect(res.statusCode).toBe(200);
    expect(res.json().book).toMatchObject({ language: 'he', languageSource: 'manual' });
    // The audiobook has its own tag, so it keeps it; an untagged one would follow.
    expect((await request('/api/books/fr-audio')).json().book.language).toBe('fr');
    expect(ids(await request('/api/library?facet=language:he'))).toEqual(['en-ebook']);
    const cleared = await request('/api/books/en-ebook/language', 'POST', { language: null });
    expect(cleared.json().book).toMatchObject({ language: 'en', languageSource: 'metadata' });
  });
  it("is a curator's word, not a reader's, and must be a language", async () => {
    expect(
      (await request('/api/books/en-ebook/language', 'POST', { language: 'de' }, 'reader'))
        .statusCode,
    ).toBe(403);
    expect(
      (await request('/api/books/en-ebook/language', 'POST', { language: 'klingon' })).statusCode,
    ).toBe(400);
    expect((await request('/api/books/nope/language', 'POST', { language: 'de' })).statusCode).toBe(
      404,
    );
  });
});
