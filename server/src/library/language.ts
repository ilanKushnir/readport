import { type LanguageSource, normaliseLanguage } from '@readport/shared';
import { type DB } from '../db/index.js';
import { latestAlignment } from '../alignment/service.js';

/**
 * What language a book is in, worked out from evidence in a fixed order and
 * written back to the row every time any of that evidence changes.
 *
 * For an ebook:
 *   1. a curator's override, which survives every rescan;
 *   2. what reading its prose said - the detector answers only when the
 *      windows it read agree with a clear margin, and a confident reading
 *      of the text outranks the tag in the file, because the tag is so
 *      often a tool's default (Calibre stamps "en" on everything it is not
 *      told about) and the prose cannot be;
 *   3. what the file declares (dc:language);
 *   4. what the other, VERIFIED edition of the same book knows;
 *   5. nothing - and "nothing" is browsable as Unknown.
 *
 * For an audiobook, which has no prose of its own:
 *   1. a curator's override;
 *   2. what the file declares (the audio language tag);
 *   3. what the other, VERIFIED edition of the same book knows - confirmed by
 *      a person, or an automatic pair whose narration has been checked
 *      against the text; an unverified suggestion lends nothing, because a
 *      wrong guess about which book this is must not become a wrong guess
 *      about its language too;
 *   4. anything detection stored for it;
 *   5. nothing.
 *
 * Recomputed, not cached: whenever indexing, pairing, alignment or an
 * override changes, both books of the affected pair are recomputed, so the
 * evidence a pair lent is taken back the moment the pair is no longer
 * trusted.
 */

interface LanguageRow {
  id: string;
  kind: string;
  language_manual: string | null;
  language_metadata: string | null;
  language_detected: string | null;
  language: string | null;
  language_source: string | null;
}

function ownEvidence(row: LanguageRow): { language: string; source: LanguageSource } | null {
  const manual = normaliseLanguage(row.language_manual);
  if (manual) return { language: manual, source: 'manual' };
  const metadata = normaliseLanguage(row.language_metadata);
  const detected = normaliseLanguage(row.language_detected);
  // An ebook's prose outranks its tag; an audiobook's tag is all it has of its own.
  const ladder: [string | null, LanguageSource][] =
    row.kind === 'ebook'
      ? [
          [detected, 'detected'],
          [metadata, 'metadata'],
        ]
      : [
          [metadata, 'metadata'],
          [detected, 'detected'],
        ];
  for (const [language, source] of ladder) if (language) return { language, source };
  return null;
}

function rowFor(db: DB, bookId: string): LanguageRow | null {
  return (
    (db
      .prepare(
        `SELECT id, kind, language_manual, language_metadata, language_detected, language, language_source
           FROM books WHERE id = ?`,
      )
      .get(bookId) as LanguageRow | undefined) ?? null
  );
}

/** The other edition of a verified pair, or null. */
export function verifiedCounterpart(db: DB, bookId: string): string | null {
  const pairs = db
    .prepare(
      `SELECT id, status, ebook_id, audio_id FROM pairs
        WHERE (ebook_id = ? OR audio_id = ?) AND status IN ('confirmed', 'auto')
        ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END`,
    )
    .all(bookId, bookId) as { id: string; status: string; ebook_id: string; audio_id: string }[];
  for (const p of pairs) {
    const verified = p.status === 'confirmed' || latestAlignment(db, p.id) !== null;
    if (!verified) continue;
    return p.ebook_id === bookId ? p.audio_id : p.ebook_id;
  }
  return null;
}

/**
 * Work out and store one book's language. Returns what was stored. A pass
 * that changes nothing writes nothing, so a rescan of a settled library is
 * not a write per book.
 */
export function recomputeBookLanguage(
  db: DB,
  bookId: string,
): { language: string | null; source: LanguageSource | null } {
  const row = rowFor(db, bookId);
  if (!row) return { language: null, source: null };
  let answer: { language: string; source: LanguageSource } | null = null;
  const own = ownEvidence(row);
  // Everything an ebook knows about itself beats what a pair lends; an
  // audiobook's stored detection is the one thing a verified pair outranks.
  if (own && (row.kind === 'ebook' || own.source !== 'detected')) answer = own;
  if (!answer) {
    const other = verifiedCounterpart(db, bookId);
    const otherRow = other ? rowFor(db, other) : null;
    // The counterpart lends its OWN evidence, never something it borrowed:
    // two books lending each other nothing would otherwise agree on it.
    const lent = otherRow ? ownEvidence(otherRow) : null;
    if (lent) answer = { language: lent.language, source: 'pair' };
  }
  if (!answer && own) answer = own; // detected
  const language = answer?.language ?? null;
  const source = answer?.source ?? null;
  if (row.language !== language || row.language_source !== source) {
    db.prepare('UPDATE books SET language = ?, language_source = ? WHERE id = ?').run(
      language,
      source,
      bookId,
    );
  }
  return { language, source };
}

/** Both sides of a pair: pairing is evidence for each of them. */
export function recomputePairLanguages(db: DB, pairId: string): void {
  const p = db.prepare('SELECT ebook_id, audio_id FROM pairs WHERE id = ?').get(pairId) as
    { ebook_id: string; audio_id: string } | undefined;
  if (!p) return;
  recomputeBookLanguage(db, p.ebook_id);
  recomputeBookLanguage(db, p.audio_id);
}

/** A book and whatever it is paired with, verified or not - for when the pairing itself changed. */
export function recomputeBookAndPartners(db: DB, bookId: string): void {
  recomputeBookLanguage(db, bookId);
  const partners = db
    .prepare('SELECT ebook_id, audio_id FROM pairs WHERE ebook_id = ? OR audio_id = ?')
    .all(bookId, bookId) as { ebook_id: string; audio_id: string }[];
  for (const p of partners) {
    const other = p.ebook_id === bookId ? p.audio_id : p.ebook_id;
    recomputeBookLanguage(db, other);
  }
}

/**
 * A curator's word. Null clears it and lets the evidence speak again. The
 * counterpart of a verified pair is recomputed too: an override on the
 * ebook is the best evidence its audiobook has.
 */
export function setBookLanguageOverride(db: DB, bookId: string, code: string | null): void {
  db.prepare('UPDATE books SET language_manual = ? WHERE id = ?').run(code, bookId);
  recomputeBookAndPartners(db, bookId);
}
