import { describe, expect, it } from 'vitest';
import { formatInviteCode, isInviteCode, makeInviteCode, normalizeInviteCode } from './invites';

/**
 * A code has to survive being read aloud.
 *
 * That is the whole reason it exists: an invite used to be 32 characters of
 * base64url, fine to click and impossible to dictate. Everything here is
 * about the journey from one person saying it to another person typing it.
 */

/** Deterministic bytes, so a generated code can be asserted exactly. */
const bytes = (seq: number[]) => {
  let i = 0;
  return (n: number) => Uint8Array.from({ length: n }, () => seq[i++ % seq.length]!);
};

describe('normalizeInviteCode', () => {
  it('ignores case, spaces and the dashes', () => {
    expect(normalizeInviteCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
    expect(normalizeInviteCode('ABCD EFGH JKMN')).toBe('ABCDEFGHJKMN');
    expect(normalizeInviteCode('ABCDEFGHJKMN.')).toBe('ABCDEFGHJKMN');
  });

  it('folds the letters that look like digits', () => {
    // Someone reading "0FGH" aloud says "oh", and the listener types O.
    expect(normalizeInviteCode('OFGH')).toBe('0FGH');
    expect(normalizeInviteCode('I234')).toBe('1234');
    expect(normalizeInviteCode('L234')).toBe('1234');
  });

  it('never returns more than a code', () => {
    expect(normalizeInviteCode('ABCDEFGHJKMNPQRSTVWX')).toHaveLength(12);
  });
});

describe('formatInviteCode', () => {
  it('groups it the way it will be read out', () => {
    expect(formatInviteCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN');
  });

  it('is stable when given a code that is already formatted', () => {
    expect(formatInviteCode('ABCD-EFGH-JKMN')).toBe('ABCD-EFGH-JKMN');
  });

  it('round-trips through what a person typed', () => {
    expect(formatInviteCode(normalizeInviteCode('abcd efgh jkmn'))).toBe('ABCD-EFGH-JKMN');
  });
});

describe('isInviteCode', () => {
  it('accepts a whole code however it was typed', () => {
    expect(isInviteCode('ABCD-EFGH-JKMN')).toBe(true);
    expect(isInviteCode('abcdefghjkmn')).toBe(true);
  });

  it('rejects a partial one', () => {
    expect(isInviteCode('ABCD-EFGH')).toBe(false);
    expect(isInviteCode('')).toBe(false);
  });
});

describe('makeInviteCode', () => {
  it('produces a formatted code of the right shape', () => {
    const code = makeInviteCode(() => crypto.getRandomValues(new Uint8Array(12)));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(isInviteCode(code)).toBe(true);
  });

  it('never emits a character that could be misread', () => {
    for (let i = 0; i < 200; i++) {
      const code = makeInviteCode(() => crypto.getRandomValues(new Uint8Array(12)));
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  it('maps bytes through the alphabet predictably', () => {
    // 0 -> '0', 1 -> '1', 31 -> 'Z'
    expect(makeInviteCode(bytes([0]))).toBe('0000-0000-0000');
    expect(makeInviteCode(bytes([31]))).toBe('ZZZZ-ZZZZ-ZZZZ');
  });

  it('draws every character with equal probability', () => {
    // The property that matters. With 32 characters nothing is rejected
    // because 32 divides 256, so each byte value must map to exactly one
    // character and each character must claim exactly eight of the 256.
    const counts = new Map<string, number>();
    for (let b = 0; b < 256; b++) {
      const ch = makeInviteCode(bytes([b]))[0]!;
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    expect([...counts.values()].every((n) => n === 8)).toBe(true);
  });

  it('does not repeat itself', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(makeInviteCode(() => crypto.getRandomValues(new Uint8Array(12))));
    }
    expect(seen.size).toBe(500);
  });
});
