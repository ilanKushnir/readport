import { describe, expect, it } from 'vitest';
import { ARROW_SKIP_MS, playerKeyAction } from './keys';

/** The player's keys: play and pause, fifteen seconds either way, a chapter with Shift. */

const key = (k: string, shiftKey = false) => ({ key: k, shiftKey });
const ltr = { rtl: false, skipBackS: 15, skipFwdS: 30 };

describe('playerKeyAction', () => {
  it('plays and pauses with Space and K', () => {
    expect(playerKeyAction(key(' '), ltr)).toEqual({ kind: 'toggle' });
    expect(playerKeyAction(key('k'), ltr)).toEqual({ kind: 'toggle' });
    expect(playerKeyAction(key('K'), ltr)).toEqual({ kind: 'toggle' });
    expect(playerKeyAction(key(' ', true), ltr)).toBeNull();
  });

  it('moves fifteen seconds either way with the arrows - the same both ways', () => {
    expect(ARROW_SKIP_MS).toBe(15_000);
    expect(playerKeyAction(key('ArrowRight'), ltr)).toEqual({ kind: 'seek', byMs: 15_000 });
    expect(playerKeyAction(key('ArrowLeft'), ltr)).toEqual({ kind: 'seek', byMs: -15_000 });
  });

  it('moves a chapter with Shift and an arrow', () => {
    expect(playerKeyAction(key('ArrowRight', true), ltr)).toEqual({ kind: 'chapter', dir: 1 });
    expect(playerKeyAction(key('ArrowLeft', true), ltr)).toEqual({ kind: 'chapter', dir: -1 });
  });

  it('follows the timeline in a right-to-left interface: the left arrow goes on', () => {
    const rtl = { ...ltr, rtl: true };
    expect(playerKeyAction(key('ArrowLeft'), rtl)).toEqual({ kind: 'seek', byMs: 15_000 });
    expect(playerKeyAction(key('ArrowRight'), rtl)).toEqual({ kind: 'seek', byMs: -15_000 });
    expect(playerKeyAction(key('ArrowLeft', true), rtl)).toEqual({ kind: 'chapter', dir: 1 });
  });

  it('keeps J and L to the player’s own skip lengths', () => {
    expect(playerKeyAction(key('j'), ltr)).toEqual({ kind: 'seek', byMs: -15_000 });
    expect(playerKeyAction(key('l'), ltr)).toEqual({ kind: 'seek', byMs: 30_000 });
  });

  it('takes no other key', () => {
    for (const k of ['a', 'Enter', 'ArrowUp', 'ArrowDown', 'PageDown'])
      expect(playerKeyAction(key(k), ltr)).toBeNull();
  });
});
