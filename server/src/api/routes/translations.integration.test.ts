import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { segmentSentences } from '../../util/text.js';
import { matchEditions } from '../../translations/store.js';
import { type AppContext } from '../../context.js';

/**
 * The same book in other languages, through the API: linking (a curator's
 * job), what a book page is told, carrying a place and a passage across,
 * and a friend reading the translation turning up in the original.
 *
 * Every book here is invented, and so is its "Russian": the texts are words
 * repeated to a length, which is all the aligner reads.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-translations-'));
const db = openMemoryDatabase();
const config = loadConfig({
  dataDir: tmp,
  cacheDir: tmp,
  sessionSecret: 'translations-test-secret-0123456789',
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
const idOf = (username: string) =>
  (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string }).id;
const now = new Date().toISOString();

const EN_WORDS = ['lantern', 'harbor', 'fog', 'ledger', 'keeper', 'tide', 'gull', 'stair'];
const RU_WORDS = ['фонарь', 'гавань', 'туман', 'журнал', 'смотритель', 'прилив', 'чайка'];
const DE_WORDS = ['Laterne', 'Hafen', 'Nebel', 'Buch', 'Wärter', 'Flut', 'Möwe'];

function prose(words: string[], length: number, seed: number): string {
  let out = '';
  let i = seed;
  while (out.length < length) out += (out ? ' ' : '') + words[i++ % words.length];
  return `${out.charAt(0).toUpperCase()}${out.slice(1)}.`;
}

/** Paragraph lengths of the English book: three chapters, uneven paragraphs. */
const SHAPE = [
  [60, 420, 180, 610, 240, 90],
  [300, 150, 520, 80, 390],
  [210, 460, 130, 340, 270, 500, 60],
];

