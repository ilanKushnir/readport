import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Annotation } from '@readport/shared';
import {
  DEFAULT_PREFERENCES,
  exportHref,
  exportOptionsFromParams,
  exportOptionsToParams,
  kindsOfView,
  optionsForView,
  pageSizeFor,
  preferencesOf,
  readPreferences,
  rememberPreferences,
  selectForExport,
  viewOfOptions,
  type ExportOptions,
} from './exportOptions';

/**
 * The export's options, pinned down without a DOM: how they travel in the
 * URL, how they are derived from the view being exported, what they leave
 * in, and how they are remembered between exports.
 */

const EVERYTHING: ExportOptions = {
  ...DEFAULT_PREFERENCES,
  kinds: ['highlight', 'note', 'bookmark'],
  colors: [],
  sort: 'position',
};

let seq = 0;
function mark(kind: Annotation['kind'], color: string | null = null): Annotation {
  seq += 1;
  return {
    id: `a${seq}`,
    bookId: 'b1',
    kind,
    locator: { medium: 'ebook', spineIdx: 1, charOffset: seq, pct: 0.1 },
    endLocator: null,
    color,
    selectedText: kind === 'bookmark' ? null : `passage ${seq}`,
    note: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + seq * 3_600_000).toISOString(),
  };
}

describe('the options in the URL', () => {
  it('reads every default from an empty address', () => {
    expect(exportOptionsFromParams(new URLSearchParams())).toEqual(EVERYTHING);
  });

  it('round-trips, writing only what differs from the defaults', () => {
    const chosen: ExportOptions = {
      look: 'night',
      page: 'phone',
      text: 'large',
      kinds: ['highlight', 'note'],
      colors: ['sky', 'plum'],
      sort: 'newest',
      cover: false,
      heads: true,
      where: false,
      notes: true,
    };
    const params = exportOptionsToParams(chosen);
    expect(params.toString()).toBe(
      'kinds=highlight%2Cnote&colors=plum%2Csky&sort=newest&look=night&page=phone&text=large&cover=0&where=0',
    );
    expect(exportOptionsFromParams(params)).toEqual({ ...chosen, colors: ['plum', 'sky'] });
    expect(exportOptionsToParams(EVERYTHING).toString()).toBe('');
  });

  it('ignores what it does not recognise and writes every kind for none', () => {
    const params = new URLSearchParams('kinds=nope,note&look=sepia&page=a3&text=huge&cover=maybe');
    const options = exportOptionsFromParams(params);
    expect(options.kinds).toEqual(['note']);
    expect(options.look).toBe('paper');
    expect(options.page).toBe('a4');
    expect(options.text).toBe('comfortable');
    expect(options.cover).toBe(true);
    expect(exportOptionsFromParams(new URLSearchParams('kinds=nope')).kinds).toEqual([
      'highlight',
      'note',
      'bookmark',
    ]);
    expect(exportOptionsToParams({ ...EVERYTHING, kinds: [] }).has('kinds')).toBe(false);
  });

  it('still honours the marks page’s own kind= from a link made before the sheet', () => {
    expect(exportOptionsFromParams(new URLSearchParams('kind=bookmark')).kinds).toEqual([
      'bookmark',
    ]);
    expect(exportOptionsFromParams(new URLSearchParams('kind=all')).kinds).toHaveLength(3);
    expect(exportOptionsFromParams(new URLSearchParams('kind=note&kinds=highlight')).kinds).toEqual(
      ['highlight'],
    );
  });

  it('builds the export address, with print=1 only when asked', () => {
    expect(exportHref('b1', EVERYTHING)).toBe('/notes/b1/export');
    expect(exportHref('b1', { ...EVERYTHING, kinds: ['highlight'] }, true)).toBe(
      '/notes/b1/export?kinds=highlight&print=1',
    );
  });
});

