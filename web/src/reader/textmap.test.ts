import { describe, expect, it, vi } from 'vitest';
import {
  firstVisibleOffset,
  hintForOffset,
  mappedText,
  nearestOccurrence,
  type TextMap,
} from './textmap';

/**
 * Which character of a chapter is on the page.
 *
 * `firstVisibleOffset` is the only thing that answers that question, and its
 * answer is what gets stored as the reader's place in the book - so it is
 * worth pinning down exactly. It needs rectangles rather than a document, and
 * there is no DOM in this suite, so the page is modelled instead: fixed-width
 * characters laid into lines, lines into columns, columns into pages. That is
 * enough to reproduce the two things that actually go wrong - a spread, and
 * movement backward.
 *
 * The property that matters most is that the hint is an OPTIMISATION. The
 * scan starts wherever the caller says the reader last was and walks outward
 * from there; if the starting point can change the answer, then the answer
 * depends on where the reader came from rather than on what is on the screen.
 * It used to: walking backward, the first node the scan reached was the LAST
 * one on the page, so a backward page turn recorded an offset a whole page
 * (or, in two columns, a whole spread) further on than the reader was.
 */

const CHAR_W = 8;
const LINE_H = 20;
const COL_W = 320;
const COL_GAP = 40;
const LINES_PER_COL = 10;
const CHARS_PER_LINE = COL_W / CHAR_W;

type Line = { from: number; to: number; left: number; top: number };
type FakeNode = { data: string; lines: Line[] };

/** Where a character sits, given the line it is on. */
function charRect(line: Line, index: number) {
  const left = line.left + (index - line.from) * CHAR_W;
  return { left, right: left + CHAR_W, top: line.top, bottom: line.top + LINE_H };
}
function lineRect(line: Line) {
  return {
    left: line.left,
    right: line.left + (line.to - line.from) * CHAR_W,
    top: line.top,
    bottom: line.top + LINE_H,
  };
}

/**
 * Lay paragraphs out the way a paginated chapter is laid out: each paragraph
 * starts a new line, lines fill a column and then flow into the next, and the
 * text map counts a synthetic newline after each block exactly as
 * `buildTextMap` does.
 */
function layout(paragraphs: string[]): { map: TextMap; nodes: FakeNode[] } {
  const nodes: FakeNode[] = [];
  const entries: { node: Text; start: number }[] = [];
  let at = 0;
  let lineIndex = 0;
  for (const text of paragraphs) {
    const lines: Line[] = [];
    for (let c = 0; c < text.length; c += CHARS_PER_LINE) {
      const column = Math.floor(lineIndex / LINES_PER_COL);
      const row = lineIndex % LINES_PER_COL;
      lines.push({
        from: c,
        to: Math.min(text.length, c + CHARS_PER_LINE),
        left: column * (COL_W + COL_GAP),
        top: row * LINE_H,
      });
      lineIndex++;
    }
    const node: FakeNode = { data: text, lines };
    nodes.push(node);
    entries.push({ node: node as unknown as Text, start: at });
    at += text.length + 1; // the block's synthetic newline
  }
  return { map: { nodes: entries, totalChars: at }, nodes };
}

/** The box a page covers, for a one- or two-column layout. */
function pageBox(page: number, columns: 1 | 2) {
  const first = page * columns;
  const last = first + columns - 1;
  return {
    left: first * (COL_W + COL_GAP),
    right: last * (COL_W + COL_GAP) + COL_W,
    top: -1,
    bottom: LINES_PER_COL * LINE_H + 1,
  };
}

