import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { recomputeBookLanguage } from '../../library/language.js';

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

describe('facet counts', () => {
  const languages = (res: {
    json: () => { groups: { kind: string; values: { value: string; count: number }[] }[] };
  }) =>
    Object.fromEntries(
      (res.json().groups.find((g) => g.kind === 'language')?.values ?? []).map((v) => [
        v.value,
        v.count,
      ]),
    );
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
