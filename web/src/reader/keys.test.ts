import { describe, expect, it } from 'vitest';
import { readerKeyAction, type ReaderKeyContext } from './keys';

/**
 * What a key means in each way of reading: the pages on their own, and the
 * voice while reading along - in page view and scroll view, either way the
 * book is written.
 */

const key = (k: string, shiftKey = false) => ({ key: k, shiftKey });
const pages: ReaderKeyContext = { readAlong: false, rtl: false, view: 'paginated' };
const scroll: ReaderKeyContext = { ...pages, view: 'scroll' };
const along: ReaderKeyContext = { ...pages, readAlong: true };

describe('reading on its own', () => {
  it('goes on a page with the arrow the book reads towards, Space and Page Down', () => {
    for (const k of [key('ArrowRight'), key(' '), key('PageDown')])
      expect(readerKeyAction(k, pages)).toEqual({ kind: 'page', dir: 'next' });
  });

  it('goes back with the other arrow, Shift and Space, and Page Up', () => {
    for (const k of [key('ArrowLeft'), key(' ', true), key('PageUp')])
      expect(readerKeyAction(k, pages)).toEqual({ kind: 'page', dir: 'prev' });
  });

  it('turns pages with up and down in page view, where there is nothing to scroll', () => {
    expect(readerKeyAction(key('ArrowDown'), pages)).toEqual({ kind: 'page', dir: 'next' });
    expect(readerKeyAction(key('ArrowUp'), pages)).toEqual({ kind: 'page', dir: 'prev' });
  });

  it('leaves up and down to scroll in scroll view, and goes a screen with the rest', () => {
    expect(readerKeyAction(key('ArrowDown'), scroll)).toBeNull();
    expect(readerKeyAction(key('ArrowUp'), scroll)).toBeNull();
    expect(readerKeyAction(key('ArrowRight'), scroll)).toEqual({ kind: 'page', dir: 'next' });
    expect(readerKeyAction(key(' '), scroll)).toEqual({ kind: 'page', dir: 'next' });
  });

  it('follows a right-to-left book: the left arrow goes on', () => {
    const rtl = { ...pages, rtl: true };
    expect(readerKeyAction(key('ArrowLeft'), rtl)).toEqual({ kind: 'page', dir: 'next' });
    expect(readerKeyAction(key('ArrowRight'), rtl)).toEqual({ kind: 'page', dir: 'prev' });
  });

  it('takes no other key, nor Shift with an arrow', () => {
    expect(readerKeyAction(key('a'), pages)).toBeNull();
    expect(readerKeyAction(key('Enter'), pages)).toBeNull();
    expect(readerKeyAction(key('ArrowRight', true), pages)).toBeNull();
  });
});

describe('reading along', () => {
  it('plays and pauses the voice with Space, instead of turning the page', () => {
    expect(readerKeyAction(key(' '), along)).toEqual({ kind: 'voice' });
    expect(readerKeyAction(key(' '), { ...along, view: 'scroll' })).toEqual({ kind: 'voice' });
  });

  it('moves the voice a sentence with the arrows, and fifteen seconds with Shift', () => {
    expect(readerKeyAction(key('ArrowRight'), along)).toEqual({ kind: 'sentence', dir: 'next' });
    expect(readerKeyAction(key('ArrowLeft'), along)).toEqual({ kind: 'sentence', dir: 'prev' });
    expect(readerKeyAction(key('ArrowRight', true), along)).toEqual({ kind: 'skip', dir: 'next' });
    expect(readerKeyAction(key('ArrowLeft', true), along)).toEqual({ kind: 'skip', dir: 'prev' });
  });

  it('turns the page on its own with Page Down and Page Up, to look ahead while it reads on', () => {
    expect(readerKeyAction(key('PageDown'), along)).toEqual({ kind: 'page', dir: 'next' });
    expect(readerKeyAction(key('PageUp'), { ...along, view: 'scroll' })).toEqual({
      kind: 'page',
      dir: 'prev',
    });
  });

  it('leaves up and down to the page, to look ahead while the voice reads on', () => {
    expect(readerKeyAction(key('ArrowDown'), along)).toBeNull();
    expect(readerKeyAction(key('ArrowUp'), along)).toBeNull();
  });

  it('follows a right-to-left book for sentences too', () => {
    const rtl = { ...along, rtl: true };
    expect(readerKeyAction(key('ArrowLeft'), rtl)).toEqual({ kind: 'sentence', dir: 'next' });
    expect(readerKeyAction(key('ArrowRight'), rtl)).toEqual({ kind: 'sentence', dir: 'prev' });
  });
});
