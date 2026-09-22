import { type Annotation } from '@readport/shared';
import { HIGHLIGHT_COLORS, colorOf, type HighlightColor } from '../reader/marks';
import {
  DEFAULT_VIEW,
  KIND_FILTERS,
  SORT_ORDERS,
  type KindFilter,
  type MarkKind,
  type MarksView,
  type SortOrder,
} from './organise';

/**
 * What "Export as PDF…" asks before it prints: how the pages should look,
 * what size they are, what goes on them, and in what order.
 *
 * The options ride in the export page's URL, so the page is a pure function
 * of its address - a link to it, a reload of it and the Back button all
 * show the same pages - and only what differs from the defaults is written,
 * so an untouched export is a clean URL. The presentational half (look,
 * page, text size, and the include toggles) is also remembered in the
 * browser: a reader who prints Night on Letter once prints Night on Letter
 * next time. Which marks go in and in what order are not remembered - they
 * come from the view the reader is exporting from.
 */

export const LOOKS = ['paper', 'night'] as const;
export type Look = (typeof LOOKS)[number];

export const PAGE_SIZES = ['a4', 'letter', 'phone'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const TEXT_SIZES = ['compact', 'comfortable', 'large'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/** The kinds of mark, in the order the sheet and the title page list them. */
export const MARK_KINDS: readonly MarkKind[] = ['highlight', 'note', 'bookmark'];

export interface ExportOptions {
  look: Look;
  page: PageSize;
  text: TextSize;
  /** Which kinds go in. The sheet lets a reader untick them all; the URL never carries none. */
  kinds: MarkKind[];
  /** Highlight colours to keep; empty keeps every colour. A note or a bookmark has no colour and is not affected. */
  colors: HighlightColor[];
  sort: SortOrder;
  /** The cover on the title page. */
  cover: boolean;
  /** Running chapter (or colour) heads. */
  heads: boolean;
  /** The "Chapter 4 · 37% · 12 Sept 2026" line under each mark. */
  where: boolean;
  /** The reader's note under a highlight. A note that is the mark itself always stays. */
  notes: boolean;
}

/** The presentational half, remembered from one export to the next. */
export type ExportPreferences = Pick<
  ExportOptions,
  'look' | 'page' | 'text' | 'cover' | 'heads' | 'where' | 'notes'
>;

export const DEFAULT_PREFERENCES: ExportPreferences = {
  look: 'paper',
  page: 'a4',
  text: 'comfortable',
  cover: true,
  heads: true,
  where: true,
  notes: true,
};

/* ------------------------------------------------------------ the view */

/** The kinds a view shows: every kind for "all", otherwise the one. */
export function kindsOfView(view: MarksView): MarkKind[] {
  return view.kind === 'all' ? [...MARK_KINDS] : [view.kind];
}

/**
 * The view to return to from an export: the one kind when one was chosen,
 * "all" for any wider set - the marks page has no filter for two of three.
 */
export function viewOfOptions(options: ExportOptions): MarksView {
  const kind: KindFilter = options.kinds.length === 1 ? options.kinds[0]! : 'all';
  return { kind, colors: [...options.colors], sort: options.sort };
}

/** What the sheet opens with: the view being looked at, dressed in the remembered preferences. */
export function optionsForView(view: MarksView, prefs: ExportPreferences): ExportOptions {
  return {
    ...prefs,
    kinds: kindsOfView(view),
    colors: [...view.colors],
    sort: view.sort,
  };
}

export function preferencesOf(options: ExportOptions): ExportPreferences {
  const { look, page, text, cover, heads, where, notes } = options;
  return { look, page, text, cover, heads, where, notes };
}

/* ------------------------------------------------------------- the URL */

function oneOf<T extends string>(list: readonly T[], value: string | null, fallback: T): T {
  return list.includes(value as T) ? (value as T) : fallback;
}

function listOf<T extends string>(list: readonly T[], value: string | null): T[] {
  const wanted = (value ?? '').split(',');
  return list.filter((x) => wanted.includes(x));
}

/**
 * The options in a URL. Anything missing or unrecognised takes its default,
 * so a hand-edited or stale link still prints something sensible. `kind=`
 * (the marks page's own parameter) is honoured when `kinds=` is absent, so
 * a link made before the sheet existed still exports what it said.
 */
export function exportOptionsFromParams(params: URLSearchParams): ExportOptions {
  let kinds = listOf(MARK_KINDS, params.get('kinds'));
  if (kinds.length === 0) {
    const kind = params.get('kind');
    kinds =
      kind && kind !== 'all' && KIND_FILTERS.includes(kind as KindFilter)
        ? [kind as MarkKind]
        : [...MARK_KINDS];
  }
  const flag = (name: string) => params.get(name) !== '0';
  return {
    look: oneOf(LOOKS, params.get('look'), DEFAULT_PREFERENCES.look),
    page: oneOf(PAGE_SIZES, params.get('page'), DEFAULT_PREFERENCES.page),
    text: oneOf(TEXT_SIZES, params.get('text'), DEFAULT_PREFERENCES.text),
    kinds,
    colors: listOf(HIGHLIGHT_COLORS, params.get('colors')),
    sort: oneOf(SORT_ORDERS, params.get('sort'), DEFAULT_VIEW.sort),
    cover: flag('cover'),
    heads: flag('heads'),
    where: flag('where'),
    notes: flag('notes'),
  };
}

/**
 * Only what differs from the defaults, colours in the palette's order whatever
 * order they were chosen in. A set of no kinds is written as every kind:
 * there is nothing else to print.
 */
export function exportOptionsToParams(options: ExportOptions): URLSearchParams {
  const params = new URLSearchParams();
  const kinds = MARK_KINDS.filter((k) => options.kinds.includes(k));
  if (kinds.length > 0 && kinds.length < MARK_KINDS.length) params.set('kinds', kinds.join(','));
  const colors = HIGHLIGHT_COLORS.filter((c) => options.colors.includes(c));
  if (colors.length > 0) params.set('colors', colors.join(','));
  if (options.sort !== DEFAULT_VIEW.sort) params.set('sort', options.sort);
  if (options.look !== DEFAULT_PREFERENCES.look) params.set('look', options.look);
  if (options.page !== DEFAULT_PREFERENCES.page) params.set('page', options.page);
  if (options.text !== DEFAULT_PREFERENCES.text) params.set('text', options.text);
  for (const flag of ['cover', 'heads', 'where', 'notes'] as const) {
    if (!options[flag]) params.set(flag, '0');
  }
  return params;
}

/** The export page for one book, with `print=1` when arriving should open the print sheet. */
export function exportHref(bookId: string, options: ExportOptions, print = false): string {
  const params = exportOptionsToParams(options);
  if (print) params.set('print', '1');
  const query = params.toString();
  return `/notes/${bookId}/export${query ? `?${query}` : ''}`;
}

/* ------------------------------------------------------------ the marks */

/**
 * The marks an export holds. A kind that is not ticked is out; a colour
 * filter narrows the highlights and leaves notes and bookmarks alone - so
 * "only plum and sky" with notes ticked exports the plum and sky highlights
 * and every note, which is what the sheet's summary line promises.
 */
export function selectForExport<T extends Annotation>(
  marks: readonly T[],
  options: ExportOptions,
): T[] {
  return marks.filter((a) => {
    if (!options.kinds.includes(a.kind)) return false;
    if (a.kind === 'highlight' && options.colors.length > 0) {
      return options.colors.includes(colorOf(a));
    }
    return true;
  });
}

/* ------------------------------------------------------ remembering it */

const STORAGE_KEY = 'rp-notes-export';

/** Regions that print on Letter; everyone else has A4 in the drawer. */
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'GT', 'CR', 'PA', 'DO']);

