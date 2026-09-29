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
 * What "Export as PDF…" asks before it makes the pages: how they should
 * look, what size they are, what goes on them, and in what order.
 *
 * The options ride in the export page's URL, so the page is a pure function
 * of its address - a link to it, a reload of it and the Back button all
 * show the same pages - and only what differs from the defaults is written,
 * so an untouched export is a clean URL. The presentational half (look,
 * page, text size, and the include toggles) is also remembered in the
 * browser: a reader who exports Night on Letter once gets Night on Letter
 * next time. Which marks go in and in what order are not remembered - they
 * come from the view the reader is exporting from.
 *
 * Chapter names and book order go together: a chapter's name is a divider
 * only where the marks run in the book's order, so choosing the names puts
 * the marks in book order, and choosing another order leaves the names
 * out (see `withChapters` and `withSort`; the sheet says when it does).
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
  /**
   * Each chapter that has marks opens with its name. Only in book order:
   * `withChapters` and `withSort` keep the two together.
   */
  chapters: boolean;
  /** The "Chapter 4 · 37% · 12 Sept 2026" line under each mark. */
  where: boolean;
  /** The reader's note under a highlight. A note that is the mark itself always stays. */
  notes: boolean;
}

/** The presentational half, remembered from one export to the next. */
export type ExportPreferences = Pick<
  ExportOptions,
  'look' | 'page' | 'text' | 'cover' | 'chapters' | 'where' | 'notes'
>;

export const DEFAULT_PREFERENCES: ExportPreferences = {
  look: 'paper',
  page: 'a4',
  text: 'comfortable',
  cover: true,
  chapters: true,
  where: true,
  notes: true,
};

/** The order chapter names need: the book's own. */
export const CHAPTER_ORDER: SortOrder = 'position';

/**
 * Chapter names on or off. On puts the marks in book order, the only order
 * a chapter's name can stand over; `resorted` says the order had to change,
 * so the sheet can say so.
 */
export function withChapters(
  options: ExportOptions,
  chapters: boolean,
): { options: ExportOptions; resorted: boolean } {
  const resorted = chapters && options.sort !== CHAPTER_ORDER;
  return {
    options: { ...options, chapters, sort: chapters ? CHAPTER_ORDER : options.sort },
    resorted,
  };
}

/**
 * Another order. Any order but the book's leaves the chapter names out;
 * `unnamed` says they had been in, so the sheet can say they are not now.
 */
export function withSort(
  options: ExportOptions,
  sort: SortOrder,
): { options: ExportOptions; unnamed: boolean } {
  const unnamed = options.chapters && sort !== CHAPTER_ORDER;
  return { options: { ...options, sort, chapters: unnamed ? false : options.chapters }, unnamed };
}

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

/**
 * What the sheet opens with: the view being looked at, dressed in the
 * remembered preferences - with the chapter names only where that view is
 * in book order.
 */
export function optionsForView(view: MarksView, prefs: ExportPreferences): ExportOptions {
  return {
    ...prefs,
    chapters: prefs.chapters && view.sort === CHAPTER_ORDER,
    kinds: kindsOfView(view),
    colors: [...view.colors],
    sort: view.sort,
  };
}

/**
 * The half worth remembering. An export in another order says nothing
 * about the chapter names - they could not be had - so the choice made the
 * last time they could be stays.
 */
export function preferencesOf(
  options: ExportOptions,
  remembered: ExportPreferences = DEFAULT_PREFERENCES,
): ExportPreferences {
  const { look, page, text, cover, where, notes } = options;
  const chapters = options.sort === CHAPTER_ORDER ? options.chapters : remembered.chapters;
  return { look, page, text, cover, chapters, where, notes };
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
  const sort = oneOf(SORT_ORDERS, params.get('sort'), DEFAULT_VIEW.sort);
  return {
    look: oneOf(LOOKS, params.get('look'), DEFAULT_PREFERENCES.look),
    page: oneOf(PAGE_SIZES, params.get('page'), DEFAULT_PREFERENCES.page),
    text: oneOf(TEXT_SIZES, params.get('text'), DEFAULT_PREFERENCES.text),
    kinds,
    colors: listOf(HIGHLIGHT_COLORS, params.get('colors')),
    sort,
    cover: flag('cover'),
    // `heads=0` is what a link from before the chapter names said.
    chapters: flag('chapters') && flag('heads') && sort === CHAPTER_ORDER,
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
  for (const flag of ['cover', 'where', 'notes'] as const) {
    if (!options[flag]) params.set(flag, '0');
  }
  // Only book order can have them, and there they are the default.
  if (options.sort === CHAPTER_ORDER && !options.chapters) params.set('chapters', '0');
  return params;
}

/** The export page for one book. */
export function exportHref(bookId: string, options: ExportOptions): string {
  const query = exportOptionsToParams(options).toString();
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
    // Stored as `heads` before the chapter names had a name of their own.
    chapters: bool('chapters', typeof stored.heads === 'boolean' ? stored.heads : first.chapters),
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
