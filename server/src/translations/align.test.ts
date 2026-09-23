import { describe, expect, it } from 'vitest';
import { alignParagraphs, carry, paragraphsOf, stepsToSpans, type Paragraph } from './align.js';

/**
 * The paragraph aligner, on books whose answer is known: a "translation"
 * built from an original by stretching each paragraph a little, with the
 * things real translations do - two paragraphs run together, a note of the
 * translator's own, a chapter the other edition splits in two.
 */

/** A deterministic wobble, so a stretched paragraph is not exactly proportional. */
function wobble(i: number): number {
  return 1 + (((i * 7919) % 13) - 6) / 60; // within about ±10%
}

/** An original of `n` paragraphs over `chapters` chapters, of lengths that vary like prose. */
function original(n: number, chapters = 5): { text: string[]; lens: number[] } {
  const lens = Array.from({ length: n }, (_, i) => 40 + ((i * 104729) % 700));
  const perChapter = Math.ceil(n / chapters);
  const text: string[] = [];
  for (let c = 0; c < chapters; c++) {
    const slice = lens.slice(c * perChapter, (c + 1) * perChapter);
    text.push(
      slice.map((len, k) => `${'x'.repeat(len - 1)}${k === 0 ? String(c + 1) : '.'}`).join('\n'),
    );
  }
  return { text, lens };
}

function paragraphs(chapterTexts: string[]): Paragraph[] {
  let cum = 0;
  const chapters = chapterTexts.map((t, idx) => {
    const c = { idx, cumChars: cum };
    cum += t.length;
    return c;
  });
  return paragraphsOf(chapters, (idx) => chapterTexts[idx] ?? null);
}

describe('paragraphsOf', () => {
  it('takes a line per paragraph, with its offsets in the chapter and the book', () => {
    const ps = paragraphs(['  First one.\n\nSecond, 1942.\n', 'Third 7.']);
    expect(ps.map((p) => [p.spineIdx, p.start, p.end, p.global, p.head, p.digits])).toEqual([
      [0, 2, 12, 2, true, ''],
      [0, 14, 27, 14, false, '1942'],
      [1, 0, 8, 28, true, '7'],
    ]);
    expect(ps[0]!.len).toBe('Firstone.'.length);
  });
});

describe('alignParagraphs', () => {
  it('matches a close translation one paragraph to one', async () => {
    const { text } = original(120);
    // Russian-ish: about 8% longer, each paragraph within ±10% of that.
    let i = 0;
    const translated = text.map((ch) =>
      ch
        .split('\n')
        .map((p) => {
          const digits = p.match(/\d+$/)?.[0] ?? '.';
          return `${'y'.repeat(Math.max(3, Math.round(p.length * 1.08 * wobble(i++))) - digits.length)}${digits}`;
        })
        .join('\n'),
    );
    const A = paragraphs(text);
    const B = paragraphs(translated);
    const result = await alignParagraphs(A, B);
    expect(result).not.toBeNull();
    expect(result!.match).toBe('close');
    expect(result!.stats.oneToOne).toBe(A.length);
    expect(
      result!.steps.every(([i0, i1, j0, j1]) => i1 - i0 === 1 && j1 - j0 === 1 && i0 === j0),
    ).toBe(true);
  });

  it('finds merged paragraphs and a note the original does not have', async () => {
    const { text } = original(60, 3);
    const lines = text.map((ch) => ch.split('\n'));
    // Chapter 2: paragraphs 3 and 4 run together; chapter 3 opens with a
    // translator's note before its first paragraph.
    const t = lines.map((ch) => ch.map((p) => p.replace(/x/g, 'y')));
    t[1]!.splice(3, 2, `${t[1]![3]} ${t[1]![4]}`);
    t[2]!.splice(1, 0, 'n'.repeat(300));
    const A = paragraphs(lines.map((ch) => ch.join('\n')));
    const B = paragraphs(t.map((ch) => ch.join('\n')));
    const result = (await alignParagraphs(A, B))!;
    expect(result).not.toBeNull();
    const spans = stepsToSpans(result.steps, A, B);
    // Every original paragraph lands in the paragraph made from it.
    const ch2 = A.filter((p) => p.spineIdx === 1);
    const merged = B.filter((p) => p.spineIdx === 1)[3]!;
    for (const p of [ch2[3]!, ch2[4]!]) {
      const to = carry(spans, 'a', p.global + 5, 'start')!;
      expect(to.at).toBe(merged.global);
      expect(to.matched).toBe(true);
    }
    // And the paragraph after the note is still its own counterpart.
    const ch3A = A.filter((p) => p.spineIdx === 2);
    const ch3B = B.filter((p) => p.spineIdx === 2);
    expect(carry(spans, 'a', ch3A[1]!.global, 'start')!.at).toBe(ch3B[2]!.global);
    // The note has somewhere to go back to: the chapter it is in, no
    // further on than the paragraph after it.
    const note = carry(spans, 'b', ch3B[1]!.global + 3, 'start')!;
    expect(note.at).toBeGreaterThanOrEqual(ch3A[0]!.global);
    expect(note.at).toBeLessThanOrEqual(ch3A[1]!.global);
  });

  it('carries a point proportionally inside a paragraph, and between paragraphs to the next', async () => {
    const A = paragraphs(['a'.repeat(100) + '\n' + 'b'.repeat(100)]);
    const B = paragraphs(['c'.repeat(200) + '\n' + 'd'.repeat(200)]);
    const result = (await alignParagraphs(A, B))!;
    const spans = stepsToSpans(result.steps, A, B);
    expect(carry(spans, 'a', 50, 'point')!.at).toBe(100);
    expect(carry(spans, 'a', 50, 'start')!.at).toBe(0);
    // The line break between the two paragraphs: the next one.
    expect(carry(spans, 'a', 100, 'point')!.at).toBe(201);
    expect(carry(spans, 'b', 301, 'point')!.at).toBe(151);
  });

  it('says a loosely matching text is rough rather than close', async () => {
    const { text } = original(80, 4);
    // An abridged "translation": every other paragraph cut down to a line.
    let k = 0;
    const abridged = text.map((ch) =>
      ch
        .split('\n')
        .map((p) => (k++ % 2 ? 'z'.repeat(Math.max(3, Math.round(p.length / 6))) : p))
        .join('\n'),
    );
    const result = (await alignParagraphs(paragraphs(text), paragraphs(abridged)))!;
    expect(result).not.toBeNull();
    expect(result.match).toBe('rough');
  });

  it('gives no answer for a book with no text', async () => {
    expect(await alignParagraphs([], paragraphs(['Some text.']))).toBeNull();
  });
});
