import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  booksOf,
  chapterAt,
  chapterOf,
  chapterStarts,
  colorsUsed,
  countByKind,
  hrefOf,
  lastMarkedAt,
  organise,
  sortMarks,
  viewFromParams,
  viewToParams,
  type MarkKind,
  type Marked,
} from './organise';

/**
 * The rules behind the Notes pages, pinned down without a DOM: which
 * chapter a mark belongs to, what each sort order means, and how the
 * filters compose. Fixtures are built by hand rather than loaded, so each
 * test reads as the situation it covers.
 */

let seq = 0;

/** A mark in an ebook, timestamped in the order it is built. */
function ebook(
  kind: MarkKind,
  spineIdx: number,
  charOffset: number,
  extra: Partial<Marked> = {},
): Marked {
  seq += 1;
  return {
    id: `a${seq}`,
    bookId: 'b1',
    kind,
    locator: { medium: 'ebook', spineIdx, charOffset, pct: 0.1 },
    endLocator: null,
    color: kind === 'highlight' ? 'amber' : null,
    selectedText: kind === 'bookmark' ? null : `passage ${seq}`,
    note: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + seq * 3_600_000).toISOString(),
    bookTitle: 'Quillon Reach',
    bookAuthor: 'Hester Vane',
    ...extra,
  };
}

/** A bookmark in an audiobook. */
function audio(bookMs: number, extra: Partial<Marked> = {}): Marked {
  seq += 1;
  return {
    id: `a${seq}`,
    bookId: 'b2',
    kind: 'bookmark',
    locator: { medium: 'audio', trackIdx: 0, positionMs: bookMs, bookMs, pct: 0.2 },
    endLocator: null,
    color: null,
    selectedText: null,
    note: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + seq * 3_600_000).toISOString(),
    bookTitle: 'Saltmarsh Evenings',
    bookAuthor: 'Oswin Pell',
    ...extra,
  };
}

const toc = [
  { title: 'Prologue', spineIdx: 0, startMs: null },
  { title: 'One', spineIdx: 2, startMs: null },
  { title: 'Two', spineIdx: 5, startMs: null },
];

describe('chapterStarts', () => {
  it('turns an ebook contents list into spine starts, sorted, without entries that point nowhere', () => {
    const starts = chapterStarts([
      { title: 'Two', spineIdx: 5, startMs: null },
      { title: 'Notes', spineIdx: null, startMs: null },
      { title: 'Prologue', spineIdx: 0, startMs: null },
      { title: 'One', spineIdx: 2, startMs: null },
    ]);
    expect(starts).toEqual([
      { at: 0, title: 'Prologue' },
      { at: 2, title: 'One' },
      { at: 5, title: 'Two' },
    ]);
  });

  it('keeps the first name when two entries begin in the same place', () => {
    const starts = chapterStarts([
      { title: 'Part I', spineIdx: 3, startMs: null },
      { title: 'Chapter 1', spineIdx: 3, startMs: null },
    ]);
    expect(starts).toEqual([{ at: 3, title: 'Part I' }]);
  });

  it('uses the start time for an audiobook', () => {
    const starts = chapterStarts([
      { title: 'The Quay at Dusk', spineIdx: null, startMs: 0 },
      { title: 'Second Bell', spineIdx: null, startMs: 1_200_000 },
    ]);
    expect(starts.map((s) => s.at)).toEqual([0, 1_200_000]);
  });
});

describe('chapterAt', () => {
  const starts = chapterStarts(toc);
  it('finds the last chapter beginning at or before a position', () => {
    expect(chapterAt(starts, 0)).toBe(0);
    expect(chapterAt(starts, 1)).toBe(0);
    expect(chapterAt(starts, 2)).toBe(1);
    expect(chapterAt(starts, 4)).toBe(1);
    expect(chapterAt(starts, 5)).toBe(2);
    expect(chapterAt(starts, 99)).toBe(2);
  });
  it('is -1 before the first chapter and with no chapters at all', () => {
    expect(chapterAt(chapterStarts(toc.slice(1)), 1)).toBe(-1);
    expect(chapterAt([], 3)).toBe(-1);
  });
});

