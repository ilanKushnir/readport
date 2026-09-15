import { describe, expect, it } from 'vitest';
import { afterIdFor, autoscrollSpeed, moveItem, slotFor } from './reorder';

/**
 * The arithmetic behind every reordering gesture. The keyboard path, the
 * pointer path and the overflow menu all end here, and all of them then send
 * the server one thing: which item this one now follows.
 */

describe('moveItem', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('moves an item up and down by one', () => {
    expect(moveItem(list, 2, 1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveItem(list, 1, 2)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moves an item to either end', () => {
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(list, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('leaves the list alone when nothing moves', () => {
    expect(moveItem(list, 2, 2)).toBe(list);
    expect(moveItem(list, -1, 0)).toBe(list);
    expect(moveItem(list, 9, 0)).toBe(list);
  });

  it('never loses or duplicates an item', () => {
    for (let from = 0; from < list.length; from++) {
      for (let to = 0; to < list.length; to++) {
        expect([...moveItem(list, from, to)].sort()).toEqual([...list].sort());
      }
    }
  });
});

describe('afterIdFor', () => {
  it('reports the neighbour the item now follows', () => {
    expect(afterIdFor(['a', 'b', 'c'], 'c')).toBe('b');
  });

  it('reports null for the first item, which is what "make it first" sends', () => {
    expect(afterIdFor(['a', 'b', 'c'], 'a')).toBeNull();
  });

  it('reports null for an item that is not in the list at all', () => {
    expect(afterIdFor(['a', 'b'], 'z')).toBeNull();
  });

  it('round-trips a move: apply it, then ask what it now follows', () => {
    const moved = moveItem(['a', 'b', 'c', 'd'], 3, 1);
    expect(moved).toEqual(['a', 'd', 'b', 'c']);
    expect(afterIdFor(moved, 'd')).toBe('a');
  });
});

describe('slotFor', () => {
  it('counts the rows whose middle the dragged row has passed, whatever their heights', () => {
    // Rows of 40, 90 and 40 px with 8px gaps: middles at 20, 93 and 158.
    const mids = [20, 93, 158];
    expect(slotFor(mids, 10)).toBe(0);
    expect(slotFor(mids, 60)).toBe(1);
    expect(slotFor(mids, 120)).toBe(2);
    expect(slotFor(mids, 200)).toBe(3);
  });
});

describe('autoscrollSpeed', () => {
  it('is still in the middle of the list', () => {
    expect(autoscrollSpeed(300, 0, 600, 64)).toBe(0);
  });
  it('scrolls up near the top and down near the bottom, faster the deeper in', () => {
    expect(autoscrollSpeed(60, 0, 600, 64)).toBeLessThan(0);
    expect(autoscrollSpeed(2, 0, 600, 64)).toBeLessThan(autoscrollSpeed(60, 0, 600, 64));
    expect(autoscrollSpeed(540, 0, 600, 64)).toBeGreaterThan(0);
    expect(autoscrollSpeed(598, 0, 600, 64)).toBeGreaterThan(autoscrollSpeed(540, 0, 600, 64));
  });
  it('never exceeds the cap', () => {
    expect(autoscrollSpeed(-100, 0, 600, 64)).toBe(-18);
    expect(autoscrollSpeed(900, 0, 600, 64)).toBe(18);
  });
});
