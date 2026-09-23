import {
  type AudioLocator,
  type EbookLocator,
  type Locator,
  type TranslationPassage,
  type TranslationPrecision,
} from '@readport/shared';
import { type AppContext, activeDerivedDir } from '../context.js';
import {
  loadChapterText,
  loadManifest,
  loadSentences,
  type BookManifest,
} from '../epub/extract.js';
import { resolveAudioToEbook, resolveEbookToAudio } from '../alignment/service.js';
import { pairResolveContext, settledPairOf } from '../alignment/resolve-context.js';
import { carry } from './align.js';
import { storedMatch } from './store.js';

/**
 * Finding a place of one edition in another language's edition.
 *
 * Text to text goes through the paragraph match (store.ts): the place lands
 * in the matching paragraph. An audiobook takes one more step on either
 * end, through its own pair's narration alignment - the Russian audiobook's
 * minute 212 is a sentence of the Russian ebook, which is a paragraph of the
 * English one. Where a step is missing (not matched yet, never aligned, no
 * ebook on that side), the place is carried as the same share of the way
 * through, and said to be.
 */

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function ebookManifest(ctx: AppContext, bookId: string): BookManifest | null {
  return loadManifest(activeDerivedDir(ctx, bookId));
}

function kindOf(ctx: AppContext, bookId: string): 'ebook' | 'audio' | null {
  const row = ctx.db.prepare('SELECT kind FROM books WHERE id = ?').get(bookId) as
    { kind: string } | undefined;
  return row ? (row.kind === 'audio' ? 'audio' : 'ebook') : null;
}

/** A chapter-local offset as an offset into the whole book. */
function toGlobal(manifest: BookManifest, spineIdx: number, charOffset: number): number {
  const ch = manifest.chapters[spineIdx];
  if (!ch) return 0;
  return ch.cumChars + Math.min(Math.max(0, charOffset), ch.charCount);
}

/** An offset into the whole book as a chapter and an offset in it. */
function fromGlobal(manifest: BookManifest, g: number): { spineIdx: number; charOffset: number } {
  const chapters = manifest.chapters;
  let spineIdx = 0;
  for (const ch of chapters) {
    // The last chapter that starts at or before g and has text: an empty
    // chapter shares its start with the one after it.
    if (ch.cumChars <= g && (ch.charCount > 0 || ch.cumChars < g)) spineIdx = ch.idx;
    else if (ch.cumChars > g) break;
  }
  const ch = chapters[spineIdx]!;
  return {
    spineIdx,
    charOffset: Math.max(0, Math.min(g - ch.cumChars, Math.max(0, ch.charCount - 1))),
  };
}

/** The start of the sentence an offset falls in, so a reader lands on a sentence rather than inside one. */
function sentenceAt(
  ctx: AppContext,
  bookId: string,
  spineIdx: number,
  charOffset: number,
): { id: string; start: number } | null {
  const sentences = loadSentences(activeDerivedDir(ctx, bookId))?.[spineIdx];
  if (!sentences?.length) return null;
  let found = sentences[0]!;
  for (const s of sentences) {
    if (s.start <= charOffset) found = s;
    else break;
  }
  return { id: found.id, start: found.start };
}

function ebookLocatorAt(
  ctx: AppContext,
  bookId: string,
  manifest: BookManifest,
  g: number,
  snap: boolean,
): EbookLocator {
  const { spineIdx, charOffset } = fromGlobal(manifest, g);
  const sentence = snap ? sentenceAt(ctx, bookId, spineIdx, charOffset) : null;
  const offset = sentence ? sentence.start : charOffset;
  return {
    medium: 'ebook',
    spineIdx,
    ...(sentence ? { sentenceId: sentence.id } : {}),
    charOffset: offset,
    pct: round4(
      manifest.totalChars > 0 ? toGlobal(manifest, spineIdx, offset) / manifest.totalChars : 0,
    ),
  };
}

