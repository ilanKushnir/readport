import { LIVE_WINDOW_MS, liveNow } from './friends.js';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRIENDS_PREFS,
  FRIEND_COLOURS,
  FRIEND_COLOUR_IDS,
  friendColour,
  friendColourById,
  friendColourStyle,
  friendsPrefsSchema,
  isFriendColourId,
} from './friends';

/**
 * The palette is small on purpose and dealt in a fixed order, so the reader
 * and the friends page agree on who is plum without asking each other.
 */

describe('friendColour', () => {
  it('deals the six colours in order and then starts again', () => {
    expect(FRIEND_COLOURS).toHaveLength(6);
    expect(FRIEND_COLOUR_IDS).toEqual(['plum', 'sky', 'moss', 'rose', 'amber', 'sand']);
    expect(FRIEND_COLOUR_IDS.map((_, i) => friendColour(i).id)).toEqual(FRIEND_COLOUR_IDS);
    expect(friendColour(6).id).toBe('plum');
    expect(friendColour(7).id).toBe('sky');
    expect(friendColour(13).id).toBe('sky');
  });

  it('starts over for anything that is not a whole number, rather than throwing', () => {
    expect(friendColour(-1).id).toBe('plum');
    expect(friendColour(1.5).id).toBe('plum');
    expect(friendColour(Number.NaN).id).toBe('plum');
  });

  it('carries a paper hue and a dark hue for every colour', () => {
    for (const c of FRIEND_COLOURS) {
      expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(c.dark).toMatch(/^#[0-9a-f]{6}$/);
    }
    // The app's existing highlight hues, so a friend's mark and a highlight
    // in the same colour are the same colour.
    expect(friendColourById('plum').hex).toBe('#5e4a8a');
    expect(friendColourById('rose').hex).toBe('#b4532a');
  });
});

describe('friendColourById', () => {
  it('finds a colour by name and falls back to the first for anything else', () => {
    expect(friendColourById('moss').id).toBe('moss');
    expect(friendColourById('neon').id).toBe('plum');
    expect(friendColourById(null).id).toBe('plum');
    expect(friendColourById(undefined).id).toBe('plum');
  });

  it('names the palette and nothing else', () => {
    expect(isFriendColourId('sand')).toBe(true);
    expect(isFriendColourId('SAND')).toBe(false);
    expect(isFriendColourId('#8c7860')).toBe(false);
    expect(isFriendColourId(3)).toBe(false);
  });
});

describe('friendColourStyle', () => {
  it('sets both custom properties so the stylesheet can pick by theme', () => {
    expect(friendColourStyle('sky')).toEqual({
      '--friend-colour': '#466e96',
      '--friend-colour-dark': '#6491be',
    });
  });
});

describe('friendsPrefsSchema', () => {
  it('fills in the defaults for a document that only says one thing', () => {
    const parsed = friendsPrefsSchema.parse({ shareProgress: false });
    expect(parsed).toEqual({ shareProgress: false, colours: {}, shown: {} });
    expect(friendsPrefsSchema.parse({})).toEqual(DEFAULT_FRIENDS_PREFS);
  });

  it('keeps a colour only when it is one of the palette', () => {
    expect(friendsPrefsSchema.safeParse({ colours: { user_1: 'moss' } }).success).toBe(true);
    expect(friendsPrefsSchema.safeParse({ colours: { user_1: '#3d6b4f' } }).success).toBe(false);
    expect(friendsPrefsSchema.safeParse({ shown: { book_1: ['user_1'] } }).success).toBe(true);
    expect(friendsPrefsSchema.safeParse({ shown: { book_1: 'user_1' } }).success).toBe(false);
  });
});

describe('liveNow', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('calls a reader present for six minutes past a page turn, a listener for ninety seconds', () => {
    expect(liveNow('ebook', ago(5 * 60_000), now)).toBe(true);
    expect(liveNow('ebook', ago(LIVE_WINDOW_MS.ebook + 1), now)).toBe(false);
    expect(liveNow('audio', ago(60_000), now)).toBe(true);
    expect(liveNow('audio', ago(LIVE_WINDOW_MS.audio + 1), now)).toBe(false);
  });
  it('tolerates a device a little ahead of the server, and refuses garbage', () => {
    expect(liveNow('ebook', ago(-30_000), now)).toBe(true);
    expect(liveNow('ebook', ago(-120_000), now)).toBe(false);
    expect(liveNow('ebook', 'not a date', now)).toBe(false);
  });
});