class FakeRange {
  private node: FakeNode | null = null;
  private from = 0;
  private to = 0;
  selectNodeContents(node: FakeNode) {
    this.node = node;
    this.from = 0;
    this.to = node.data.length;
  }
  setStart(node: FakeNode, offset: number) {
    this.node = node;
    this.from = offset;
    this.to = Math.max(this.to, offset);
  }
  setEnd(_node: FakeNode, offset: number) {
    this.to = offset;
  }
  private covered(): Line[] {
    const node = this.node;
    if (!node) return [];
    return node.lines.filter((l) => l.to > this.from && l.from < Math.max(this.to, this.from + 1));
  }
  getClientRects() {
    return this.covered().map(lineRect);
  }
  getBoundingClientRect() {
    const node = this.node;
    const lines = this.covered();
    if (!node || lines.length === 0) return { left: 0, right: 0, top: 0, bottom: 0 };
    // A single-character probe is the common case and must be exact.
    if (this.to - this.from <= 1 && lines[0]) return charRect(lines[0], this.from);
    return lines.map(lineRect).reduce((u, r) => ({
      left: Math.min(u.left, r.left),
      right: Math.max(u.right, r.right),
      top: Math.min(u.top, r.top),
      bottom: Math.max(u.bottom, r.bottom),
    }));
  }
}

vi.stubGlobal('document', { createRange: () => new FakeRange() });

const word = (n: number) => `Paragraph ${n} `.padEnd(30, 'abcdefghij ');
// Fourteen paragraphs of three lines each: forty-two lines, so five
// one-column pages - two full spreads and a half - in two columns.
const paragraphs = Array.from({ length: 14 }, (_, i) => word(i).repeat(3).slice(0, 118));

describe('firstVisibleOffset', () => {
  for (const columns of [1, 2] as const) {
    const pages = columns === 1 ? [0, 1, 2, 3, 4] : [0, 1, 2];

    it(`${columns}-column: reports the same offset whatever the hint`, () => {
      const { map } = layout(paragraphs);
      for (const page of pages) {
        const box = pageBox(page, columns);
        const truth = firstVisibleOffset(map, box, 0);
        expect(truth).not.toBeNull();
        // Every node in the chapter, as a starting point. A hint is where the
        // reader was a moment ago; it must never change what is on screen now.
        for (let i = 0; i < map.nodes.length; i++) {
          expect(firstVisibleOffset(map, box, i)).toBe(truth);
        }
      }
    });

    it(`${columns}-column: a forward page turn lands on the top of the new page`, () => {
      const { map } = layout(paragraphs);
      const from = firstVisibleOffset(map, pageBox(0, columns), 0)!;
      const to = firstVisibleOffset(map, pageBox(1, columns), hintForOffset(map, from))!;
      expect(to).toBeGreaterThan(from);
      // The top of page 1 is the character after the last one on page 0.
      const lastOnPrevious = firstVisibleOffset(map, pageBox(0, columns), 0)!;
      expect(to).toBeGreaterThan(lastOnPrevious);
    });

    it(`${columns}-column: a backward page turn lands on the TOP of the page, not the foot`, () => {
      const { map } = layout(paragraphs);
      const onPage1 = firstVisibleOffset(map, pageBox(1, columns), 0)!;
      // Coming back from page 1, the hint names a node beyond everything on
      // page 0. This is the regression: the backward walk returned the last
      // intersecting node - the foot of the page, a whole page or spread of
      // error - and that offset was recorded as the reader's place.
      const back = firstVisibleOffset(map, pageBox(0, columns), hintForOffset(map, onPage1));
      expect(back).toBe(firstVisibleOffset(map, pageBox(0, columns), 0));
      expect(back).toBeLessThan(onPage1);
      // The very first page starts at the first character of the chapter.
      expect(back).toBe(0);
    });

    it(`${columns}-column: scrolling up past several pages still lands at the top`, () => {
      const { map } = layout(paragraphs);
      const far = map.nodes.length - 1;
      expect(firstVisibleOffset(map, pageBox(0, columns), far)).toBe(
        firstVisibleOffset(map, pageBox(0, columns), 0),
      );
    });
  }

  it('two columns: a spread reports the first character of its LEFT column', () => {
    const { map } = layout(paragraphs);
    // Spread 1 is columns 2 and 3.
    const spread = firstVisibleOffset(map, pageBox(1, 2), 0)!;
    const leftColumnOnly = firstVisibleOffset(map, pageBox(2, 1), 0)!;
    const rightColumnOnly = firstVisibleOffset(map, pageBox(3, 1), 0)!;
    expect(spread).toBe(leftColumnOnly);
    // ...and it is genuinely earlier than what the right-hand column shows,
    // which is what a backward turn used to report instead.
    expect(spread).toBeLessThan(rightColumnOnly);
    // Reached backward from the spread beyond it, the answer is the same.
    const later = firstVisibleOffset(map, pageBox(2, 2), 0)!;
    expect(firstVisibleOffset(map, pageBox(1, 2), hintForOffset(map, later))).toBe(spread);
  });

  it('refines to the character that wrapped onto the page, not the paragraph start', () => {
    // One paragraph long enough to span the page boundary: page 1 begins part
    // way through it, and the offset recorded must be that character.
    const { map } = layout([
      word(0)
        .repeat(40)
        .slice(0, 40 * CHARS_PER_LINE),
    ]);
    const second = firstVisibleOffset(map, pageBox(1, 1), 0);
    expect(second).toBe(LINES_PER_COL * CHARS_PER_LINE);
    expect(firstVisibleOffset(map, pageBox(0, 1), 0)).toBe(0);
  });

  it('finds nothing when the box is off the chapter entirely', () => {
    const { map } = layout(paragraphs);
    expect(firstVisibleOffset(map, pageBox(99, 1), 0)).toBeNull();
  });

  it('skips whitespace-only nodes rather than reading them as the page top', () => {
    const { map } = layout(['   ', paragraphs[0]!, paragraphs[1]!]);
    // The blank node occupies no line, so the page starts at the real text.
    expect(firstVisibleOffset(map, pageBox(0, 1), 0)).toBe(4);
  });
});