/** A place in a book, as a place in an ebook's text: itself, or its paired ebook through the narration. */
function asTextPlace(
  ctx: AppContext,
  bookId: string,
  from: Locator,
): { ebookId: string; manifest: BookManifest; global: number } | null {
  if (from.medium === 'ebook') {
    const manifest = ebookManifest(ctx, bookId);
    if (!manifest) return null;
    return {
      ebookId: bookId,
      manifest,
      global: toGlobal(manifest, from.spineIdx, from.charOffset ?? 0),
    };
  }
  const pair = settledPairOf(ctx, bookId);
  const resolved = pair ? pairResolveContext(ctx, pair.id) : null;
  if (!resolved) return null;
  const outcome = resolveAudioToEbook(resolved.rctx, from as AudioLocator);
  if (!outcome.to || outcome.to.medium !== 'ebook') return null;
  const manifest = ebookManifest(ctx, resolved.ebookId);
  if (!manifest) return null;
  return {
    ebookId: resolved.ebookId,
    manifest,
    global: toGlobal(manifest, outcome.to.spineIdx, outcome.to.charOffset ?? 0),
  };
}

/** An audiobook's place at a share of the way through its whole running time. */
function audioLocatorAtPct(ctx: AppContext, bookId: string, pct: number): AudioLocator | null {
  const tracks = ctx.db
    .prepare(
      'SELECT idx, start_ms_absolute, duration_ms FROM audio_tracks WHERE book_id = ? ORDER BY idx',
    )
    .all(bookId) as { idx: number; start_ms_absolute: number; duration_ms: number }[];
  if (tracks.length === 0) return null;
  const last = tracks[tracks.length - 1]!;
  const total = Number(last.start_ms_absolute) + Number(last.duration_ms);
  const bookMs = Math.max(0, Math.min(total - 1, Math.round(pct * total)));
  let track = tracks[0]!;
  for (const t of tracks) if (Number(t.start_ms_absolute) <= bookMs) track = t;
  return {
    medium: 'audio',
    trackIdx: Number(track.idx),
    positionMs: bookMs - Number(track.start_ms_absolute),
    bookMs,
    pct: round4(total > 0 ? bookMs / total : 0),
  };
}

export interface CarriedPlace {
  to: Locator;
  precision: TranslationPrecision;
}

/**
 * Carry a place in one edition (`fromId`, `from`) to another (`toId`).
 *
 * `start` lands where to carry on reading: the beginning of the matching
 * paragraph, on a sentence. `point` lands where the place is inside it: a
 * friend's marker. Null only when the target has nothing to place a
 * position in (no text and no running time).
 */
export function carryPlace(
  ctx: AppContext,
  fromId: string,
  from: Locator,
  toId: string,
  mode: 'start' | 'point',
): CarriedPlace | null {
  const toKind = kindOf(ctx, toId);
  if (!toKind) return null;
  // The ebook the target reads as: itself, or - for an audiobook - the
  // ebook it is paired with, whose narration alignment turns text into time.
  const toPair = toKind === 'audio' ? settledPairOf(ctx, toId) : null;
  const toEbook = toKind === 'ebook' ? toId : (toPair?.ebook_id ?? null);

  let text: EbookLocator | null = null;
  let precision: TranslationPrecision = 'proportional';
  const src = asTextPlace(ctx, fromId, from);
  const match = src && toEbook ? storedMatch(ctx.db, src.ebookId, toEbook) : null;
  if (src && toEbook && match) {
    const carried = carry(match.spans, src.ebookId === match.a ? 'a' : 'b', src.global, mode);
    const manifest = ebookManifest(ctx, toEbook);
    if (carried && manifest) {
      text = ebookLocatorAt(ctx, toEbook, manifest, carried.at, mode === 'start');
      precision = 'paragraph';
    }
  }
  if (!text && toEbook) {
    const manifest = ebookManifest(ctx, toEbook);
    if (manifest)
      text = ebookLocatorAt(
        ctx,
        toEbook,
        manifest,
        from.pct * manifest.totalChars,
        mode === 'start',
      );
  }

  if (toKind === 'ebook') return text ? { to: text, precision } : null;

  // An audiobook: the text place in time, through its pair's alignment.
  if (text && toPair) {
    const resolved = pairResolveContext(ctx, toPair.id);
    if (resolved) {
      const outcome = resolveEbookToAudio(resolved.rctx, text);
      if (outcome.to && outcome.to.medium === 'audio') return { to: outcome.to, precision };
    }
  }
  const audio = audioLocatorAtPct(ctx, toId, text?.pct ?? from.pct);
  return audio ? { to: audio, precision: text ? precision : 'proportional' } : null;
}

