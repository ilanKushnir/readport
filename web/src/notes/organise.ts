import { type Annotation } from '@readport/shared';
import { HIGHLIGHT_COLORS, colorOf, isHighlightColor, type HighlightColor } from '../reader/marks';

/**
 * Organising a reader's marks: which of them to show, in what order, and
 * under which running heads.
 *
 * Pure functions over the rows the annotations API returns, so the Notes
 * pages stay thin and every rule here - what "sorted by position" means for
 * an audiobook, which chapter a mark in the front matter belongs to, how a
 * colour filter treats a bookmark - can be pinned down without a DOM.
 */

export type MarkKind = Annotation['kind'];
export type KindFilter = 'all' | MarkKind;
export type SortOrder = 'position' | 'newest' | 'color';

export const KIND_FILTERS: readonly KindFilter[] = ['all', 'highlight', 'note', 'bookmark'];
export const SORT_ORDERS: readonly SortOrder[] = ['position', 'newest', 'color'];

/** An annotation as the cross-book list returns it: carrying its book's name. */
export type Marked = Annotation & {
  bookTitle: string;
  bookAuthor: string | null;
  /** Absent from an older server: then the cover is tried and its failure paints the fallback. */
  bookKind?: 'ebook' | 'audio';
  bookHasCover?: boolean;
};

/* ------------------------------------------------------------- filtering */

export interface MarkFilters {
  kind: KindFilter;
  /**
   * Highlight colours to keep. Empty keeps everything; once a colour is
   * chosen only highlights in the chosen colours remain. A note or a
   * bookmark has no colour to match, so it is never "in plum".
   */
  colors: readonly HighlightColor[];
  /** Free text, matched against the passage, the note, and the book's title and author. */
  query?: string;
}

type Searchable = Annotation & Partial<Pick<Marked, 'bookTitle' | 'bookAuthor'>>;

export function matchesFilters(a: Searchable, filters: MarkFilters): boolean {
  if (filters.kind !== 'all' && a.kind !== filters.kind) return false;
  if (filters.colors.length > 0 && (a.kind !== 'highlight' || !filters.colors.includes(colorOf(a))))
    return false;
  const q = (filters.query ?? '').trim().toLowerCase();
  if (!q) return true;
  return [a.note, a.selectedText, a.bookTitle, a.bookAuthor].some((s) =>
    (s ?? '').toLowerCase().includes(q),
  );
}

export function applyFilters<T extends Searchable>(marks: readonly T[], filters: MarkFilters): T[] {
  return marks.filter((a) => matchesFilters(a, filters));
}

/* -------------------------------------------------------------- position */

/**
 * Where a mark sits in its book, as a pair that sorts in reading order: the
 * spine item and the character offset within it for an ebook, the
 * whole-book millisecond for audio (falling back to the track position on a
 * row written before `bookMs` existed).
 */
export interface Position {
  unit: number;
  offset: number;
}

export function positionOf(a: Annotation): Position {
  if (a.locator.medium === 'ebook') {
    return { unit: a.locator.spineIdx, offset: a.locator.charOffset ?? 0 };
  }
  return { unit: a.locator.bookMs ?? a.locator.positionMs, offset: 0 };
}

const timeOf = (a: Annotation): number => {
  const ms = Date.parse(a.createdAt);
  return Number.isFinite(ms) ? ms : 0;
};

export function compareByPosition(a: Annotation, b: Annotation): number {
  const p = positionOf(a);
  const q = positionOf(b);
  return p.unit - q.unit || p.offset - q.offset || timeOf(a) - timeOf(b);
}

export function compareByNewest(a: Annotation, b: Annotation): number {
  return timeOf(b) - timeOf(a) || compareByPosition(a, b);
}

/** Highlights by colour in the palette's order, then notes, then bookmarks; within each, reading order. */
const KIND_RANK: Record<MarkKind, number> = { highlight: 0, note: 1, bookmark: 2 };

export function compareByColor(a: Annotation, b: Annotation): number {
  const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (byKind !== 0) return byKind;
  if (a.kind === 'highlight') {
    const byColor = HIGHLIGHT_COLORS.indexOf(colorOf(a)) - HIGHLIGHT_COLORS.indexOf(colorOf(b));
    if (byColor !== 0) return byColor;
  }
  return compareByPosition(a, b);
}

export function sortMarks<T extends Annotation>(marks: readonly T[], order: SortOrder): T[] {
  const compare =
    order === 'newest' ? compareByNewest : order === 'color' ? compareByColor : compareByPosition;
  return [...marks].sort(compare);
}

