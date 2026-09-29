import { z } from 'zod';

/**
 * A book's highlights and notes, as the pages of a PDF.
 *
 * The app decides everything a reader sees on those pages - which marks go
 * in and in what order, under which chapters, and every word around them in
 * the reader's own language - and hands the server this: the document,
 * already written. The server only sets it in type (server/typst/notes.typ),
 * with the book's cover, and sends the pages back. So there is one place
 * that knows the reader's language and their filters (the app), and one
 * that knows how to make a page (the server), and neither pretends to be
 * the other.
 *
 * Nothing here is markup. A passage, a note or a chapter name is printed as
 * the characters it is; the limits are there so a request stays a document.
 */

export const NOTES_EXPORT_LOOKS = ['paper', 'night'] as const;
export const NOTES_EXPORT_PAGES = ['a4', 'letter', 'phone'] as const;
export const NOTES_EXPORT_TEXT_SIZES = ['compact', 'comfortable', 'large'] as const;
/** The reader's highlight colours, as the pages print them. */
export const NOTES_EXPORT_COLORS = ['amber', 'rose', 'plum', 'sky', 'sand'] as const;

/** The most marks one export may hold: far past any book's worth, well short of a flood. */
export const NOTES_EXPORT_MAX_MARKS = 10_000;
/** How many pages a preview shows before "and so many more". */
export const NOTES_EXPORT_PREVIEW_PAGES = 6;

const words = (max: number) => z.string().max(max);
const direction = z.enum(['ltr', 'rtl']);
/** A language as the typesetter takes it: the ISO 639 code alone, "zh" not "zh-Hans". */
const language = z.string().regex(/^[a-z]{2,3}$/);
const color = z.enum(NOTES_EXPORT_COLORS);

export const notesExportMarkSchema = z.object({
  kind: z.enum(['highlight', 'note', 'bookmark']),
  color: color.nullable(),
  /** The passage marked, when there is one. */
  text: words(50_000).nullable(),
  /** The reader's own words, when there are some and they go in. */
  note: words(50_000).nullable(),
  /** "4% · 12 Sept 2026": where in the book, and when; null when left out. */
  where: words(300).nullable(),
  /** The passage's direction, and the note's, each as it is written. */
  dir: direction,
  noteDir: direction,
});

export const notesExportSectionSchema = z.object({
  /** What opens it: a chapter's name, a colour, a kind of mark - or nothing. */
  kind: z.enum(['chapter', 'color', 'kind']).nullable(),
  head: words(1_000).nullable(),
  dir: direction,
  color: color.nullable(),
  /** "3 highlights · 1 note", under the head. */
  count: words(200).nullable(),
  marks: z.array(notesExportMarkSchema).max(NOTES_EXPORT_MAX_MARKS),
});

export const notesExportSchema = z
  .object({
    look: z.enum(NOTES_EXPORT_LOOKS),
    page: z.enum(NOTES_EXPORT_PAGES),
    text: z.enum(NOTES_EXPORT_TEXT_SIZES),
    /** The interface's language and direction: the labels, the running heads. */
    lang: language,
    dir: direction,
    /** The book's language, for the passages and the title; null when unknown. */
    bookLang: language.nullable(),
    title: words(1_000).min(1),
    titleDir: direction,
    author: words(1_000).nullable(),
    /** Whether the cover is wanted on the title page. The server has the picture. */
    cover: z.boolean(),
    /** The reader's name, for the document's properties. */
    reader: words(200).nullable(),
    /** A contents page, for an export long enough by chapter to need one. */
    contents: z.boolean(),
    labels: z.object({
      app: words(100),
      heading: words(200),
      contents: words(200),
      note: words(100),
      bookmark: words(100),
      /** A mark with neither a passage nor words of its own. */
      marked: words(200),
      empty: words(300),
      /** "Marked by Astra Vell"; null to leave the line off. */
      reader: words(300).nullable(),
      /** "Exported from ReadPort · 29 September 2026". */
      stamp: words(300),
      /** The last line, under the last mark. */
      closing: words(1_500),
    }),
    /** "12 highlights", "3 notes": what the export holds, for the title page. */
    figures: z.array(z.object({ n: words(20), label: words(100) })).max(3),
    /** What the export was narrowed to, one line each. */
    scope: z.array(words(300)).max(4),
    /** The colours the highlights use, each with its name. */
    legend: z.array(z.object({ color, label: words(100) })).max(NOTES_EXPORT_COLORS.length),
    sections: z.array(notesExportSectionSchema).max(NOTES_EXPORT_MAX_MARKS),
  })
  .refine((d) => d.sections.reduce((n, s) => n + s.marks.length, 0) <= NOTES_EXPORT_MAX_MARKS, {
    message: `At most ${NOTES_EXPORT_MAX_MARKS} marks in one export`,
    path: ['sections'],
  });

export type NotesExportDocument = z.infer<typeof notesExportSchema>;
export type NotesExportSection = z.infer<typeof notesExportSectionSchema>;
export type NotesExportMark = z.infer<typeof notesExportMarkSchema>;

/** What POST /api/books/:id/notes/export answers with. */
export interface NotesExportResult {
  /** How many pages the PDF has. */
  pageCount: number;
  /** The first pages, each a standalone SVG picture of the page. */
  pages: string[];
  /** The PDF itself, base64. */
  pdf: string;
}
