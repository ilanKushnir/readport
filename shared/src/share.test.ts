import { describe, expect, it } from 'vitest';
import {
  SHARE_TOKEN_RE,
  joinEmailSchema,
  joinRequestSchema,
  joinStatusResponseSchema,
  sharePath,
  sharePeekSchema,
  shareTokenSchema,
} from './share.js';

describe('share tokens', () => {
  it('accepts URL-safe randomness of at least 22 characters', () => {
    expect(shareTokenSchema.safeParse('a'.repeat(22)).success).toBe(true);
    expect(shareTokenSchema.safeParse('Ab0-_'.repeat(6)).success).toBe(true);
    expect(SHARE_TOKEN_RE.test('x'.repeat(64))).toBe(true);
  });

  it('refuses anything short, long, or carrying other characters', () => {
    expect(shareTokenSchema.safeParse('a'.repeat(21)).success).toBe(false);
    expect(shareTokenSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(shareTokenSchema.safeParse('a'.repeat(21) + '/').success).toBe(false);
    expect(shareTokenSchema.safeParse('a'.repeat(21) + '.').success).toBe(false);
    expect(shareTokenSchema.safeParse('').success).toBe(false);
  });

  it('builds the link path from the token', () => {
    expect(sharePath('abc_-123')).toBe('/s/abc_-123');
  });
});

describe('join requests', () => {
  it('normalises the address so one open request per address means one', () => {
    expect(joinEmailSchema.parse('  Ada@Example.ORG ')).toBe('ada@example.org');
  });

  it('refuses what is not an address', () => {
    for (const bad of ['', 'ada', 'ada@', '@example.org', 'ada @example.org', 'ada@example']) {
      expect(joinEmailSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('trims the optional lines and drops blank ones', () => {
    const parsed = joinRequestSchema.parse({
      email: 'ada@example.org',
      name: '  Ada  ',
      message: '   ',
    });
    expect(parsed).toEqual({ email: 'ada@example.org', name: 'Ada', message: undefined });
  });

  it('bounds the lines', () => {
    expect(
      joinRequestSchema.safeParse({ email: 'ada@example.org', name: 'x'.repeat(81) }).success,
    ).toBe(false);
    expect(
      joinRequestSchema.safeParse({ email: 'ada@example.org', message: 'x'.repeat(501) }).success,
    ).toBe(false);
  });

  it('carries the invite token only as an optional field beside the status', () => {
    expect(joinStatusResponseSchema.parse({ status: 'pending' })).toEqual({ status: 'pending' });
    expect(joinStatusResponseSchema.safeParse({ status: 'accepted' }).success).toBe(false);
    expect(
      joinStatusResponseSchema.parse({ status: 'approved', inviteToken: 'ABCD-EFGH-JKMN' }),
    ).toEqual({ status: 'approved', inviteToken: 'ABCD-EFGH-JKMN' });
  });
});

describe('the public teaser', () => {
  it('is either the book with who shared it, or nothing at all', () => {
    expect(
      sharePeekSchema.parse({
        valid: true,
        book: { id: 'b1', title: 'T', author: null, kind: 'ebook', hasCover: false },
        sharedBy: { displayName: 'Ada' },
      }).valid,
    ).toBe(true);
    expect(sharePeekSchema.parse({ valid: false })).toEqual({ valid: false });
    // Nothing that could identify the sharer's account fits the shape.
    expect(
      sharePeekSchema.safeParse({
        valid: true,
        book: { id: 'b1', title: 'T', author: null, kind: 'ebook', hasCover: false },
        sharedBy: { displayName: 'Ada', email: 'ada@example.org' },
      }).success,
    ).toBe(true);
    const parsed = sharePeekSchema.parse({
      valid: true,
      book: { id: 'b1', title: 'T', author: null, kind: 'ebook', hasCover: false },
      sharedBy: { displayName: 'Ada', email: 'ada@example.org' },
    });
    expect(parsed.valid && parsed.sharedBy).toEqual({ displayName: 'Ada' });
  });
});