describe('offset arithmetic', () => {
  it('hintForOffset names the node an offset falls in', () => {
    const { map } = layout(paragraphs);
    expect(hintForOffset(map, 0)).toBe(0);
    expect(hintForOffset(map, map.nodes[3]!.start)).toBe(3);
    expect(hintForOffset(map, map.nodes[3]!.start + 5)).toBe(3);
    expect(hintForOffset(map, 10_000_000)).toBe(map.nodes.length - 1);
  });

  it('mappedText restores the synthetic newlines the offsets count', () => {
    const { map } = layout(['one', 'two']);
    expect(mappedText(map)).toBe('one\ntwo\n');
    expect(mappedText(map).length).toBe(map.totalChars);
  });

  it('nearestOccurrence prefers the copy closest to where the reader was', () => {
    const { map } = layout(['a needle here', 'filler', 'a needle here']);
    expect(nearestOccurrence(map, 'needle', 0)).toBe(2);
    expect(nearestOccurrence(map, 'needle', 100)).toBe(23);
    expect(nearestOccurrence(map, 'haystack', 0)).toBeNull();
  });
});

import { wordEdge } from './textmap';

describe('wordEdge', () => {
  const map = {
    nodes: [
      { node: { data: 'Once upon a' } as unknown as Text, start: 0 },
      { node: { data: 'time, there' } as unknown as Text, start: 12 },
    ],
    totalChars: 24,
  };
  it('runs to the end of the word a caret is inside', () => {
    expect(wordEdge(map, 6, 'end')).toBe(9); // up|on -> after "upon"
    expect(wordEdge(map, 14, 'end')).toBe(17); // ti|me, -> after "time,"
  });
  it('runs back to the start of it', () => {
    expect(wordEdge(map, 7, 'start')).toBe(5);
    expect(wordEdge(map, 14, 'start')).toBe(12);
  });
  it('leaves a boundary where it is', () => {
    expect(wordEdge(map, 9, 'end')).toBe(9);
    expect(wordEdge(map, 5, 'start')).toBe(5);
    expect(wordEdge(map, 11, 'end')).toBe(11);
  });
});
