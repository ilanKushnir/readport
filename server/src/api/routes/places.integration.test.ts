import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { segmentSentences } from '../../util/text.js';

/**
 * Reading places through the API: a reader's progress as it arrives, read
 * back as the place they read and the place they went on to, each known by
 * its chapter and its words. The book and its prose are invented.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-places-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: tmp,
    cacheDir: tmp,
    sessionSecret: 'places-test-secret-0123456789abcdef',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});
type Method = 'GET' | 'POST' | 'DELETE';
const as = (user: string, url: string, method: Method = 'GET', payload?: unknown) =>
  app.inject({
    url,
    method,
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': user, 'x-rp-csrf': '1' },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

const BOOK = 'salt-clock';
const LINES = [
  'The tide came in twice that day, and nobody on the quay could say why.',
  'Marit counted the bells from the chapel and wrote each one in the margin.',
  'By evening the clock in the harbour office had stopped at a quarter past four.',
  'She wound it anyway, because winding it was what the keepers had always done.',
];
/** Two long chapters, so a jump between them is a jump and not a page turn. */
const CHAPTERS = [0, 1].map((c) => {
  let text = '';
  for (let i = 0; text.length < 60_000; i++) text += `${LINES[(i + c) % LINES.length]} `;
  return `${text.trim()}\n`;
});
const TOTAL = CHAPTERS.reduce((n, t) => n + t.length, 0);

function writeBook() {
  const dir = path.join(tmp, 'derived', BOOK);
  fs.mkdirSync(dir, { recursive: true });
  let cum = 0;
  const chapters = CHAPTERS.map((text, idx) => {
    fs.writeFileSync(path.join(dir, `text_${idx}.txt`), text);
    const sentences = segmentSentences(text, 'en', idx);
    const ch = {
      idx,
      href: `ch${idx}.xhtml`,
      title: null,
      charCount: text.length,
      sentenceCount: sentences.length,
      cumChars: cum,
    };
    cum += text.length;
    return { ch, sentences };
  });
  fs.writeFileSync(
    path.join(dir, 'book.json'),
    JSON.stringify({
      bookId: BOOK,
      title: 'The Salt Clock',
      author: 'Ines Varga',
      language: 'en',
      direction: 'ltr',
      totalChars: TOTAL,
      chapters: chapters.map((c) => c.ch),
      toc: [
        { title: 'Low Water', spineIdx: 0, fragment: null, depth: 0 },
        { title: 'The Second Tide', spineIdx: 1, fragment: null, depth: 0 },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'sentences.json'),
    JSON.stringify(
      chapters.map((c) =>
        c.sentences.map((s) => ({ id: s.id, ord: s.ord, start: s.start, end: s.end })),
      ),
    ),
  );
}

/** A reading session on one device: each checkpoint a minute after the last. */
function session(user: string, startMs: number) {
  const sessionId = randomUUID();
  let seq = 0;
  let at = startMs;
  return async (intent: 'open' | 'heartbeat' | 'seek', spineIdx: number, charOffset: number) => {
    at += 60_000;
    seq += 1;
    const pct = (spineIdx * CHAPTERS[0]!.length + charOffset) / TOTAL;
    const res = await as(user, '/api/progress/events', 'POST', {
      events: [
        {
          eventId: randomUUID(),
          bookId: BOOK,
          deviceId: 'phone-1',
          sessionId,
          seq,
          occurredAt: new Date(at).toISOString(),
          intent,
          locator: { medium: 'ebook', spineIdx, charOffset, pct },
        },
      ],
    });
    expect(res.json().results[0].status).toBe('applied');
  };
}

type Place = {
  id: string;
  main: boolean;
  current: boolean;
  chapter: string | null;
  excerpt: string | null;
  readMs: number;
  locator: { spineIdx: number; charOffset: number };
};
const placesOf = async (user: string) =>
  (await as(user, `/api/books/${BOOK}/places`)).json().places as Place[];

beforeAll(async () => {
  await app.ready();
  writeBook();
  db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, author, size_bytes,
       scan_state, added_at, meta_json)
     VALUES (?, 'ebook', '/lib', 'salt-clock.epub', 'epub', 'The Salt Clock', 'Ines Varga', 1,
       'ready', ?, ?)`,
  ).run(BOOK, new Date().toISOString(), JSON.stringify({ totalChars: TOTAL }));
  await as('dana', '/api/auth/me');
  await as('astra', '/api/auth/me');
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a reader’s places in a book', () => {
  it('start with where they read on from the beginning', async () => {
    const read = session('dana', Date.now() - 3 * 3_600_000);
    await read('open', 0, 0);
    for (let off = 800; off <= 8_000; off += 800) await read('heartbeat', 0, off);
    const places = await placesOf('dana');
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ main: true, current: true, chapter: 'Low Water' });
    expect(places[0]!.locator.charOffset).toBe(8_000);
    expect(places[0]!.readMs).toBe(10 * 60_000);
    // Known by its words: the sentence it stopped in.
    expect(LINES.some((line) => places[0]!.excerpt?.startsWith(line.slice(0, 20)))).toBe(true);
  });

  it('keep that place when the reader goes on to read somewhere else', async () => {
    const read = session('dana', Date.now() - 2 * 3_600_000);
    await read('seek', 1, 20_000);
    for (let off = 20_800; off <= 23_200; off += 800) await read('heartbeat', 1, off);
    const places = await placesOf('dana');
    expect(places.map((p) => [p.main, p.current, p.chapter])).toEqual([
      [true, false, 'Low Water'],
      [false, true, 'The Second Tide'],
    ]);
  });

  it('are one person’s own', async () => {
    expect(await placesOf('astra')).toEqual([]);
  });

  it('can be forgotten, one at a time', async () => {
    const side = (await placesOf('dana')).find((p) => !p.main)!;
    const res = await as('dana', `/api/books/${BOOK}/places/${side.id}`, 'DELETE');
    expect(res.statusCode).toBe(200);
    expect(res.json().places).toHaveLength(1);
    expect((await as('dana', `/api/books/${BOOK}/places/${side.id}`, 'DELETE')).statusCode).toBe(
      404,
    );
  });

  it('are gone when the reader starts the book over', async () => {
    await as('dana', `/api/progress/${BOOK}`, 'DELETE');
    expect(await placesOf('dana')).toEqual([]);
  });

  it('never stop progress for a book the library no longer has', async () => {
    const res = await as('dana', '/api/progress/events', 'POST', {
      events: [
        {
          eventId: randomUUID(),
          bookId: 'removed-from-library',
          deviceId: 'phone-1',
          sessionId: randomUUID(),
          seq: 1,
          occurredAt: new Date(Date.now() - 60_000).toISOString(),
          intent: 'open',
          locator: { medium: 'ebook', spineIdx: 0, charOffset: 10, pct: 0.01 },
        },
      ],
    });
    expect(res.json().results[0].status).toBe('applied');
  });

  it('are asked of a book that exists', async () => {
    expect((await as('dana', '/api/books/no-such-book/places')).statusCode).toBe(404);
  });
});
