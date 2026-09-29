import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type NotesExportDocument, type NotesExportResult } from '@readport/shared';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';

/**
 * A book's highlights and notes typeset as a PDF: the document the app
 * writes, set in type with the book's cover, and the first pages drawn for
 * the preview. The book, its words and its reader are invented.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-notes-export-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: tmp,
    cacheDir: tmp,
    sessionSecret: 'notes-export-test-secret-0123456789ab',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});
const post = (url: string, payload: unknown, user: string | null = 'astra') =>
  app.inject({
    url,
    method: 'POST',
    remoteAddress: '10.0.0.5',
    headers: { ...(user ? { 'x-rp-test-user': user } : {}), 'x-rp-csrf': '1' },
    payload: payload as never,
  });

const PASSAGES = [
  'The ferry left at dawn with nobody aboard but the cook, who swore the fog had eaten the timetable.',
  'Every lamp on the pier was lit that night, though the lamplighter had been dead for a year.',
  'Nell kept the keys in a tin that had once held peppermints, and the tin still smelled of them.',
];

function documentOf(overrides: Partial<NotesExportDocument> = {}): NotesExportDocument {
  const chapter = (head: string, n: number) => ({
    kind: 'chapter' as const,
    head,
    dir: 'ltr' as const,
    color: null,
    count: `${n} highlights`,
    marks: Array.from({ length: n }, (_, i) => ({
      kind: 'highlight' as const,
      color: (['amber', 'sky', 'plum'] as const)[i % 3],
      text: PASSAGES[i % PASSAGES.length]!,
      note: i % 4 === 1 ? 'Read this one aloud to Tomas. 🌊' : null,
      where: `${10 + i}% · 3 Sept 2026`,
      dir: 'ltr' as const,
      noteDir: 'ltr' as const,
    })),
  });
  return {
    look: 'night',
    page: 'a4',
    text: 'comfortable',
    lang: 'en',
    dir: 'ltr',
    bookLang: 'en',
    title: 'The Lamplighter of Varrow Pier',
    titleDir: 'ltr',
    author: 'Odile Marsk',
    cover: true,
    reader: 'Astra Vell',
    contents: true,
    labels: {
      app: 'ReadPort',
      heading: 'Highlights & notes',
      contents: 'Contents',
      note: 'Note',
      bookmark: 'Bookmark',
      marked: 'A marked passage',
      empty: 'Nothing to export with these filters.',
      reader: 'Marked by Astra Vell',
      stamp: 'Exported from ReadPort · 29 September 2026',
      closing: 'Kept from reading The Lamplighter of Varrow Pier',
    },
    figures: [{ n: '40', label: 'highlights' }],
    scope: [],
    legend: [
      { color: 'amber', label: 'Amber' },
      { color: 'plum', label: 'Plum' },
      { color: 'sky', label: 'Sky' },
    ],
    sections: [
      chapter('The Ferry', 10),
      chapter('Lamps on the Pier', 10),
      chapter('Peppermint Tin', 10),
      chapter('Low Tide', 10),
    ],
    ...overrides,
  };
}

const COVER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#1f3b36"/><circle cx="200" cy="260" r="90" fill="#d9a53c"/></svg>';

beforeAll(async () => {
  await app.ready();
  fs.writeFileSync(path.join(tmp, 'cover.svg'), COVER);
  const add = db.prepare(
    `INSERT INTO books (id,kind,root_dir,rel_path,format,title,author,cover_path,scan_state,added_at)
     VALUES (?,'ebook',?,?,'epub',?,?,?,'ready',?)`,
  );
  const now = new Date().toISOString();
  add.run(
    'varrow',
    tmp,
    'varrow.epub',
    'The Lamplighter of Varrow Pier',
    'Odile Marsk',
    path.join(tmp, 'cover.svg'),
    now,
  );
  add.run('bare', tmp, 'bare.epub', 'A Book Without a Cover', null, null, now);
  add.run(
    'broken',
    tmp,
    'broken.epub',
    'A Book With a Broken Cover',
    null,
    path.join(tmp, 'nothing.jpg'),
    now,
  );
  fs.writeFileSync(path.join(tmp, 'nothing.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]));
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('POST /api/books/:id/notes/export', () => {
  it('typesets the document as a PDF, with the first pages drawn', async () => {
    const res = await post('/api/books/varrow/notes/export', documentOf());
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as NotesExportResult;
    const pdf = Buffer.from(body.pdf, 'base64');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // A title page, a contents page, and forty passages after them.
    expect(body.pageCount).toBeGreaterThan(4);
    expect(body.pages.length).toBe(Math.min(6, body.pageCount));
    for (const page of body.pages) {
      expect(page.startsWith('<svg')).toBe(true);
      // Night is dark to the edge of every page.
      expect(page).toContain('fill="#15120f"');
      // Letters are outlines: no text a viewer's fonts could change, and
      // nothing from the document as markup.
      expect(page).not.toMatch(/<text|<script|<foreignObject/);
    }
    // The document names itself after the book.
    expect(pdf.toString('latin1')).toContain('/Title');
  }, 60_000);

  it('prints on paper, on a phone-sized page, without a cover', async () => {
    const res = await post(
      '/api/books/bare/notes/export',
      documentOf({ look: 'paper', page: 'phone', text: 'large', contents: false }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as NotesExportResult;
    expect(body.pages[0]).toContain('fill="#fbf8f2"');
    // 105 x 186 mm.
    expect(body.pages[0]).toMatch(/viewBox="0 0 297\.\d+ 527\.\d+"/);
  }, 60_000);

  it('sets right-to-left and CJK text, and a book with an unreadable cover', async () => {
    const doc = documentOf({
      lang: 'he',
      dir: 'rtl',
      bookLang: 'he',
      title: 'אורות על המזח',
      titleDir: 'rtl',
      sections: [
        {
          kind: 'chapter',
          head: 'המעבורת',
          dir: 'rtl',
          color: null,
          count: 'הדגשה אחת',
          marks: [
            {
              kind: 'highlight',
              color: 'rose',
              text: 'המעבורת יצאה עם שחר, ואיש לא עלה עליה מלבד הטבח.',
              note: '灯台守の話をもう一度読む。',
              where: '12% · 3 בספט׳ 2026',
              dir: 'rtl',
              noteDir: 'ltr',
            },
          ],
        },
      ],
    });
    const res = await post('/api/books/broken/notes/export', doc);
    expect(res.statusCode).toBe(200);
    expect((res.json() as NotesExportResult).pageCount).toBeGreaterThan(1);
  }, 60_000);

  it('turns away what is not a document', async () => {
    const bad = await post('/api/books/varrow/notes/export', { ...documentOf(), look: 'sepia' });
    expect(bad.statusCode).toBe(400);
    const noTitle = await post('/api/books/varrow/notes/export', documentOf({ title: '' }));
    expect(noTitle.statusCode).toBe(400);
    const lang = await post('/api/books/varrow/notes/export', documentOf({ lang: 'zh-Hans' }));
    expect(lang.statusCode).toBe(400);
  });

  it('is only for a book that is there, and for someone signed in', async () => {
    expect((await post('/api/books/nowhere/notes/export', documentOf())).statusCode).toBe(404);
    expect((await post('/api/books/varrow/notes/export', documentOf(), null)).statusCode).toBe(401);
  });
});
