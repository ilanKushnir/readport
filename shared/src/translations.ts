import { z } from 'zod';
import { bookKindSchema } from './api.js';
import { ebookLocatorSchema, locatorSchema } from './locator.js';

/**
 * The same book in other languages.
 *
 * A curator links editions of one work that are in different languages - a
 * novel and its Russian translation - into one group, and ReadPort then
 * treats them as one book told twice: the book page names the other
 * languages, a friend reading the translation is on your bar, and a reader
 * can carry on in the other language from the paragraph they are on.
 *
 * A book's formats come along with it. An ebook and the audiobook it is
 * paired with are one TITLE, and linking either links both: the Russian
 * audiobook of an English book is its translation as much as the Russian
 * ebook is.
 */

/**
 * How closely two editions' texts have been matched, paragraph to paragraph.
 *
 * - `none`: there is no text to match on one side (an audiobook alone).
 * - `pending`: being worked out now, or waiting for a book to be indexed.
 * - `close`: most paragraphs found their counterpart one to one.
 * - `rough`: matched, loosely - an abridged or rearranged translation. Places
 *   still map, to about the right passage rather than the right paragraph.
 */
export const translationMatchSchema = z.enum(['none', 'pending', 'close', 'rough']);
export type TranslationMatch = z.infer<typeof translationMatchSchema>;

export const translationBookSchema = z.object({
  id: z.string(),
  kind: bookKindSchema,
  format: z.string(),
  hasCover: z.boolean(),
});
export type TranslationBook = z.infer<typeof translationBookSchema>;

/** One title in another language: its books, and where this reader is in it. */
export const translationTitleSchema = z.object({
  language: z.string().nullable(),
  title: z.string(),
  author: z.string().nullable(),
  /** The ebook first when there is one; its paired audiobook after it. */
  books: z.array(translationBookSchema).min(1),
  /** The reader's place in it: whichever of its books they touched last. Null when never opened. */
  progress: z
    .object({
      bookId: z.string(),
      pct: z.number(),
      finished: z.boolean(),
      updatedAt: z.string(),
    })
    .nullable(),
  /** How closely its text lines up with the book it was asked about. */
  match: translationMatchSchema,
});
export type TranslationTitle = z.infer<typeof translationTitleSchema>;

/** Why a book looks like a translation of another: each reason stands on its own. */
export const translationEvidenceSchema = z.object({
  /** The same author, whatever alphabet their name is written in. */
  author: z.boolean(),
  /** The same series, at the same place in it. */
  series: z.boolean(),
  /** About as long as a translation of the book would be. */
  length: z.boolean(),
  /** The same number of chapters, give or take. */
  chapters: z.boolean(),
});
export type TranslationEvidence = z.infer<typeof translationEvidenceSchema>;

export const translationSuggestionSchema = translationTitleSchema
  .omit({ progress: true, match: true })
  .extend({
    /** 0-1: how sure the guess is. */
    score: z.number(),
    evidence: translationEvidenceSchema,
  });
export type TranslationSuggestion = z.infer<typeof translationSuggestionSchema>;

/** A suggestion that names both sides, for the list of every guess in the library. */
export const translationPairSuggestionSchema = z.object({
  a: translationSuggestionSchema.omit({ score: true, evidence: true }),
  b: translationSuggestionSchema.omit({ score: true, evidence: true }),
  score: z.number(),
  evidence: translationEvidenceSchema,
});
export type TranslationPairSuggestion = z.infer<typeof translationPairSuggestionSchema>;

/**
 * How a place was carried across: to the matching paragraph, or - with no
 * paragraph match to go by - to the same share of the way through.
 */
export const translationPrecisionSchema = z.enum(['paragraph', 'proportional']);
export type TranslationPrecision = z.infer<typeof translationPrecisionSchema>;

/** A place in one edition, found in another. */
export const translationMapResponseSchema = z.object({
  bookId: z.string(),
  to: locatorSchema,
  precision: translationPrecisionSchema,
});
export type TranslationMapResponse = z.infer<typeof translationMapResponseSchema>;

/** A passage, as the other language has it. */
export const translationPassageSchema = z.object({
  bookId: z.string(),
  language: z.string().nullable(),
  direction: z.enum(['ltr', 'rtl']),
  /** The matching paragraphs, in order. */
  paragraphs: z.array(z.string()),
  /** Where they start, to carry on reading from. */
  to: ebookLocatorSchema,
  /** The paragraphs of the book asked from that they match, to mark on its page. */
  source: z.object({
    spineIdx: z.number().int().min(0),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  }),
  precision: translationPrecisionSchema,
});
export type TranslationPassage = z.infer<typeof translationPassageSchema>;

/**
 * A translation of a book is a different number of characters long: Russian
 * runs a little longer than English, Hebrew and Finnish shorter, Chinese and
 * Japanese far shorter. Characters of each language per character of
 * English, from parallel literary texts; a language not here is taken to be
 * about as long as English. Used to judge whether a book is the length a
 * translation of another would be, never to align them - the aligner
 * measures the ratio of the two texts in front of it.
 */
export const TEXT_EXPANSION: Record<string, number> = {
  en: 1,
  ru: 1.08,
  uk: 1.06,
  de: 1.14,
  fr: 1.16,
  es: 1.12,
  it: 1.1,
  pt: 1.1,
  nl: 1.1,
  pl: 1.05,
  cs: 0.98,
  ro: 1.1,
  sv: 1.0,
  da: 1.0,
  nb: 1.0,
  no: 1.0,
  fi: 1.0,
  el: 1.12,
  tr: 1.0,
  he: 0.78,
  ar: 0.85,
  ja: 0.42,
  zh: 0.3,
  ko: 0.45,
};

/** How many characters of `to` one character of `from` is likely to become. */
export function expansionRatio(from: string | null, to: string | null): number {
  const a = (from && TEXT_EXPANSION[from]) || 1;
  const b = (to && TEXT_EXPANSION[to]) || 1;
  return b / a;
}