describe('chapterOf', () => {
  it('names the chapter a mark falls in', () => {
    const head = chapterOf(ebook('highlight', 3, 10), chapterStarts(toc));
    expect(head).toMatchObject({
      kind: 'chapter',
      index: 1,
      title: 'One',
      unit: 2,
      medium: 'ebook',
    });
  });

  it('gives an ebook mark before the first listed chapter a nameless head numbered by spine item', () => {
    const head = chapterOf(ebook('note', 1, 0), chapterStarts(toc.slice(1)));
    expect(head).toMatchObject({ kind: 'chapter', index: -1, title: null, unit: 1 });
  });

  it('gives an ebook with no chapter list one nameless head per spine item', () => {
    expect(chapterOf(ebook('highlight', 4, 0), [])).toMatchObject({ title: null, unit: 4 });
  });

  it('gives an audio mark before the first chapter no head at all', () => {
    const starts = chapterStarts([{ title: 'Two', spineIdx: null, startMs: 5_000 }]);
    expect(chapterOf(audio(1_000), starts)).toBeNull();
    expect(chapterOf(audio(1_000), [])).toBeNull();
    expect(chapterOf(audio(6_000), starts)).toMatchObject({ title: 'Two', medium: 'audio' });
  });
});

describe('organise by position', () => {
  it('groups marks under their chapters in reading order, by offset within a chapter', () => {
    const late = ebook('highlight', 6, 0);
    const b = ebook('highlight', 2, 300);
    const a = ebook('note', 2, 100);
    const c = ebook('bookmark', 3, 0);
    const front = ebook('highlight', 0, 50);
    const sections = organise([late, b, a, c, front], 'position', chapterStarts(toc));
    expect(sections.map((s) => s.head && s.head.kind === 'chapter' && s.head.title)).toEqual([
      'Prologue',
      'One',
      'Two',
    ]);
    expect(sections.map((s) => s.marks.map((m) => m.id))).toEqual([
      [front.id],
      [a.id, b.id, c.id],
      [late.id],
    ]);
  });

  it('breaks a tie at the same offset by when the mark was made', () => {
    const first = ebook('highlight', 2, 100);
    const second = ebook('note', 2, 100);
    const [section] = organise([second, first], 'position', chapterStarts(toc));
    expect(section!.marks.map((m) => m.id)).toEqual([first.id, second.id]);
  });

  it('keeps a chapter that spans several spine items together', () => {
    const one = ebook('highlight', 2, 0);
    const stillOne = ebook('highlight', 4, 0);
    const sections = organise([stillOne, one], 'position', chapterStarts(toc));
    expect(sections).toHaveLength(1);
    expect(sections[0]!.marks.map((m) => m.id)).toEqual([one.id, stillOne.id]);
  });

  it('gives the front matter its own numbered sections rather than losing it', () => {
    const cover = ebook('bookmark', 0, 0);
    const dedication = ebook('highlight', 1, 0);
    const body = ebook('highlight', 2, 0);
    const sections = organise([body, dedication, cover], 'position', chapterStarts(toc.slice(1)));
    expect(sections.map((s) => s.key)).toEqual(['spine:0', 'spine:1', 'ch:0']);
    expect(sections[0]!.head).toMatchObject({ kind: 'chapter', title: null, unit: 0 });
  });

  it('puts audio bookmarks under the chapter playing at the time', () => {
    const starts = chapterStarts([
      { title: 'The Quay at Dusk', spineIdx: null, startMs: 0 },
      { title: 'Second Bell', spineIdx: null, startMs: 1_200_000 },
    ]);
    const sections = organise([audio(1_500_000), audio(30_000)], 'position', starts);
    expect(sections.map((s) => s.head && s.head.kind === 'chapter' && s.head.title)).toEqual([
      'The Quay at Dusk',
      'Second Bell',
    ]);
  });

  it('is empty for no marks', () => {
    expect(organise([], 'position', chapterStarts(toc))).toEqual([]);
    expect(organise([], 'newest', [])).toEqual([]);
  });
});

