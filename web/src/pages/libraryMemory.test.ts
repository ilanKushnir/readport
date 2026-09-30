import { afterEach, describe, expect, it } from 'vitest';
import {
  forgetLibraryMemory,
  recallAnswer,
  recallView,
  rememberAnswer,
  rememberPlace,
  rememberView,
} from './libraryMemory';

/**
 * What the library remembers of each view for the way back: its search,
 * format and order, where it was scrolled to, and the answers it showed.
 * (Putting the scroll back is layout, and is checked in the browser:
 * scripts/qa-library-return.mjs.)
 */

afterEach(() => forgetLibraryMemory());

describe('a view', () => {
  it('comes back as it was left', () => {
    rememberView('library|', { query: 'harbour', kind: 'ebook', sort: 'author', place: null });
    rememberPlace('library|', { top: 980, anchor: { id: 'b7', offset: 260 } });
    expect(recallView('library|')).toEqual({
      query: 'harbour',
      kind: 'ebook',
      sort: 'author',
      place: { top: 980, anchor: { id: 'b7', offset: 260 } },
    });
  });

  it('is its own: another shelf, or the same shelf in another language, is another view', () => {
    rememberView('library|', { query: '', kind: 'all', sort: 'title', place: null });
    rememberPlace('library|', { top: 400, anchor: null });
    expect(recallView('library|he')).toBeUndefined();
    expect(recallView('auto:reading-now|')).toBeUndefined();
  });

  it('keeps no place for a view it has never seen', () => {
    rememberPlace('facet:genre:sea|', { top: 120, anchor: null });
    expect(recallView('facet:genre:sea|')).toBeUndefined();
  });
});

describe('answers', () => {
  it('are kept for the requests that fetched them', () => {
    rememberAnswer('/api/library?sort=title', { books: ['b1'] });
    expect(recallAnswer('/api/library?sort=title')).toEqual({ books: ['b1'] });
    expect(recallAnswer('/api/library?sort=author')).toBeUndefined();
  });

  it('keep only the most recent dozen, the latest use counting as recent', () => {
    for (let i = 0; i < 12; i++) rememberAnswer(`/q${i}`, i);
    rememberAnswer('/q0', 0); // used again: now the newest
    rememberAnswer('/q12', 12);
    expect(recallAnswer('/q0')).toBe(0);
    expect(recallAnswer('/q1')).toBeUndefined();
    expect(recallAnswer('/q12')).toBe(12);
  });
});
