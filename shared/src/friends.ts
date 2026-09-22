import { z } from 'zod';

/**
 * Friends.
 *
 * Everyone on a ReadPort server already shares one library, so a friendship
 * is not about access to books - it is consent to see each other's place in
 * them, and to have a book put in front of you. What is shared is small and
 * specific: which book, how far along, and nothing written in the margins.
 *
 * The colour a friend wears is the VIEWER's choice, kept in their own
 * preferences (`FriendsPrefs.colours`) and never seen by the friend. Until a
 * colour is chosen, one is dealt from the palette below in the order the
 * friendships were made, cycling - so the first friend is plum, the seventh
 * is plum again.
 */

export interface FriendColour {
  /** What the preference stores and the API returns: the NAME, not a hex. */
  id: string;
  /** The hue on the light (paper) theme. */
  hex: string;
  /** The same hue lifted for the dark theme, where the paper values sink. */
  dark: string;
}

/**
 * The app's existing highlight hues, plus moss. Six, because that is how
 * many stay tellable apart as 3px marks on a progress bar; the names match
 * `--rd-mark-*` in tokens.css where they exist, and the dark values are the
 * night reader theme's.
 */
export const FRIEND_COLOURS = [
  { id: 'plum', hex: '#5e4a8a', dark: '#826cb4' },
  { id: 'sky', hex: '#466e96', dark: '#6491be' },
  { id: 'moss', hex: '#3d6b4f', dark: '#5f9a74' },
  { id: 'rose', hex: '#b4532a', dark: '#c86a3e' },
  { id: 'amber', hex: '#d6a034', dark: '#d6a034' },
  { id: 'sand', hex: '#8c7860', dark: '#a08e74' },
] as const satisfies readonly FriendColour[];

export type FriendColourId = (typeof FRIEND_COLOURS)[number]['id'];

export const FRIEND_COLOUR_IDS = FRIEND_COLOURS.map((c) => c.id) as readonly FriendColourId[];

export function isFriendColourId(value: unknown): value is FriendColourId {
  return typeof value === 'string' && (FRIEND_COLOUR_IDS as readonly string[]).includes(value);
}

/**
 * The default colour of the friend at `index` in the order they were added,
 * cycling through the palette. Anything that is not a whole number starts
 * over at the first colour rather than throwing.
 */
export function friendColour(index: number): (typeof FRIEND_COLOURS)[number] {
  const n = Number.isInteger(index) && index >= 0 ? index : 0;
  return FRIEND_COLOURS[n % FRIEND_COLOURS.length]!;
}

/** A colour by its name; the first of the palette for a name nothing knows. */
export function friendColourById(id: string | null | undefined): (typeof FRIEND_COLOURS)[number] {
  return FRIEND_COLOURS.find((c) => c.id === id) ?? FRIEND_COLOURS[0];
}

/**
 * Inline custom properties for one friend's colour, so a stylesheet can pick
 * the paper or the dark value by theme without knowing the palette:
 *
 *   .friends-dot { background: var(--friend-colour); }
 *   [data-app-theme='dark'] .friends-dot { background: var(--friend-colour-dark); }
 */
export function friendColourStyle(id: string | null | undefined): {
  '--friend-colour': string;
  '--friend-colour-dark': string;
} {
  const c = friendColourById(id);
  return { '--friend-colour': c.hex, '--friend-colour-dark': c.dark };
}

/** A recommendation's note: one line of your own, not a review. */
export const RECOMMENDATION_NOTE_MAX = 500;

/**
 * Per-account friend preferences (the `friends` key in user_prefs).
 *
 *  - `shareProgress` is the one thing the OTHER side sees: off, and friends
 *    get "not sharing" instead of a position, everywhere.
 *  - `colours` maps a friend's user id to the colour this viewer gave them.
 *  - `shown` maps a book id to the friends whose marks sit on its progress
 *    bar, for the reader; a book with no entry shows everyone.
 */
export const friendsPrefsSchema = z.object({
  shareProgress: z.boolean().default(true),
  colours: z
    .record(
      z.string().min(1).max(64),
      z.enum(FRIEND_COLOUR_IDS as [FriendColourId, ...FriendColourId[]]),
    )
    .default({}),
  shown: z
    .record(z.string().min(1).max(64), z.array(z.string().min(1).max(64)).max(50))
    .default({}),
});

export type FriendsPrefs = z.infer<typeof friendsPrefsSchema>;

export const DEFAULT_FRIENDS_PREFS: FriendsPrefs = {
  shareProgress: true,
  colours: {},
  shown: {},
};
