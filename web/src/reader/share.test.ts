import { describe, expect, it } from 'vitest';
import { QUOTE_MAX, trimQuote } from './share';

describe('trimQuote', () => {
  it('leaves a short quote alone, apart from its whitespace', () => {
    expect(trimQuote('  A line\n  broken   twice ')).toBe('A line broken twice');
  });
  it('cuts a long quote at a word boundary with an ellipsis', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const out = trimQuote(words);
    expect(out.length).toBeLessThanOrEqual(QUOTE_MAX + 1);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1)).toMatch(/word\d+$/);
    expect(words.startsWith(out.slice(0, -1))).toBe(true);
  });
  it('drops trailing punctuation before the ellipsis', () => {
    const text = `${'a '.repeat(298)}b, ${'c '.repeat(50)}`;
    const out = trimQuote(text, 600);
    expect(out).not.toMatch(/, …$/);
    expect(out.endsWith('…')).toBe(true);
  });
  it('cuts a single very long token rather than trimming to nothing', () => {
    const out = trimQuote(`${'x'.repeat(900)}`, 100);
    expect(out).toBe(`${'x'.repeat(100)}…`);
  });
});
