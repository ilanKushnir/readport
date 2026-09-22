/**
 * The "What's new" dialog.
 *
 * Two kinds of key live here. The CHROME - title, controls, the eyebrow -
 * is ordinary interface text and every language is expected to carry it.
 * The RELEASE NOTES under `whatsnew.release.` are written when a release is
 * cut and translated afterwards; a language that has not caught up shows
 * the English line rather than holding up the release.
 */
export const whatsnew = {
  'whatsnew.eyebrow': 'Version {version}',
  'whatsnew.title': "What's new",
  'whatsnew.lede': 'A few things changed since you were last here.',
  'whatsnew.showOlder': 'Older versions',
  'whatsnew.hideOlder': 'Hide older versions',
  'whatsnew.olderHeading': 'Version {version}',
  'whatsnew.done': 'Start reading',

  // ---------------------------------------------------------------- 0.14.0
  'whatsnew.release.friends':
    'Friends: see where a friend is in a book, draw them on your progress bar, and put a book in front of them.',
  'whatsnew.release.stats':
    'Your reading: when you read, how much, how long a sitting runs, and after two weeks the hour you read best.',
  'whatsnew.release.highlights':
    'Highlights and notes have a home of their own, book by book, sorted by place or colour, and export to a PDF.',
  'whatsnew.release.connectedApps':
    'The other apps beside this library - Calibre-Web Automated, Audiobookshelf and the rest - are one tap away under the shelves.',
  'whatsnew.release.keepsPlace':
    'Turning an iPad, switching apps, or jumping to a highlight no longer loses your page.',
  'whatsnew.release.oneRowPerBook':
    'A book you own in both formats appears once on every shelf, and manual linking only offers what is still unlinked.',

  // ---------------------------------------------------------------- 0.13.0
  'whatsnew.release.languages':
    'The interface speaks 23 languages, picked per account in Settings. Hebrew and Arabic read right to left, and every book keeps its own direction.',
  'whatsnew.release.bookLanguage':
    "A book's language now comes from the file, a verified paired edition, or the prose itself, and you can browse several languages at once.",
  'whatsnew.release.offlineProgress':
    'Reading with no connection is recorded properly again, and syncs the moment you are back.',
  'whatsnew.release.readAlongSteady':
    'Read-along no longer jumps back to the start of the chapter a second in.',

  // ---------------------------------------------------------------- 0.12.0
  'whatsnew.release.readAlongIpad':
    'Read-along follows the spoken line across a two-page spread, and scrolling away hands the page back to you without stopping the voice.',
  'whatsnew.release.exactProgress':
    'Your place is saved to the exact line, survives going offline, and a stale tab can no longer undo a deliberate rewind.',
  'whatsnew.release.readingNow':
    'Reading Now collects what you actually have on the go, with a per-edition reset that leaves everything else alone.',
  'whatsnew.release.agentApi':
    'A read-only API so an assistant or a script can see your library without touching it.',

  // ---------------------------------------------------------------- 0.11.0
  'whatsnew.release.invites':
    'Invite people with a link, or a code short enough to read down the phone.',
  'whatsnew.release.ssoPassword':
    'An account that signs in through a proxy can give itself a password too.',
} as const;