describe('organise newest first', () => {
  it('is one headless list, latest mark first', () => {
    const older = ebook('highlight', 5, 0);
    const newer = ebook('note', 1, 0);
    const sections = organise([older, newer], 'newest', chapterStarts(toc));
    expect(sections).toHaveLength(1);
    expect(sections[0]!.head).toBeNull();
    expect(sections[0]!.marks.map((m) => m.id)).toEqual([newer.id, older.id]);
  });
});

describe('organise by colour', () => {
  it('runs through the palette in order, then notes, then bookmarks, each in reading order', () => {
    const sky = ebook('highlight', 1, 0, { color: 'sky' });
    const amberLate = ebook('highlight', 4, 0, { color: 'amber' });
    const plum = ebook('highlight', 2, 0, { color: 'plum' });
    const amberEarly = ebook('highlight', 0, 0, { color: 'amber' });
    const note = ebook('note', 0, 0);
    const bookmark = ebook('bookmark', 3, 0);
    const sections = organise(
      [bookmark, sky, note, amberLate, plum, amberEarly],
      'color',
      chapterStarts(toc),
    );
    expect(sections.map((s) => s.key)).toEqual([
      'color:amber',
      'color:plum',
      'color:sky',
      'kind:note',
      'kind:bookmark',
    ]);
    expect(sections[0]!.marks.map((m) => m.id)).toEqual([amberEarly.id, amberLate.id]);
    expect(sections[3]!.head).toEqual({ kind: 'kind', markKind: 'note' });
  });

  it('treats a highlight with an unknown colour as the default amber', () => {
    const odd = ebook('highlight', 0, 0, { color: 'chartreuse' });
    const [section] = organise([odd], 'color', []);
    expect(section!.head).toEqual({ kind: 'color', color: 'amber' });
  });
});

describe('sortMarks', () => {
  it('does not disturb the list it was given', () => {
    const marks = [ebook('highlight', 3, 0), ebook('highlight', 1, 0)];
    const before = marks.map((m) => m.id);
    sortMarks(marks, 'position');
    expect(marks.map((m) => m.id)).toEqual(before);
  });
});

describe('applyFilters', () => {
  const highlightAmber = ebook('highlight', 0, 0, { color: 'amber', note: 'Remember this' });
  const highlightPlum = ebook('highlight', 1, 0, { color: 'plum', selectedText: 'The Weir' });
  const note = ebook('note', 2, 0, { note: 'A weir of my own' });
  const bookmark = ebook('bookmark', 3, 0);
  const other = audio(0, { bookTitle: 'Saltmarsh Evenings' });
  const all = [highlightAmber, highlightPlum, note, bookmark, other];

  it('keeps everything with no filter set', () => {
    expect(applyFilters(all, { kind: 'all', colors: [] })).toEqual(all);
  });

  it('keeps one kind', () => {
    expect(applyFilters(all, { kind: 'note', colors: [] })).toEqual([note]);
    expect(applyFilters(all, { kind: 'bookmark', colors: [] })).toEqual([bookmark, other]);
  });

  it('a colour keeps only highlights in that colour - a note or bookmark is never "in plum"', () => {
    expect(applyFilters(all, { kind: 'all', colors: ['plum'] })).toEqual([highlightPlum]);
    expect(applyFilters(all, { kind: 'all', colors: ['plum', 'amber'] })).toEqual([
      highlightAmber,
      highlightPlum,
    ]);
    expect(applyFilters(all, { kind: 'note', colors: ['plum'] })).toEqual([]);
  });

  it('searches the note, the passage and the book, ignoring case and stray spaces', () => {
    const q = (query: string) =>
      applyFilters(all, { kind: 'all', colors: [], query }).map((m) => m.id);
    expect(q('weir')).toEqual([highlightPlum.id, note.id]);
    expect(q('  REMEMBER ')).toEqual([highlightAmber.id]);
    expect(q('saltmarsh')).toEqual([other.id]);
    expect(q('pell')).toEqual([other.id]);
    expect(q('nothing like this')).toEqual([]);
    expect(q('   ')).toHaveLength(all.length);
  });

  it('composes kind, colour and text', () => {
    expect(applyFilters(all, { kind: 'highlight', colors: ['plum'], query: 'weir' })).toEqual([
      highlightPlum,
    ]);
    expect(applyFilters(all, { kind: 'highlight', colors: ['amber'], query: 'weir' })).toEqual([]);
  });
});

