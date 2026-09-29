import {
  type Annotation,
  type NotesExportDocument,
  type NotesExportMark,
  type NotesExportSection,
} from '@readport/shared';
import { type TranslateFn } from '../i18n';
import { COLOR_LABELS, colorOf } from '../reader/marks';
import { CHAPTER_ORDER, type ExportOptions } from './exportOptions';
import {
  chapterOf,
  colorsUsed,
  countByKind,
  organise,
  type ChapterStart,
  type KindCounts,
  type SectionHead,
} from './organise';

/**
 * The pages of an export, written out: every word on them, in the reader's
 * language, for the server to set in type (shared/src/notesExport.ts).
 *
 * Pure, so what goes on the pages - which chapters open with their names,
 * what the line under a passage says, which way each paragraph runs - is
 * pinned down by tests rather than by looking at PDFs.
 */

/** Chapters it takes before an export by chapter gets a contents page. */
export const CONTENTS_MIN_CHAPTERS = 4;

const FSI = '⁨';
const PDI = '⁩';
/**
 * A name set into a sentence of another direction - a Hebrew title in an
 * English line, "ReadPort" in a Hebrew one - kept whole and in its own
 * direction, so the words and numbers around it stay where they were put.
 */
export const isolate = (s: string): string => `${FSI}${s}${PDI}`;

const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LETTER = /\p{L}/u;

/** Which way a paragraph runs: the way of its first letter, or `fallback` when it has none. */
export function directionOf(
  text: string | null | undefined,
  fallback: 'ltr' | 'rtl',
): 'ltr' | 'rtl' {
  for (const ch of text ?? '') {
    if (RTL_LETTER.test(ch)) return 'rtl';
    if (LETTER.test(ch)) return 'ltr';
  }
  return fallback;
}

