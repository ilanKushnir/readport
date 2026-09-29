import { describe, expect, it } from 'vitest';
import { notesExportSchema, type Annotation } from '@readport/shared';
import { formatMessage } from '../i18n/format';
import { en, type MessageKey } from '../i18n/messages/en';
import { COLOR_LABELS } from '../reader/marks';
import {
  buildExportDocument,
  directionOf,
  exportFileName,
  isolate,
  typesetLanguage,
  type ExportInput,
  type ExportWords,
} from './exportDocument';
import { DEFAULT_PREFERENCES, type ExportOptions } from './exportOptions';
import { chapterStarts, type SectionHead } from './organise';

/**
 * The pages of an export, written out: which chapters open with their names,
 * what the line under a passage says, which way each paragraph runs. The
 * book, its chapters and its passages are invented.
 */

const t = (
  key: MessageKey,
  values?: Record<string, string | number | boolean | null | undefined>,
) => formatMessage('en', en[key], values);

const words: ExportWords = {
  t,
  number: (n) => String(n),
  percent: (pct) => `${Math.round(pct * 100)}%`,
  date: (iso) => iso.slice(0, 10),
  sectionTitle: (head: SectionHead | null) => {
    if (!head) return null;
    if (head.kind === 'chapter') return head.title ?? `Chapter ${head.unit + 1}`;
    if (head.kind === 'color') return t(COLOR_LABELS[head.color]);
    return head.markKind === 'note' ? 'Notes' : 'Bookmarks';
  },
  counts: (c) =>
    [
      c.highlight ? t('notes.book.highlights', { n: c.highlight }) : null,
      c.note ? t('notes.book.notes', { n: c.note }) : null,
      c.bookmark ? t('notes.book.bookmarks', { n: c.bookmark }) : null,
    ]
      .filter(Boolean)
      .join(' · '),
  exportScope: () => [],
};

const CHAPTERS = [
  { title: 'The Ferry', spineIdx: 1 },
  { title: 'Lamps on the Pier', spineIdx: 2 },
  { title: 'Peppermint Tin', spineIdx: 3 },
  { title: 'Low Tide', spineIdx: 4 },
  { title: 'The Keeper Returns', spineIdx: 5 },
];

let seq = 0;
function mark(
  kind: Annotation['kind'],
  spineIdx: number,
  extra: Partial<Annotation> = {},
): Annotation {
  seq += 1;
  return {
    id: `m${seq}`,
    bookId: 'varrow',
    kind,
    locator: { medium: 'ebook', spineIdx, charOffset: seq * 10, pct: spineIdx / 10 },
    endLocator: null,
    color: kind === 'highlight' ? 'amber' : null,
    selectedText: kind === 'bookmark' ? null : `A passage from spine ${spineIdx}, number ${seq}.`,
    note: null,
    createdAt: new Date(Date.UTC(2026, 8, 1 + seq)).toISOString(),
    ...extra,
  };
}

const OPTIONS: ExportOptions = {
  ...DEFAULT_PREFERENCES,
  kinds: ['highlight', 'note', 'bookmark'],
  colors: [],
  sort: 'position',
};

function build(
  marks: Annotation[],
  options: Partial<ExportOptions> = {},
  input: Partial<ExportInput> = {},
) {
  return buildExportDocument({
    book: {
      title: 'The Lamplighter of Varrow Pier',
      author: 'Odile Marsk',
      language: 'en-GB',
      hasCover: true,
    },
    bookDir: 'ltr',
    marks,
    starts: chapterStarts(CHAPTERS),
    options: { ...OPTIONS, ...options },
    reader: 'Astra Vell',
    now: new Date('2026-09-29T12:00:00Z'),
    ui: { tag: 'en', dir: 'ltr' },
    words,
    ...input,
  });
}

describe('an export by chapter', () => {
  const marks = [
    mark('highlight', 2, { note: 'Read this one aloud.' }),
    mark('highlight', 1),
    mark('bookmark', 2),
    mark('note', 4, { selectedText: null, note: 'Compare the harbour master’s ledger.' }),
  ];

  it('opens each chapter that has marks with its name, in the book’s order', () => {
    const doc = build(marks);
    expect(doc.sections.map((s) => [s.kind, s.head])).toEqual([
      ['chapter', 'The Ferry'],
      ['chapter', 'Lamps on the Pier'],
      ['chapter', 'Low Tide'],
    ]);
    expect(doc.sections[1]!.count).toBe('1 highlight · 1 bookmark');
    // Valid as the server will read it.
    expect(notesExportSchema.safeParse(doc).success).toBe(true);
  });

  it('leaves the chapter out of the line under a mark it already stands over', () => {
    const [ferry, lamps] = build(marks).sections;
    expect(ferry!.marks[0]!.where).toBe('10% · 2026-09-03');
    expect(lamps!.marks[1]!.where).toBe('Bookmark · 20% · 2026-09-04');
  });

  it('runs as one list without the names, each line saying its chapter', () => {
    const doc = build(marks, { chapters: false });
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]!.kind).toBeNull();
    expect(doc.sections[0]!.marks.map((m) => m.where)).toEqual([
      `${isolate('The Ferry')} · 10% · 2026-09-03`,
      `${isolate('Lamps on the Pier')} · 20% · 2026-09-02`,
      `Bookmark · ${isolate('Lamps on the Pier')} · 20% · 2026-09-04`,
      `${isolate('Low Tide')} · 40% · 2026-09-05`,
    ]);
    expect(doc.contents).toBe(false);
  });

  it('gets a contents page from four chapters on', () => {
    expect(build(marks).contents).toBe(false);
    const more = [...marks, mark('highlight', 5)];
    expect(build(more).contents).toBe(true);
    expect(build(more, { chapters: false }).contents).toBe(false);
  });
});