describe('booksOf', () => {
  it('splits marks by book, most recently marked first, each with its counts and colours', () => {
    const early = ebook('highlight', 0, 0, { color: 'sky' });
    const dub = audio(0);
    const late = ebook('note', 1, 0);
    const alsoLate = ebook('highlight', 2, 0, { color: 'amber' });
    const rows = booksOf([early, dub, late, alsoLate]);
    expect(rows.map((r) => r.bookId)).toEqual(['b1', 'b2']);
    const [reach, evenings] = rows;
    expect(reach).toMatchObject({
      title: 'Quillon Reach',
      author: 'Hester Vane',
      counts: { highlight: 2, note: 1, bookmark: 0 },
      colors: ['amber', 'sky'],
      lastMarkedAt: alsoLate.createdAt,
    });
    expect(reach!.marks.map((m) => m.id)).toEqual([early.id, late.id, alsoLate.id]);
    expect(evenings).toMatchObject({
      counts: { highlight: 0, note: 0, bookmark: 1 },
      colors: [],
      lastMarkedAt: dub.createdAt,
    });
  });

  it('is empty for no marks', () => {
    expect(booksOf([])).toEqual([]);
  });
});

describe('counting', () => {
  it('counts by kind and lists colours in the palette order', () => {
    const marks = [
      ebook('highlight', 0, 0, { color: 'sand' }),
      ebook('highlight', 0, 1, { color: 'rose' }),
      ebook('highlight', 0, 2, { color: 'rose' }),
      ebook('note', 0, 3),
    ];
    expect(countByKind(marks)).toEqual({ highlight: 3, note: 1, bookmark: 0 });
    expect(colorsUsed(marks)).toEqual(['rose', 'sand']);
    expect(lastMarkedAt(marks)).toBe(marks[3]!.createdAt);
    expect(lastMarkedAt([])).toBeNull();
  });
});

describe('the view in the URL', () => {
  it('round-trips, writing only what differs from the default', () => {
    const view = {
      kind: 'highlight' as const,
      colors: ['plum' as const, 'sky' as const],
      sort: 'newest' as const,
    };
    const params = viewToParams(view);
    expect(params.toString()).toBe('kind=highlight&colors=plum%2Csky&sort=newest');
    expect(viewFromParams(params)).toEqual(view);
    expect(viewToParams(viewFromParams(new URLSearchParams())).toString()).toBe('');
  });

  it('ignores what it does not recognise', () => {
    const view = viewFromParams(new URLSearchParams('kind=sticker&colors=plum,teal&sort=random'));
    expect(view).toEqual({ kind: 'all', colors: ['plum'], sort: 'position' });
  });

  it('lists chosen colours in the palette order whatever order they were chosen in', () => {
    expect(viewFromParams(new URLSearchParams('colors=sky,amber')).colors).toEqual([
      'amber',
      'sky',
    ]);
  });
});

describe('hrefOf', () => {
  it('opens an ebook at the spine item, character and sentence the mark was made at', () => {
    const a = ebook('highlight', 4, 120);
    expect(hrefOf(a)).toBe('/read/b1?spine=4&char=120');
    a.locator = { medium: 'ebook', spineIdx: 4, charOffset: 120, sentenceId: 's9f', pct: 0.4 };
    expect(hrefOf(a)).toBe('/read/b1?spine=4&char=120&sentence=s9f');
  });

  it('opens an audiobook at the whole-book time, or the track time on an older row', () => {
    expect(hrefOf(audio(90_000))).toBe('/listen/b2?pos=90000');
    const old = audio(0);
    old.locator = { medium: 'audio', trackIdx: 1, positionMs: 5_000, pct: 0.5 };
    expect(hrefOf(old)).toBe('/listen/b2?pos=5000');
  });
});