/** The page a reader most likely has, from the browser's language tag: `en-US` prints on Letter, `en-GB` on A4. */
export function pageSizeFor(language: string | null | undefined): PageSize {
  const region = /^[a-z]{2,3}(?:-[A-Za-z]{4})?-([A-Za-z]{2})\b/.exec(language ?? '')?.[1];
  return region && LETTER_REGIONS.has(region.toUpperCase()) ? 'letter' : 'a4';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The remembered preferences, or the defaults for a first export - with
 * the page size guessed from the browser's language, since that is the
 * one default a reader in North America would otherwise change every time.
 * Storage that will not open (private mode, a locked-down browser) or holds
 * something unrecognisable reads as never having been written.
 */
export function readPreferences(language?: string | null): ExportPreferences {
  const first: ExportPreferences = { ...DEFAULT_PREFERENCES, page: pageSizeFor(language) };
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return first;
  }
  if (!raw) return first;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return first;
  }
  if (!isRecord(stored)) return first;
  const bool = (name: keyof ExportPreferences, fallback: boolean) =>
    typeof stored[name] === 'boolean' ? (stored[name] as boolean) : fallback;
  const str = (name: keyof ExportPreferences) =>
    typeof stored[name] === 'string' ? (stored[name] as string) : null;
  return {
    look: oneOf(LOOKS, str('look'), first.look),
    page: oneOf(PAGE_SIZES, str('page'), first.page),
    text: oneOf(TEXT_SIZES, str('text'), first.text),
    cover: bool('cover', first.cover),
    heads: bool('heads', first.heads),
    where: bool('where', first.where),
    notes: bool('notes', first.notes),
  };
}

export function rememberPreferences(prefs: ExportPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode, or storage full: the next export simply asks again */
  }
}
