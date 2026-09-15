import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { storeAlignment } from '../alignment/service.js';
import {
  recomputeBookLanguage,
  recomputePairLanguages,
  setBookLanguageOverride,
} from './language.js';

/**
 * Where a book's language comes from, in order: a curator's word, the file's
 * own tag, the other verified edition of the same book, the prose. Each of
 * the tests below is one rung of that ladder, and the ones about pairs are
 * about evidence being lent and taken back.
 */

let dir: string;
let db: DB;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-language-'));
  db = openDatabase(dir);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function book(
  kind: 'ebook' | 'audio',
  evidence: { metadata?: string | null; detected?: string | null; manual?: string | null } = {},
): string {
  const id = `${kind}${++seq}`;
  db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, scan_state, added_at,
       language_metadata, language_detected, language_manual)
     VALUES (?, ?, '/lib', ?, ?, ?, 'ready', '2026-01-01T00:00:00.000Z', ?, ?, ?)`,
  ).run(
    id,
    kind,
    `${id}.file`,
    kind === 'ebook' ? 'epub' : 'mp3',
    `Title ${id}`,
    evidence.metadata ?? null,
    evidence.detected ?? null,
    evidence.manual ?? null,
  );
  recomputeBookLanguage(db, id);
  return id;
}
function pair(
  ebookId: string,
  audioId: string,
  status: 'candidate' | 'auto' | 'confirmed',
): string {
  const id = `pair-${ebookId}-${audioId}`;
  db.prepare(
    `INSERT INTO pairs (id, ebook_id, audio_id, status, score, created_at) VALUES (?, ?, ?, ?, 0.9, '2026-01-01T00:00:00.000Z')`,
  ).run(id, ebookId, audioId, status);
  recomputePairLanguages(db, id);
  return id;
}
const stored = (id: string) =>
  db.prepare('SELECT language, language_source AS source FROM books WHERE id = ?').get(id) as {
    language: string | null;
    source: string | null;
  };

describe('one book on its own', () => {
  it("takes the file's own tag over what the prose suggests", () => {
    const id = book('ebook', { metadata: 'fr', detected: 'en' });
    expect(stored(id)).toEqual({ language: 'fr', source: 'metadata' });
  });
  it('falls back to the prose when the file says nothing', () => {
    const id = book('ebook', { detected: 'de' });
    expect(stored(id)).toEqual({ language: 'de', source: 'detected' });
  });
  it('is unknown when nothing is known, and a tag that says "und" is nothing', () => {
    expect(stored(book('ebook'))).toEqual({ language: null, source: null });
    expect(stored(book('ebook', { metadata: 'und' }))).toEqual({ language: null, source: null });
  });
  it("a curator's word outranks everything and survives a rescan", () => {
    const id = book('ebook', { metadata: 'fr', detected: 'en' });
    setBookLanguageOverride(db, id, 'he');
    expect(stored(id)).toEqual({ language: 'he', source: 'manual' });
    // The rescan rewrites the file's evidence; the override is not evidence.
    db.prepare("UPDATE books SET language_metadata = 'it' WHERE id = ?").run(id);
    recomputeBookLanguage(db, id);
    expect(stored(id)).toEqual({ language: 'he', source: 'manual' });
    setBookLanguageOverride(db, id, null);
    expect(stored(id)).toEqual({ language: 'it', source: 'metadata' });
  });
});

describe('a pair as evidence', () => {
  it("a confirmed pair lends the untagged audiobook the ebook's language", () => {
    const e = book('ebook', { metadata: 'fr' });
    const a = book('audio');
    pair(e, a, 'confirmed');
    expect(stored(a)).toEqual({ language: 'fr', source: 'pair' });
    expect(stored(e)).toEqual({ language: 'fr', source: 'metadata' });
  });
  it('a suggestion nobody has verified lends nothing', () => {
    const e = book('ebook', { metadata: 'fr' });
    const a = book('audio');
    pair(e, a, 'candidate');
    expect(stored(a)).toEqual({ language: null, source: null });
    const a2 = book('audio');
    pair(book('ebook', { metadata: 'es' }), a2, 'auto');
    expect(stored(a2)).toEqual({ language: null, source: null });
  });
  it('an automatic pair becomes evidence once its narration has been aligned to the text', () => {
    const e = book('ebook', { metadata: 'fr' });
    const a = book('audio');
    const p = pair(e, a, 'auto');
    storeAlignment(
      db,
      p,
      'fr',
      'model',
      { segments: [], gaps: [], coverage: 1, meanConfidence: 1 },
      {},
    );
    recomputePairLanguages(db, p);
    expect(stored(a)).toEqual({ language: 'fr', source: 'pair' });
  });
  it("the file's own tag still beats what a pair lends, and the prose does not", () => {
    const e = book('ebook', { metadata: 'fr' });
    const tagged = book('audio', { metadata: 'en' });
    pair(e, tagged, 'confirmed');
    expect(stored(tagged)).toEqual({ language: 'en', source: 'metadata' });
    const guessed = book('ebook', { detected: 'de' });
    const a = book('audio', { metadata: 'fr' });
    pair(guessed, a, 'confirmed');
    expect(stored(guessed)).toEqual({ language: 'fr', source: 'pair' });
  });
  it('rejecting the pair takes the lent language back', () => {
    const e = book('ebook', { metadata: 'fr' });
    const a = book('audio');
    const p = pair(e, a, 'confirmed');
    db.prepare("UPDATE pairs SET status = 'rejected' WHERE id = ?").run(p);
    recomputePairLanguages(db, p);
    expect(stored(a)).toEqual({ language: null, source: null });
  });
  it("a curator's override on one edition reaches the other", () => {
    const e = book('ebook');
    const a = book('audio');
    pair(e, a, 'confirmed');
    setBookLanguageOverride(db, e, 'pt');
    expect(stored(a)).toEqual({ language: 'pt', source: 'pair' });
    setBookLanguageOverride(db, e, null);
    expect(stored(a)).toEqual({ language: null, source: null });
  });
  it('lends only what it knows itself, never what it was lent', () => {
    // Two untagged editions: neither can hand the other a language it does
    // not have, so nothing circular ever appears.
    const e = book('ebook');
    const a = book('audio');
    pair(e, a, 'confirmed');
    expect(stored(e)).toEqual({ language: null, source: null });
    expect(stored(a)).toEqual({ language: null, source: null });
  });
});
