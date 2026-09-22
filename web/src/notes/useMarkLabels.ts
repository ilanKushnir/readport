import { useMemo } from 'react';
import { type Annotation } from '@readport/shared';
import { useT } from '../i18n';
import { type MessageKey } from '../i18n/messages/en';
import { useFormat } from '../i18n/useFormat';
import { COLOR_LABELS, type HighlightColor } from '../reader/marks';
import { type ExportOptions, MARK_KINDS } from './exportOptions';
import {
  chapterOf,
  type ChapterHead,
  type ChapterStart,
  type KindCounts,
  type MarkKind,
  type MarksView,
  type SectionHead,
  type SortOrder,
} from './organise';

const KIND_NAMES: Record<MarkKind, MessageKey> = {
  highlight: 'notes.filter.highlights',
  note: 'notes.filter.notes',
  bookmark: 'notes.filter.bookmarks',
};

const SORT_NAMES: Record<SortOrder, MessageKey> = {
  position: 'notes.sort.position',
  newest: 'notes.sort.newest',
  color: 'notes.sort.color',
};

/** The words the Notes pages put beside what `organise` works out. */
export function useMarkLabels() {
  const t = useT();
  const f = useFormat();
  return useMemo(() => {
    const chapterName = (head: ChapterHead): string =>
      head.title ?? t('common.chapterN', { n: head.unit + 1 });
    const colourName = (c: HighlightColor): string => t(`notes.colour.${c}` as const);
    return {
      /** A running head: the chapter, the colour, or the kind of mark. */
      sectionTitle(head: SectionHead | null): string | null {
        if (!head) return null;
        if (head.kind === 'chapter') return chapterName(head);
        if (head.kind === 'color') return t(COLOR_LABELS[head.color]);
        return head.markKind === 'note' ? t('notes.filter.notes') : t('notes.filter.bookmarks');
      },
      /** "Chapter 4 · 37%", or the percentage alone where the book lists no chapter. */
      where(a: Annotation, starts: readonly ChapterStart[]): string {
        const pct = f.percent(a.locator.pct);
        const chapter = chapterOf(a, starts);
        return chapter ? t('notes.where', { chapter: chapterName(chapter), pct }) : pct;
      },
      /** "12 highlights · 3 notes"; a kind with none is left out. */
      counts(c: KindCounts): string {
        const parts: string[] = [];
        if (c.highlight) parts.push(t('notes.book.highlights', { n: c.highlight }));
        if (c.note) parts.push(t('notes.book.notes', { n: c.note }));
        if (c.bookmark) parts.push(t('notes.book.bookmarks', { n: c.bookmark }));
        return parts.join(' · ');
      },
      /**
       * What a filtered view leaves in - "Only highlights in plum and sky" -
       * or null when nothing has been filtered out. Colours imply highlights,
       * so they are named ahead of the kind.
       */
      scope(view: MarksView): string | null {
        if (view.colors.length > 0) {
          return t('notes.export.scope.colours', { list: f.list(view.colors.map(colourName)) });
        }
        if (view.kind !== 'all') return t('notes.export.scope.kind', { kind: view.kind });
        return null;
      },
      /**
       * What an export was narrowed to, one line per narrowing: the kinds
       * when not every kind went in, the colours when the highlights were
       * filtered. Nothing for an export of everything.
       */
      exportScope(options: ExportOptions): string[] {
        const lines: string[] = [];
        const kinds = MARK_KINDS.filter((k) => options.kinds.includes(k));
        if (kinds.length === 1) {
          lines.push(t('notes.export.scope.kind', { kind: kinds[0] }));
        } else if (kinds.length === 2) {
          lines.push(t('notes.export.scope.kinds', { kinds: kinds.map((k) => k[0]).join('') }));
        }
        if (options.colors.length > 0) {
          lines.push(
            t('notes.export.scope.colours', { list: f.list(options.colors.map(colourName)) }),
          );
        }
        return lines;
      },
      /** "Highlights", "Notes", "Bookmarks": a kind as a filter or a checkbox names it. */
      kindName: (kind: MarkKind): string => t(KIND_NAMES[kind]),
      sortName: (order: SortOrder): string => t(SORT_NAMES[order]),
      colourName,
    };
  }, [t, f]);
}