/** Longest passage handed back: a merged step over a long monologue is still a passage, not a chapter. */
const PASSAGE_MAX_CHARS = 6000;

/**
 * A passage of one ebook as another language's ebook has it: the paragraphs
 * matching the ones from `start` to `end` (chapter-local, in `spineIdx`).
 * Null when the two have not been matched.
 */
export function passageIn(
  ctx: AppContext,
  fromId: string,
  spineIdx: number,
  start: number,
  end: number,
  toId: string,
): TranslationPassage | null {
  const match = storedMatch(ctx.db, fromId, toId);
  if (!match) return null;
  const fromManifest = ebookManifest(ctx, fromId);
  const toManifest = ebookManifest(ctx, toId);
  if (!fromManifest || !toManifest || !fromManifest.chapters[spineIdx]) return null;
  const side = fromId === match.a ? 'a' : 'b';
  const g0 = toGlobal(fromManifest, spineIdx, start);
  const g1 = Math.max(g0, toGlobal(fromManifest, spineIdx, Math.max(start, end - 1)));
  const first = carry(match.spans, side, g0, 'start');
  const last = carry(match.spans, side, g1, 'start');
  if (!first || !last) return null;
  const t0 = first.to[0];
  const t1 = Math.max(last.to[1], first.to[1]);

  // The target's text over [t0, t1), paragraph by paragraph, across as many
  // chapters as the range touches (almost always one).
  const dir = activeDerivedDir(ctx, toId);
  const paragraphs: string[] = [];
  let length = 0;
  for (const ch of toManifest.chapters) {
    const chEnd = ch.cumChars + ch.charCount;
    if (chEnd <= t0 || ch.cumChars >= Math.max(t1, t0 + 1)) continue;
    const text = loadChapterText(dir, ch.idx) ?? '';
    const slice = text.slice(Math.max(0, t0 - ch.cumChars), Math.max(0, t1 - ch.cumChars));
    for (const line of slice.split('\n')) {
      const p = line.trim();
      if (!p) continue;
      if (length + p.length > PASSAGE_MAX_CHARS) {
        paragraphs.push(`${p.slice(0, Math.max(0, PASSAGE_MAX_CHARS - length)).trimEnd()}…`);
        length = PASSAGE_MAX_CHARS;
        break;
      }
      paragraphs.push(p);
      length += p.length;
    }
    if (length >= PASSAGE_MAX_CHARS) break;
  }

  // What it matched in the book asked from, held to the chapter on screen.
  const ch = fromManifest.chapters[spineIdx]!;
  const s0 = Math.max(0, first.from[0] - ch.cumChars);
  const s1 = Math.min(ch.charCount, Math.max(last.from[1], first.from[1]) - ch.cumChars);
  // The language the library knows it by: a curator's word over the file's.
  const language =
    (
      ctx.db.prepare('SELECT language FROM books WHERE id = ?').get(toId) as
        { language: string | null } | undefined
    )?.language ??
    toManifest.language ??
    null;
  return {
    bookId: toId,
    language,
    direction: toManifest.direction === 'rtl' ? 'rtl' : 'ltr',
    paragraphs,
    to: ebookLocatorAt(ctx, toId, toManifest, t0, false),
    source: { spineIdx, start: s0, end: Math.max(s0, s1) },
    precision: first.matched ? 'paragraph' : 'proportional',
  };
}