/** A language as the typesetter takes it - "zh" for zh-Hans, "pt" for pt-BR - or null. */
export function typesetLanguage(tag: string | null | undefined): string | null {
  const primary = (tag ?? '').split(/[-_]/)[0]!.toLowerCase();
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

/** The words an export is written in, from the interface's own hooks. */
export interface ExportWords {
  t: TranslateFn;
  number: (n: number) => string;
  percent: (pct: number) => string;
  date: (iso: string) => string;
  /** A section's name: the chapter, the colour, or the kind of mark. */
  sectionTitle: (head: SectionHead | null) => string | null;
  /** "12 highlights · 3 notes". */
  counts: (c: KindCounts) => string;
  /** What the export was narrowed to, one line each. */
  exportScope: (options: ExportOptions) => string[];
}

export interface ExportInput {
  book: { title: string; author: string | null; language: string | null; hasCover: boolean };
  /** The book's own direction, for passages that have no letters to say. */
  bookDir: 'ltr' | 'rtl';
  /** The marks going in, already chosen (selectForExport). */
  marks: readonly Annotation[];
  starts: readonly ChapterStart[];
  options: ExportOptions;
  /** The reader's name, for "Marked by…"; null leaves the line off. */
  reader: string | null;
  now: Date;
  ui: { tag: string; dir: 'ltr' | 'rtl' };
  words: ExportWords;
}

const FIGURES = [
  ['highlight', 'notes.export.figure.highlights'],
  ['note', 'notes.export.figure.notes'],
  ['bookmark', 'notes.export.figure.bookmarks'],
] as const;

export function buildExportDocument(input: ExportInput): NotesExportDocument {
  const { book, bookDir, marks, starts, options, reader, now, ui, words } = input;
  const { t } = words;
  const title = book.title.trim() || t('common.unknown');

  /** "Chapter 4 · 37%", or the percentage alone under the chapter's own name. */
  const placeOf = (a: Annotation, underChapter: boolean): string => {
    const pct = words.percent(a.locator.pct);
    if (underChapter) return pct;
    const chapter = words.sectionTitle(chapterOf(a, starts));
    return chapter ? t('notes.where', { chapter: isolate(chapter), pct }) : pct;
  };

  const markOf = (a: Annotation, underChapter: boolean): NotesExportMark => {
    const place = placeOf(a, underChapter);
    const date = words.date(a.createdAt);
    const text = a.kind === 'bookmark' ? null : a.selectedText?.trim() || null;
    // A highlight's note goes in when notes are wanted; a note that is the
    // mark itself, and a bookmark's, always.
    const note = a.kind === 'highlight' && !options.notes ? null : a.note?.trim() || null;
    const where =
      a.kind === 'bookmark'
        ? options.where
          ? t('notes.export.whereWhen', {
              where: t('notes.export.bookmarkAt', { where: place }),
              date,
            })
          : t('notes.export.bookmarkAt', { where: place })
        : options.where
          ? t('notes.export.whereWhen', { where: place, date })
          : null;
    return {
      kind: a.kind,
      color: a.kind === 'highlight' ? colorOf(a) : null,
      text,
      note,
      where,
      dir: directionOf(text, bookDir),
      noteDir: directionOf(note, ui.dir),
    };
  };

  const byChapter = options.sort === CHAPTER_ORDER;
  const named = byChapter && options.chapters;
  const organised = organise(marks, options.sort, starts);
  let sections: NotesExportSection[];
  if (byChapter && !named) {
    // Book order without the names: one run, each line saying its chapter.
    const all = organised.flatMap((s) => s.marks);
    sections = all.length
      ? [
          {
            kind: null,
            head: null,
            dir: ui.dir,
            color: null,
            count: null,
            marks: all.map((a) => markOf(a, false)),
          },
        ]
      : [];
  } else {
    sections = organised.map((s): NotesExportSection => {
      const head = s.head ? words.sectionTitle(s.head) : null;
      const count = head ? words.counts(countByKind(s.marks)) : null;
      if (s.head?.kind === 'chapter') {
        return {
          kind: 'chapter',
          head,
          dir: directionOf(head, bookDir),
          color: null,
          count,
          marks: s.marks.map((a) => markOf(a, true)),
        };
      }
      return {
        kind: s.head ? (s.head.kind === 'color' ? 'color' : 'kind') : null,
        head,
        dir: ui.dir,
        color: s.head?.kind === 'color' ? s.head.color : null,
        count,
        marks: s.marks.map((a) => markOf(a, false)),
      };
    });
  }

  const counts = countByKind(marks);
  const app = t('common.appName');
  const lang = typesetLanguage(ui.tag) ?? 'en';
  return {
    look: options.look,
    page: options.page,
    text: options.text,
    lang,
    dir: ui.dir,
    bookLang: typesetLanguage(book.language),
    title,
    titleDir: directionOf(title, bookDir),
    author: book.author?.trim() || null,
    cover: options.cover && book.hasCover,
    reader,
    contents: named && sections.filter((s) => s.kind === 'chapter').length >= CONTENTS_MIN_CHAPTERS,
    labels: {
      app,
      heading: t('notes.export.heading'),
      contents: t('notes.export.contents'),
      note: t('notes.export.noteLabel'),
      bookmark: t('notes.export.bookmark'),
      marked: t('notes.markedPassage'),
      empty: t('notes.export.empty'),
      reader: reader ? t('notes.export.markedBy', { name: isolate(reader) }) : null,
      stamp: t('notes.export.whereWhen', {
        where: t('notes.export.from', { app: isolate(app) }),
        date: words.date(now.toISOString()),
      }),
      closing: t('notes.export.closing', { title: isolate(title) }),
    },
    figures: FIGURES.filter(([kind]) => counts[kind] > 0).map(([kind, key]) => ({
      n: words.number(counts[kind]),
      label: t(key, { n: counts[kind] }),
    })),
    scope: words.exportScope(options),
    legend: colorsUsed(marks).map((color) => ({ color, label: t(COLOR_LABELS[color]) })),
    sections,
  };
}

/** What the saved file is called: "The Title – Highlights & notes.pdf", safe for any disk. */
export function exportFileName(title: string, t: TranslateFn): string {
  const name = t('notes.export.documentTitle', { title })
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${name || 'ReadPort'}.pdf`;
}
