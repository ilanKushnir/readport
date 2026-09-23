/**
 * The release history behind the "What's new" dialog.
 *
 * Rules of this file:
 *
 * - **Newest release first.** The dialog shows `CHANGELOG[0]` and nothing
 *   else; everything below it hides behind "Older versions".
 * - **Only releases with something a reader would notice get a block.** A
 *   release with no block never re-opens the dialog, which is exactly what
 *   you want for a patch that fixed a crash nobody saw.
 * - **`key` names an i18n message**, `whatsnew.release.<key>`. Release notes
 *   are written in English at release time and translated when somebody gets
 *   to them; a locale that has not caught up falls back to English rather
 *   than blocking a release, which is why the catalog test exempts this one
 *   prefix and no other (see `web/src/i18n/catalog.test.ts`).
 * - **Keep each line to one plain sentence.** This is the only place in the
 *   app that interrupts someone on the way to a book, so it has to earn the
 *   interruption and then get out of the way.
 */

export interface ChangelogItem {
  /** Carried verbatim into the list; decorative, so it is aria-hidden. */
  emoji: string;
  /** Resolves `whatsnew.release.<key>`. */
  key: string;
}

export interface ChangelogRelease {
  /** Matches the tag, without the leading `v`. */
  version: string;
  items: ChangelogItem[];
}

export const CHANGELOG: ChangelogRelease[] = [
  {
    version: '0.21.0',
    items: [
      { emoji: '⚓', key: 'prints' },
      { emoji: '📚', key: 'clothCovers' },
      { emoji: '🌐', key: 'languagePicker' },
    ],
  },
  {
    version: '0.20.0',
    items: [
      { emoji: '🎙️', key: 'readAlongFromBook' },
      { emoji: '🗣️', key: 'narratorIcon' },
    ],
  },
  {
    version: '0.19.0',
    items: [
      { emoji: '✂️', key: 'selectionCaptions' },
      { emoji: '🔎', key: 'spotlight' },
      { emoji: '🎯', key: 'voiceDrawn' },
      { emoji: '📑', key: 'contentsTabs' },
    ],
  },
  {
    version: '0.18.0',
    items: [
      { emoji: '📖', key: 'pagesOnPhone' },
      { emoji: '🧭', key: 'readerBars' },
      { emoji: '✂️', key: 'selectionIcons' },
      { emoji: '🎯', key: 'voiceMark' },
    ],
  },
  {
    version: '0.17.0',
    items: [
      { emoji: '🟢', key: 'liveFriends' },
      { emoji: '🔗', key: 'shareMenu' },
      { emoji: '🏷️', key: 'settingsFoot' },
    ],
  },
  {
    version: '0.16.0',
    items: [
      { emoji: '🔗', key: 'share' },
      { emoji: '💬', key: 'quote' },
      { emoji: '🎯', key: 'focus' },
      { emoji: '🌐', key: 'bookLanguages' },
      { emoji: '📍', key: 'friendsBeads' },
      { emoji: '🔊', key: 'readAlongLine' },
    ],
  },
  {
    version: '0.15.0',
    items: [
      { emoji: '🔗', key: 'pairingTabs' },
      { emoji: '📄', key: 'exportOptions' },
      { emoji: '🗂️', key: 'shelvesDrawer' },
    ],
  },
  {
    version: '0.14.0',
    items: [
      { emoji: '👋', key: 'friends' },
      { emoji: '📊', key: 'stats' },
      { emoji: '🖍️', key: 'highlights' },
      { emoji: '🧭', key: 'connectedApps' },
      { emoji: '📱', key: 'keepsPlace' },
      { emoji: '📚', key: 'oneRowPerBook' },
    ],
  },
  {
    version: '0.13.0',
    items: [
      { emoji: '🌍', key: 'languages' },
      { emoji: '🏷️', key: 'bookLanguage' },
      { emoji: '✈️', key: 'offlineProgress' },
      { emoji: '🔖', key: 'readAlongSteady' },
    ],
  },
  {
    version: '0.12.0',
    items: [
      { emoji: '📖', key: 'readAlongIpad' },
      { emoji: '📍', key: 'exactProgress' },
      { emoji: '🎧', key: 'readingNow' },
      { emoji: '🔌', key: 'agentApi' },
    ],
  },
  {
    version: '0.11.0',
    items: [
      { emoji: '✉️', key: 'invites' },
      { emoji: '🔑', key: 'ssoPassword' },
    ],
  },
];

/** What a reader has to have seen for the dialog to stay shut. */
export const LATEST_RELEASE_VERSION = CHANGELOG[0]!.version;

/** `0.9.7` sorts below `0.13.0`: numerically, per part, never as strings. */
function olderThan(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false; // unparseable: say nothing
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Whether this person should be told about the newest release.
 *
 * `null` is somebody who was already here when this feature landed, and they
 * get it. A new account is stamped with the server's version when it is
 * created, so it is not told about the release it started on - and because
 * the comparison is a real version comparison, a patch release that carries
 * no changelog block of its own does not re-open the dialog either.
 */
export function shouldAnnounce(seenVersion: string | null | undefined): boolean {
  if (seenVersion === undefined) return false; // the session has not answered yet
  if (seenVersion === null) return true;
  return olderThan(seenVersion, LATEST_RELEASE_VERSION);
}
