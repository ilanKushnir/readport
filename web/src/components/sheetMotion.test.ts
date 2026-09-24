import { describe, expect, it } from 'vitest';
import { dragDismisses, dragOffset } from './sheetMotion';

describe('dragging a sheet down', () => {
  it('closes it past a quarter of its height, or on a flick', () => {
    expect(dragDismisses(150, 500, 0.1)).toBe(true);
    expect(dragDismisses(100, 500, 0.1)).toBe(false);
    expect(dragDismisses(40, 500, 0.9)).toBe(true);
  });

  it('takes a wobble on a tap for nothing', () => {
    expect(dragDismisses(6, 500, 2)).toBe(false);
  });

  it('follows the finger down, and gives only a little upwards', () => {
    expect(dragOffset(80)).toBe(80);
    expect(dragOffset(-4)).toBe(-4);
    expect(dragOffset(-400)).toBe(-24);
  });
});