describe('the other orders', () => {
  const marks = [
    mark('highlight', 3, { color: 'sky' }),
    mark('note', 1, { selectedText: null, note: 'A thought.' }),
    mark('highlight', 1, { color: 'plum' }),
    mark('bookmark', 2),
  ];

  it('newest first is one list, newest at the top', () => {
    const doc = build(marks, { sort: 'newest', chapters: false });
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]!.marks.map((m) => m.kind)).toEqual([
      'bookmark',
      'highlight',
      'note',
      'highlight',
    ]);
  });

  it('by colour opens each colour, then the notes and the bookmarks', () => {
    const doc = build(marks, { sort: 'color', chapters: false });
    expect(doc.sections.map((s) => [s.kind, s.color, s.head])).toEqual([
      ['color', 'plum', 'Plum'],
      ['color', 'sky', 'Sky'],
      ['kind', null, 'Notes'],
      ['kind', null, 'Bookmarks'],
    ]);
    // Only the colours the highlights use, in the palette's order.
    expect(doc.legend).toEqual([
      { color: 'plum', label: 'Plum' },
      { color: 'sky', label: 'Sky' },
    ]);
  });
});

describe('what goes under a passage', () => {
  it('drops a highlight’s note when notes are left out, never a note’s own words', () => {
    const marks = [
      mark('highlight', 1, { note: 'Mine.' }),
      mark('note', 1, { selectedText: null, note: 'Also mine.' }),
    ];
    const [a, b] = build(marks, { notes: false }).sections[0]!.marks;
    expect(a!.note).toBeNull();
    expect(b!.note).toBe('Also mine.');
  });

  it('leaves the dates off, but a bookmark keeps its place', () => {
    const marks = [mark('highlight', 1), mark('bookmark', 1)];
    const [a, b] = build(marks, { where: false }).sections[0]!.marks;
    expect(a!.where).toBeNull();
    expect(b!.where).toBe('Bookmark · 10%');
  });
});

describe('directions and languages', () => {
  it('sets each paragraph the way its first letter runs', () => {
    expect(directionOf('המעבורת יצאה עם שחר.', 'ltr')).toBe('rtl');
    expect(directionOf('“Nell,” she said.', 'rtl')).toBe('ltr');
    expect(directionOf('\u2014 12 \u2014', 'rtl')).toBe('rtl');
    expect(directionOf(null, 'ltr')).toBe('ltr');
  });

  it('writes a Hebrew book in an English interface the way each part runs', () => {
    const doc = build(
      [mark('highlight', 1, { selectedText: 'המעבורת יצאה עם שחר.', note: 'Read aloud.' })],
      {},
      {
        book: { title: 'אורות על המזח', author: null, language: 'he', hasCover: false },
        bookDir: 'rtl',
      },
    );
    expect(doc.titleDir).toBe('rtl');
    expect(doc.bookLang).toBe('he');
    expect(doc.cover).toBe(false);
    const m = doc.sections[0]!.marks[0]!;
    expect(m.dir).toBe('rtl');
    expect(m.noteDir).toBe('ltr');
    // The title is kept whole inside the English closing line.
    expect(doc.labels.closing).toBe(`Kept from your reading of ${isolate('אורות על המזח')}`);
  });

  it('names languages the way the typesetter takes them', () => {
    expect(typesetLanguage('zh-Hans')).toBe('zh');
    expect(typesetLanguage('pt-BR')).toBe('pt');
    expect(typesetLanguage('en')).toBe('en');
    expect(typesetLanguage('x-klingon')).toBeNull();
    expect(typesetLanguage(null)).toBeNull();
  });
});

describe('the title page', () => {
  it('counts only the kinds that went in, and says who marked it and when', () => {
    const doc = build([mark('highlight', 1), mark('highlight', 2), mark('bookmark', 1)]);
    expect(doc.figures).toEqual([
      { n: '2', label: 'highlights' },
      { n: '1', label: 'bookmark' },
    ]);
    expect(doc.labels.reader).toBe(`Marked by ${isolate('Astra Vell')}`);
    expect(doc.labels.stamp).toBe(`Exported from ${isolate('ReadPort')} · 2026-09-29`);
    expect(build([mark('note', 1)], {}, { reader: null }).labels.reader).toBeNull();
  });
});

describe('exportFileName', () => {
  it('names the file after the book, safe for any disk', () => {
    expect(exportFileName('The Lamplighter of Varrow Pier', t)).toBe(
      'The Lamplighter of Varrow Pier – Highlights & notes.pdf',
    );
    expect(exportFileName('Salt/Clock: a "tide" tale?', t)).toBe(
      'Salt Clock a tide tale – Highlights & notes.pdf',
    );
  });
});