describe('from the view and back', () => {
  it('opens with the kinds, colours and order of the view, in the remembered dress', () => {
    const prefs = { ...DEFAULT_PREFERENCES, look: 'night' as const, heads: false };
    expect(optionsForView({ kind: 'all', colors: ['plum'], sort: 'color' }, prefs)).toEqual({
      ...prefs,
      kinds: ['highlight', 'note', 'bookmark'],
      colors: ['plum'],
      sort: 'color',
    });
    expect(kindsOfView({ kind: 'note', colors: [], sort: 'position' })).toEqual(['note']);
  });

  it('returns to the one kind, or to all of them for any wider set', () => {
    expect(viewOfOptions({ ...EVERYTHING, kinds: ['bookmark'], sort: 'newest' })).toEqual({
      kind: 'bookmark',
      colors: [],
      sort: 'newest',
    });
    expect(viewOfOptions({ ...EVERYTHING, kinds: ['highlight', 'note'], colors: ['sky'] })).toEqual(
      { kind: 'all', colors: ['sky'], sort: 'position' },
    );
  });

  it('keeps only the presentational half as preferences', () => {
    expect(
      preferencesOf({ ...EVERYTHING, kinds: ['note'], colors: ['rose'], sort: 'newest' }),
    ).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('selectForExport', () => {
  const marks = [
    mark('highlight', 'plum'),
    mark('highlight', 'sky'),
    mark('highlight', 'amber'),
    mark('note'),
    mark('bookmark'),
  ];

  it('keeps everything with every kind ticked and no colour chosen', () => {
    expect(selectForExport(marks, EVERYTHING)).toHaveLength(5);
  });

  it('drops a kind that is not ticked, and everything when none is', () => {
    expect(selectForExport(marks, { ...EVERYTHING, kinds: ['note', 'bookmark'] })).toHaveLength(2);
    expect(selectForExport(marks, { ...EVERYTHING, kinds: [] })).toHaveLength(0);
  });

  it('a colour narrows the highlights and leaves notes and bookmarks alone', () => {
    const kept = selectForExport(marks, { ...EVERYTHING, colors: ['plum', 'sky'] });
    expect(kept.map((a) => a.kind)).toEqual(['highlight', 'highlight', 'note', 'bookmark']);
    expect(kept.map((a) => a.color)).toEqual(['plum', 'sky', null, null]);
  });
});

describe('the page a reader most likely has', () => {
  it('is Letter in North America and A4 elsewhere, from the language tag', () => {
    expect(pageSizeFor('en-US')).toBe('letter');
    expect(pageSizeFor('fr-CA')).toBe('letter');
    expect(pageSizeFor('es-MX')).toBe('letter');
    expect(pageSizeFor('en-GB')).toBe('a4');
    expect(pageSizeFor('he')).toBe('a4');
    expect(pageSizeFor('zh-Hans-CN')).toBe('a4');
    expect(pageSizeFor(undefined)).toBe('a4');
  });
});

describe('remembering the preferences', () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts from the defaults, with the page guessed from the language', () => {
    expect(readPreferences('en-US')).toEqual({ ...DEFAULT_PREFERENCES, page: 'letter' });
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('reads back what was remembered', () => {
    const prefs = { ...DEFAULT_PREFERENCES, look: 'night' as const, page: 'phone' as const };
    rememberPreferences(prefs);
    expect(readPreferences('en-US')).toEqual(prefs);
  });

  it('takes the default for any field it cannot make sense of', () => {
    store['rp-notes-export'] = JSON.stringify({ look: 'night', page: 'a3', cover: 'no', heads: 0 });
    expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES, look: 'night' });
    store['rp-notes-export'] = '{not json';
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
    store['rp-notes-export'] = '[]';
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('survives storage that will not open', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readPreferences('en-US')).toEqual({ ...DEFAULT_PREFERENCES, page: 'letter' });
    expect(() => rememberPreferences(DEFAULT_PREFERENCES)).not.toThrow();
  });
});