/* -------------------------------------------------------------- chapters */

/**
 * Where a chapter begins, in the same coordinate `positionOf` uses for its
 * medium: a spine index for an ebook, a whole-book millisecond for audio.
 */
export interface ChapterStart {
  at: number;
  title: string;
}

/**
 * The chapter list GET /api/books/:id returns, reduced to starts. An ebook's
 * chapters are the top-level table of contents, each pointing at the spine
 * item it begins in; an audiobook's carry the time they start at. Entries
 * that point nowhere are dropped, and when two begin in the same place the
 * first keeps the name.
 */
export function chapterStarts(
  chapters: readonly { title: string; spineIdx?: number | null; startMs?: number | null }[],
): ChapterStart[] {
  const starts: ChapterStart[] = [];
  for (const c of chapters) {
    const at = c.spineIdx ?? c.startMs;
    if (at === null || at === undefined || !Number.isFinite(at)) continue;
    starts.push({ at, title: c.title });
  }
  starts.sort((x, y) => x.at - y.at);
  return starts.filter((s, i) => i === 0 || s.at !== starts[i - 1]!.at);
}

/** Index of the last chapter that begins at or before `unit`, or -1 before the first. */
export function chapterAt(starts: readonly ChapterStart[], unit: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]!.at <= unit) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export interface ChapterHead {
  kind: 'chapter';
  /** Index into the starts, or -1 for a mark before the first listed chapter. */
  index: number;
  /** Null when the book lists no chapter here; the page then names it by number. */
  title: string | null;
  /** Where the head's chapter begins - the spine index a nameless chapter is numbered from. */
  unit: number;
  medium: 'ebook' | 'audio';
}

/**
 * The chapter a mark falls in. A mark before the first listed chapter - the
 * front matter, or any mark in a book with no chapter list at all - is still
 * a place in an ebook, so it gets a head of its own, named by spine number.
 * Audio has no such number to fall back on, and gets no head.
 */
export function chapterOf(a: Annotation, starts: readonly ChapterStart[]): ChapterHead | null {
  const { unit } = positionOf(a);
  const index = chapterAt(starts, unit);
  if (index >= 0) {
    const start = starts[index]!;
    return { kind: 'chapter', index, title: start.title, unit: start.at, medium: a.locator.medium };
  }
  if (a.locator.medium === 'ebook') {
    return { kind: 'chapter', index: -1, title: null, unit, medium: 'ebook' };
  }
  return null;
}

/* -------------------------------------------------------------- sections */

export type SectionHead =
  | ChapterHead
  | { kind: 'color'; color: HighlightColor }
  | { kind: 'kind'; markKind: 'note' | 'bookmark' };

export interface Section<T extends Annotation> {
  key: string;
  /** What the running head says; null for a list that needs none. */
  head: SectionHead | null;
  marks: T[];
}

function chapterSection(
  a: Annotation,
  starts: readonly ChapterStart[],
): [string, SectionHead | null] {
  const head = chapterOf(a, starts);
  if (!head) return ['none', null];
  return [head.index >= 0 ? `ch:${head.index}` : `spine:${head.unit}`, head];
}

function colorSection(a: Annotation): [string, SectionHead] {
  if (a.kind === 'highlight') {
    const color = colorOf(a);
    return [`color:${color}`, { kind: 'color', color }];
  }
  return [`kind:${a.kind}`, { kind: 'kind', markKind: a.kind }];
}

/**
 * Marks in the chosen order, cut into sections with running heads: one per
 * chapter when sorted by position, one per colour (then notes, then
 * bookmarks) when sorted by colour, and a single headless list newest first.
 */
export function organise<T extends Annotation>(
  marks: readonly T[],
  order: SortOrder,
  starts: readonly ChapterStart[],
): Section<T>[] {
  const sorted = sortMarks(marks, order);
  if (order === 'newest') return sorted.length ? [{ key: 'all', head: null, marks: sorted }] : [];
  const sections: Section<T>[] = [];
  let current: Section<T> | null = null;
  for (const a of sorted) {
    const [key, head] = order === 'position' ? chapterSection(a, starts) : colorSection(a);
    if (!current || current.key !== key) {
      current = { key, head, marks: [] };
      sections.push(current);
    }
    current.marks.push(a);
  }
  return sections;
}

/* ------------------------------------------------------------- overview */

/** A type alias, not an interface: `t()` takes it as message values, which wants an index signature. */
export type KindCounts = Record<MarkKind, number>;