/** Write a book's extracted text the way indexing leaves it (legacy unversioned layout). */
function writeText(bookId: string, language: string, words: string[], stretch: number) {
  const dir = path.join(tmp, 'derived', bookId);
  fs.mkdirSync(dir, { recursive: true });
  let cum = 0;
  const chapters = SHAPE.map((lens, idx) => {
    const text =
      lens
        .map((len, k) =>
          prose(words, Math.round(len * stretch * (1 + ((k % 3) - 1) / 20)), k + idx),
        )
        .join('\n') + '\n';
    fs.writeFileSync(path.join(dir, `text_${idx}.txt`), text);
    const sentences = segmentSentences(text, language, idx);
    const ch = {
      idx,
      href: `ch${idx}.xhtml`,
      title: null,
      charCount: text.length,
      sentenceCount: sentences.length,
      cumChars: cum,
      sentences,
    };
    cum += text.length;
    return ch;
  });
  fs.writeFileSync(
    path.join(dir, 'book.json'),
    JSON.stringify({
      bookId,
      title: bookId,
      author: null,
      language,
      direction: 'ltr',
      totalChars: cum,
      chapters: chapters.map(({ sentences: _s, ...c }) => c),
      toc: [],
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
  return { totalChars: cum, chapters };
}

const texts: Record<string, ReturnType<typeof writeText>> = {};

beforeAll(async () => {
  await app.ready();
  const add = (
    id: string,
    kind: 'ebook' | 'audio',
    title: string,
    author: string,
    language: string,
    totalChars?: number,
  ) =>
    db
      .prepare(
        `INSERT INTO books (id,kind,root_dir,rel_path,format,title,author,language,scan_state,meta_json,added_at,scanned_at)
         VALUES (?,?,?,?,?,?,?,?,'ready',?,?,?)`,
      )
      .run(
        id,
        kind,
        tmp,
        id,
        kind === 'ebook' ? 'epub' : 'm4b',
        title,
        author,
        language,
        JSON.stringify(totalChars ? { totalChars } : {}),
        now,
        now,
      );
  texts.en = writeText('en-ebook', 'en', EN_WORDS, 1);
  texts.ru = writeText('ru-ebook', 'ru', RU_WORDS, 1.08);
  texts.de = writeText('de-ebook', 'de', DE_WORDS, 1.14);
  add('en-ebook', 'ebook', 'The Lantern of Ash Harbor', 'Rivka Sharon', 'en', texts.en.totalChars);
  add('en-audio', 'audio', 'The Lantern of Ash Harbor', 'Rivka Sharon', 'en');
  add('ru-ebook', 'ebook', 'Фонарь Пепельной гавани', 'Ривка Шарон', 'ru', texts.ru.totalChars);
  add('de-ebook', 'ebook', 'Die Laterne von Aschehafen', 'Rivka Sharon', 'de', texts.de.totalChars);
  add('he-ebook', 'ebook', 'הפנס של נמל האפר', 'רבקה שרון', 'he', texts.en.totalChars);
  add('other-en', 'ebook', 'Saltmarsh Evenings', 'Oswin Pell', 'en', 90_000);
  db.prepare(
    "INSERT INTO pairs (id,ebook_id,audio_id,status,score,created_at) VALUES ('p-en','en-ebook','en-audio','confirmed',1,?)",
  ).run(now);
  const chapter = db.prepare(
    'INSERT INTO chapters (book_id, idx, title, spine_idx, href) VALUES (?, ?, ?, ?, ?)',
  );
  const titles: Record<string, string[]> = {
    'en-ebook': ["The Keeper's Ledger", 'Fog Signals', 'First Light'],
    'ru-ebook': ['Журнал смотрителя', 'Туманные сигналы', 'Первый свет'],
    'de-ebook': ['Das Buch des Wärters', 'Nebelsignale', 'Erstes Licht'],
    'he-ebook': ['יומן השומר', 'אותות ערפל', 'אור ראשון'],
  };
  for (const [book, names] of Object.entries(titles))
    names.forEach((t, i) => chapter.run(book, i, t, i, `ch${i}.xhtml`));
  db.prepare("UPDATE books SET hidden_at = ? WHERE id = 'he-ebook'").run(now);

  // First through the proxy is the admin; then readers and a curator.
  await as('astra', '/api/auth/me');
  await as('dana', '/api/auth/me');
  await as('mira', '/api/auth/me');
  await as('cyd', '/api/auth/me');
  db.prepare("UPDATE users SET role = 'curator' WHERE username = 'cyd'").run();
  db.prepare(
    "INSERT INTO friendships (id,requester_id,addressee_id,status,created_at,responded_at) VALUES ('f1',?,?,'accepted',?,?)",
  ).run(idOf('dana'), idOf('mira'), now, now);
});

afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Where the k-th paragraph of a chapter starts in a written book. */
function paragraphStart(which: 'en' | 'ru' | 'de', spine: number, k: number): number {
  const text = fs.readFileSync(
    path.join(tmp, 'derived', `${which}-ebook`, `text_${spine}.txt`),
    'utf8',
  );
  return text.split('\n').slice(0, k).join('\n').length + (k > 0 ? 1 : 0);
}

describe('linking the same book in other languages', () => {
  it('guesses translations for a curator, and nothing for a reader', async () => {
    const reader = (await as('dana', '/api/books/en-ebook/translations')).json();
    expect(reader).toEqual({ titles: [], suggestions: [], canLink: false });
    const curator = (await as('cyd', '/api/books/en-ebook/translations')).json();
    expect(curator.canLink).toBe(true);
    const guessed = curator.suggestions.map((s: { books: { id: string }[] }) => s.books[0]!.id);
    expect(guessed).toEqual(expect.arrayContaining(['ru-ebook', 'de-ebook']));
    expect(guessed).not.toContain('other-en');
    // A curator is not an admin: the hidden Hebrew edition is no guess of theirs.
    expect(guessed).not.toContain('he-ebook');
    const ru = curator.suggestions.find((s: { language: string }) => s.language === 'ru');
    expect(ru.evidence).toMatchObject({ author: true, length: true, chapters: true });
  });

  it('is a curator’s to do', async () => {
    const res = await as('dana', '/api/books/en-ebook/translations', 'POST', {
      otherBookId: 'ru-ebook',
    });
    expect(res.statusCode).toBe(403);
  });

  it('links two books, queues their paragraphs to be matched, and names the other on both', async () => {
    const res = await as('cyd', '/api/books/en-ebook/translations', 'POST', {
      otherBookId: 'ru-ebook',
    });
    expect(res.statusCode).toBe(200);
    const titles = res.json().titles;
    expect(titles).toHaveLength(1);
    expect(titles[0]).toMatchObject({
      language: 'ru',
      title: 'Фонарь Пепельной гавани',
      books: [{ id: 'ru-ebook', kind: 'ebook' }],
      progress: null,
      match: 'pending',
    });
    const job = db
      .prepare(
        "SELECT payload_json FROM jobs WHERE type = 'translation-align' AND state = 'queued'",
      )
      .get() as { payload_json: string };
    expect(JSON.parse(job.payload_json)).toEqual({ a: 'en-ebook', b: 'ru-ebook' });
    // The Russian book's page names the English title - both its formats.
    const back = (await as('dana', '/api/books/ru-ebook')).json().translations;
    expect(back[0]).toMatchObject({
      language: 'en',
      books: [
        { id: 'en-ebook', kind: 'ebook' },
        { id: 'en-audio', kind: 'audio' },
      ],
    });
    // And the English audiobook's page names the Russian: a title's formats come along.
    const audio = (await as('dana', '/api/books/en-audio')).json().translations;
    expect(audio.map((t: { language: string }) => t.language)).toEqual(['ru']);
  });

  it('refuses a book in the same language, or the book itself in another format', async () => {
    const same = await as('cyd', '/api/books/en-ebook/translations', 'POST', {
      otherBookId: 'other-en',
    });
    expect(same.statusCode).toBe(409);
    expect(same.json().error).toBe('same-language');
    const own = await as('cyd', '/api/books/en-ebook/translations', 'POST', {
      otherBookId: 'en-audio',
    });
    expect(own.json().error).toBe('same-title');
  });

  it('makes a work of three when a third language is linked to either of two', async () => {
    await as('cyd', '/api/books/ru-ebook/translations', 'POST', { otherBookId: 'de-ebook' });
    const titles = (await as('dana', '/api/books/en-ebook')).json().translations;
    expect(titles.map((t: { language: string }) => t.language)).toEqual(['de', 'ru']);
  });

  it('keeps a hidden edition from anyone who may not see it', async () => {
    expect(
      (await as('cyd', '/api/books/en-ebook/translations', 'POST', { otherBookId: 'he-ebook' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await as('astra', '/api/books/en-ebook/translations', 'POST', { otherBookId: 'he-ebook' }))
        .statusCode,
    ).toBe(200);
    const reader = (await as('dana', '/api/books/en-ebook')).json().translations;
    expect(reader.map((t: { language: string }) => t.language)).toEqual(['de', 'ru']);
    const admin = (await as('astra', '/api/books/en-ebook')).json().translations;
    expect(admin.map((t: { language: string }) => t.language)).toEqual(['de', 'he', 'ru']);
    // Nor can a reader carry a place into it.
    const map = await as('dana', '/api/books/en-ebook/translations/map', 'POST', {
      from: { medium: 'ebook', spineIdx: 0, charOffset: 0, pct: 0 },
      toBookId: 'he-ebook',
    });
    expect(map.statusCode).toBe(404);
  });
});

describe('carrying places across', () => {
  beforeAll(async () => {
    await matchEditions(ctx, 'en-ebook', 'ru-ebook');
  });

  it('says how closely the two are matched once the job has run', async () => {
    const ru = (await as('dana', '/api/books/en-ebook'))
      .json()
      .translations.find((t: { language: string }) => t.language === 'ru');
    expect(ru.match).toBe('close');
  });

  it('carries a place to the start of the matching paragraph', async () => {
    const at = paragraphStart('en', 1, 2) + 40;
    const res = await as('dana', '/api/books/en-ebook/translations/map', 'POST', {
      from: { medium: 'ebook', spineIdx: 1, charOffset: at, pct: 0.4 },
      toBookId: 'ru-ebook',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      bookId: 'ru-ebook',
      precision: 'paragraph',
      to: { medium: 'ebook', spineIdx: 1, charOffset: paragraphStart('ru', 1, 2) },
    });
    // Only across a link: this is no way to find places in any book.
    const notLinked = await as('dana', '/api/books/en-ebook/translations/map', 'POST', {
      from: { medium: 'ebook', spineIdx: 0, charOffset: 0, pct: 0 },
      toBookId: 'other-en',
    });
    expect(notLinked.statusCode).toBe(409);
  });

  it('falls back to the same share of the way through where there is no match yet', async () => {
    const res = await as('dana', '/api/books/en-ebook/translations/map', 'POST', {
      from: { medium: 'ebook', spineIdx: 2, charOffset: 10, pct: 0.8 },
      toBookId: 'de-ebook',
    });
    expect(res.json().precision).toBe('proportional');
    expect(res.json().to.pct).toBeCloseTo(0.8, 1);
  });

  it('hands back a passage in the other language, and what it matched', async () => {
    const start = paragraphStart('en', 0, 3);
    const res = await as(
      'dana',
      `/api/books/en-ebook/translations/passage?to=ru-ebook&spine=0&start=${start + 5}&end=${start + 20}`,
    );
    expect(res.statusCode).toBe(200);
    const passage = res.json();
    const ruText = fs.readFileSync(path.join(tmp, 'derived', 'ru-ebook', 'text_0.txt'), 'utf8');
    expect(passage.paragraphs).toEqual([ruText.split('\n')[3]]);
    expect(passage.language).toBe('ru');
    const enLine = fs
      .readFileSync(path.join(tmp, 'derived', 'en-ebook', 'text_0.txt'), 'utf8')
      .split('\n')[3]!;
    expect(passage.source).toEqual({ spineIdx: 0, start, end: start + enLine.length });
    expect(passage.to).toMatchObject({ spineIdx: 0, charOffset: paragraphStart('ru', 0, 3) });
  });

  it('shows a friend reading the translation in the original, at the matching place', async () => {
    const at = paragraphStart('ru', 2, 3) + 10;
    const ru = texts.ru!;
    db.prepare(
      `INSERT INTO progress_state (user_id, book_id, revision, locator_json, intent, occurred_at, session_uuid, device_id, seq, finished, updated_at)
       VALUES (?, 'ru-ebook', 1, ?, 'heartbeat', ?, 's', 'd', 1, 0, ?)`,
    ).run(
      idOf('mira'),
      JSON.stringify({
        medium: 'ebook',
        spineIdx: 2,
        charOffset: at,
        pct: (ru.chapters[2]!.cumChars + at) / ru.totalChars,
      }),
      now,
      now,
    );
    const friends = (await as('dana', '/api/friends/progress?bookId=en-ebook')).json().friends;
    expect(friends).toHaveLength(1);
    const mira = friends[0];
    expect(mira.edition).toEqual({
      bookId: 'ru-ebook',
      language: 'ru',
      title: 'Фонарь Пепельной гавани',
    });
    // Named as the English book names its chapter, at the English paragraph.
    expect(mira.chapterTitle).toBe('First Light');
    const en = texts.en!;
    const lo = (en.chapters[2]!.cumChars + paragraphStart('en', 2, 3)) / en.totalChars;
    const hi = (en.chapters[2]!.cumChars + paragraphStart('en', 2, 4)) / en.totalChars;
    expect(mira.pct).toBeGreaterThanOrEqual(lo);
    expect(mira.pct).toBeLessThan(hi);
    // On the audiobook's page too: the same work.
    const onAudio = (await as('dana', '/api/friends/progress?bookId=en-audio')).json().friends;
    expect(onAudio[0].edition.language).toBe('ru');
  });
});

describe('unlinking and saying no', () => {
  it('takes a title out, and does not suggest it again', async () => {
    const res = await as('cyd', '/api/books/en-ebook/translations/de-ebook', 'DELETE');
    expect(res.statusCode).toBe(200);
    expect(res.json().titles.map((t: { language: string }) => t.language)).toEqual(['ru']);
    const again = (await as('cyd', '/api/books/en-ebook/translations')).json().suggestions;
    expect(again.map((s: { language: string }) => s.language)).not.toContain('de');
    // Linking it again is still allowed - a curator may change their mind.
    const relink = await as('cyd', '/api/books/en-ebook/translations', 'POST', {
      otherBookId: 'de-ebook',
    });
    expect(relink.json().titles.map((t: { language: string }) => t.language)).toEqual(['de', 'ru']);
  });

  it('lists every guess in the library for a curator, and refuses a reader', async () => {
    expect((await as('dana', '/api/translations/suggestions')).statusCode).toBe(403);
    const res = await as('cyd', '/api/translations/suggestions');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().suggestions)).toBe(true);
  });
});
