import { describe, expect, it } from 'vitest';
import { canResumeAt, ScrollOwnership } from './motion';

describe('paused attachment evidence', () => {
  it('rejects chapters before or after the paused audio position', () => {
    expect(canResumeAt('before', 500, false)).toBe(false);
    expect(canResumeAt('after', 20000, false)).toBe(false);
  });
  it('accepts paused positions on a cue, in a hold, or in an internal gap', () => {
    expect(canResumeAt('on', 10500, false)).toBe(true);
    expect(canResumeAt('hold', 11000, false)).toBe(true);
    expect(canResumeAt('gap', 15000, false)).toBe(true);
  });
  it('allows the playing walker to resolve gaps but rejects unknown time', () => {
    expect(canResumeAt('before', 500, true)).toBe(true);
    expect(canResumeAt('gap', NaN, false)).toBe(false);
  });
});
describe('scroll ownership without time windows', () => {
  it('recognizes coalesced programmatic writes', () => {
    const owner = new ScrollOwnership();
    const el = { scrollTop: 0 };
    owner.write(el, 50);
    owner.write(el, 100);
    expect(owner.matches(el)).toBe(true);
    expect(owner.matches(el)).toBe(true);
  });
  it('recognizes native clamping and fractional rounding', () => {
    const owner = new ScrollOwnership();
    let top = 0;
    const el = {
      get scrollTop() {
        return top;
      },
      set scrollTop(n) {
        top = Math.min(100, Math.round(n));
      },
    };
    owner.write(el, 999);
    expect(owner.matches(el)).toBe(true);
  });
  it('detects unowned movement and does not suppress another element', () => {
    const owner = new ScrollOwnership();
    const el = { scrollTop: 0 };
    owner.write(el, 100);
    el.scrollTop = 120;
    expect(owner.matches(el)).toBe(false);
    expect(owner.matches({ scrollTop: 100 })).toBe(false);
  });
});