export function countByKind(marks: readonly Annotation[]): KindCounts {
  const counts: KindCounts = { highlight: 0, note: 0, bookmark: 0 };
  for (const a of marks) if (a.kind in counts) counts[a.kind] += 1;
  return counts;
}

/** The colours the highlights among these marks use, in the palette's order. */
export function colorsUsed(marks: readonly Annotation[]): HighlightColor[] {
  const used = new Set<HighlightColor>();
  for (const a of marks) if (a.kind === 'highlight') used.add(colorOf(a));
  return HIGHLIGHT_COLORS.filter((c) => used.has(c));
}

export function lastMarkedAt(marks: readonly Annotation[]): string | null {
  let latest: Annotation | null = null;
  for (const a of marks) if (!latest || timeOf(a) > timeOf(latest)) latest = a;
  return latest?.createdAt ?? null;
}

export interface BookRow<T extends Marked> {
  bookId: string;
  title: string;
  author: string | null;
  kind: 'ebook' | 'audio';
  hasCover: boolean;
  marks: T[];
  counts: KindCounts;
  colors: HighlightColor[];
  lastMarkedAt: string | null;
}

/** The books these marks belong to, most recently marked first, each with its own marks. */
export function booksOf<T extends Marked>(marks: readonly T[]): BookRow<T>[] {
  const rows = new Map<string, BookRow<T>>();
  for (const a of marks) {
    let row = rows.get(a.bookId);
    if (!row) {
      row = {
        bookId: a.bookId,
        title: a.bookTitle,
        author: a.bookAuthor,
        kind: a.bookKind ?? 'ebook',
        hasCover: a.bookHasCover ?? true,
        marks: [],
        counts: { highlight: 0, note: 0, bookmark: 0 },
        colors: [],
        lastMarkedAt: null,
      };
      rows.set(a.bookId, row);
    }
    row.marks.push(a);
  }
  const out = [...rows.values()];
  for (const row of out) {
    row.counts = countByKind(row.marks);
    row.colors = colorsUsed(row.marks);
    row.lastMarkedAt = lastMarkedAt(row.marks);
  }
  const when = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);
  return out.sort(
    (x, y) => when(y.lastMarkedAt) - when(x.lastMarkedAt) || x.title.localeCompare(y.title),
  );
}

/* -------------------------------------------------------------- the view */

/**
 * How one book's marks are being looked at. Kept in the URL so that going
 * back lands on the same view, and so the export page can be handed the very
 * same filters - "just the plum ones" exports just the plum ones.
 */
export interface MarksView {
  kind: KindFilter;
  colors: HighlightColor[];
  sort: SortOrder;
}

export const DEFAULT_VIEW: MarksView = { kind: 'all', colors: [], sort: 'position' };

export function viewFromParams(params: URLSearchParams): MarksView {
  const kind = params.get('kind');
  const sort = params.get('sort');
  const wanted = (params.get('colors') ?? '').split(',');
  return {
    kind: KIND_FILTERS.includes(kind as KindFilter) ? (kind as KindFilter) : DEFAULT_VIEW.kind,
    colors: HIGHLIGHT_COLORS.filter((c) => wanted.includes(c)),
    sort: SORT_ORDERS.includes(sort as SortOrder) ? (sort as SortOrder) : DEFAULT_VIEW.sort,
  };
}

/** Only what differs from the default, so an untouched view is a clean URL. */
export function viewToParams(view: MarksView): URLSearchParams {
  const params = new URLSearchParams();
  if (view.kind !== DEFAULT_VIEW.kind) params.set('kind', view.kind);
  const colors = view.colors.filter(isHighlightColor);
  if (colors.length > 0) params.set('colors', colors.join(','));
  if (view.sort !== DEFAULT_VIEW.sort) params.set('sort', view.sort);
  return params;
}

/* ------------------------------------------------------------ deep links */

/** The route that opens a mark at exactly the place it came from. */
export function hrefOf(a: Annotation): string {
  if (a.locator.medium !== 'ebook') {
    return `/listen/${a.bookId}?pos=${a.locator.bookMs ?? a.locator.positionMs}`;
  }
  const params = new URLSearchParams({ spine: String(a.locator.spineIdx) });
  if (a.locator.charOffset !== undefined) params.set('char', String(a.locator.charOffset));
  if (a.locator.sentenceId) params.set('sentence', a.locator.sentenceId);
  return `/read/${a.bookId}?${params.toString()}`;
}
