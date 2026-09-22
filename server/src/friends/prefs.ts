import type { z } from 'zod';
import {
  DEFAULT_FRIENDS_PREFS,
  FRIEND_COLOUR_IDS,
  RECOMMENDATION_NOTE_MAX,
  friendColour,
  friendsPrefsSchema as sharedFriendsPrefsSchema,
  type FriendColourId,
} from '@readport/shared';

/**
 * The `friends` preference, as the server accepts it.
 *
 * The palette and the shape live in shared/src/friends.ts, which is what the
 * web reads too. What the server adds is a ceiling on the two maps: they are
 * written by the client as whole documents, and an unbounded record is a
 * row that grows for as long as someone keeps writing to it.
 */
export { DEFAULT_FRIENDS_PREFS, FRIEND_COLOUR_IDS, RECOMMENDATION_NOTE_MAX };
export type { FriendColourId };

/**
 * The colour a friend wears until the viewer picks one: dealt in the order
 * the friendships were made, cycling through the palette.
 */
export function defaultFriendColour(index: number): FriendColourId {
  return friendColour(index).id;
}

export const friendsPrefsSchema = sharedFriendsPrefsSchema
  .refine((p) => Object.keys(p.colours).length <= 500, { message: 'Too many colours' })
  .refine((p) => Object.keys(p.shown).length <= 1000, { message: 'Too many books' });

export type FriendsPrefs = z.infer<typeof friendsPrefsSchema>;
