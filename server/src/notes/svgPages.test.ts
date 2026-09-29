import { describe, expect, it } from 'vitest';
import { svgPages } from './svgPages.js';

/**
 * Cutting typst's one tall drawing into pages. The input below is the shape
 * typst-ts 0.7 writes, trimmed: two pages, two glyphs and a clip, each page
 * using one glyph and the first also the clip.
 */
const DOC = [
  '<svg class="typst-doc" viewBox="0 0 595.28 1683.78" width="595.28pt" height="1683.78pt" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:h5="http://www.w3.org/1999/xhtml">',
  '    <path class="typst-shape" fill="#15120f" fill-rule="nonzero" d="M 0 0v 841.8898 h 595.2756 v -841.8898 Z "/>',
  '    <g>',
  '        <g class="typst-text" clip-path="url(#c3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C)">',
  '            <use xlink:href="#g1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A" x="0"/>',
  '        </g>',
  '    </g>',
  '    <path class="typst-shape" fill="#15120f" fill-rule="nonzero" d="M 0 0v 841.8898 h 595.2756 v -841.8898 Z "/>',
  '    <g transform="matrix(1 0 0 1 0 841.8897637795276)">',
  '        <g class="typst-text">',
  '            <use xlink:href="#g2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B" x="0"/>',
  '        </g>',
  '    </g>',
  '    <defs id="glyph">',
  '        <symbol id="g1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A" overflow="visible">',
  '            <path d="M 0 0 h 1 v 1 Z"/>',
  '        </symbol>',
  '        <symbol id="g2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B" overflow="visible">',
  '            <path d="M 0 0 h 2 v 2 Z"/>',
  '        </symbol>',
  '    </defs>',
  '    <defs id="clip-path">',
  '        <clipPath id="c3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C">',
  '            <path d="M 0 0 h 9 v 9 Z"/>',
  '        </clipPath>',
  '    </defs>',
  '</svg>',
  '',
].join('\n');

describe('svgPages', () => {
  it('makes each page a picture of its own, at the top of its own box', () => {
    const pages = svgPages(DOC, 6);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.startsWith('<svg')).toBe(true);
      expect(page).toContain('viewBox="0 0 595.28 841.889"');
      expect(page).toContain('fill="#15120f"');
      // Moved back up: no page is drawn below the one before it.
      expect(page).not.toContain('matrix(1 0 0 1 0 841');
      expect(page.trim().endsWith('</svg>')).toBe(true);
    }
  });

  it('carries only the glyphs and clips its page uses, under short names', () => {
    const [first, second] = svgPages(DOC, 6);
    // The first page draws its glyph through the clip; the second, its own glyph alone.
    expect(first).toMatch(/<clipPath id="(c\w+)"[\s\S]*$/);
    expect(first).toContain('clip-path="url(#c');
    expect(first).toContain('d="M 0 0 h 1 v 1 Z"');
    expect(first).not.toContain('d="M 0 0 h 2 v 2 Z"');
    expect(second).toContain('d="M 0 0 h 2 v 2 Z"');
    expect(second).not.toContain('d="M 0 0 h 1 v 1 Z"');
    expect(second).not.toContain('<clipPath');
    // Every reference names something the page defines, and no long name is left.
    for (const page of [first!, second!]) {
      expect(page).not.toMatch(/[gc](?:[0-9A-F]{2}){16}/);
      const defined = new Set([...page.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
      for (const m of page.matchAll(/href="#([^"]+)"|url\(#([^)]+)\)/g))
        expect(defined.has(m[1] ?? m[2])).toBe(true);
    }
  });

  it('stops at as many pages as it is asked for', () => {
    expect(svgPages(DOC, 1)).toHaveLength(1);
    expect(svgPages(DOC, 0)).toEqual([]);
  });

  it('returns nothing for a drawing it cannot read', () => {
    expect(svgPages('<html></html>', 3)).toEqual([]);
    expect(svgPages('', 3)).toEqual([]);
  });
});
