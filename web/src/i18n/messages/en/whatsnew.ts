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

  // ---------------------------------------------------------------- 0.20.0
  'whatsnew.release.readAlongFromBook':
    "A paired book's page offers Read, Read along and Listen as three buttons; Read along opens the page with the voice already on it.",
  'whatsnew.release.narratorIcon':
    'Read along is drawn as a narrator, and scrolling with the voice as text with a doubled chevron.',

  // ---------------------------------------------------------------- 0.19.0
  'whatsnew.release.selectionCaptions':
    'The selection menu is a pill with a name under each icon; Escape, or a tap elsewhere, drops the selection.',
  'whatsnew.release.spotlight':
    'Search opens as a launcher does: one field at the top, matches as you type, and Enter opens the first.',
  'whatsnew.release.voiceDrawn':
    'Following the voice is chosen from two small drawings: a mark in the margin, or the sentence highlighted.',
  'whatsnew.release.contentsTabs':
    'The contents sheet keeps its Chapters and Bookmarks tabs in view while the list scrolls under them.',

  // ---------------------------------------------------------------- 0.18.0
  'whatsnew.release.pagesOnPhone':
    'Pages on a phone page again: the reader no longer falls back to scrolling a chapter it can paginate.',
  'whatsnew.release.readerBars':
    "The reader's bars are in order: contents, type and search above; friends, the bar and the voice below.",
  'whatsnew.release.selectionIcons':
    'A selection is framed as one, its menu is four icons with the colours behind the highlighter, and a shared passage goes out whole.',
  'whatsnew.release.voiceMark':
    'Reading along shows a mark in the margin or a wash on the sentence, your choice in Reading settings, and both keep up with the text.',

  // ---------------------------------------------------------------- 0.17.0
  'whatsnew.release.liveFriends':
    'A friend in the same book right now shows as a breathing bead on your bar, and as Reading now on the Friends page.',
  'whatsnew.release.shareMenu':
    'Share on the book page is one button with a small menu: copy the link, send it on WhatsApp, or hand it to the share tray.',
  'whatsnew.release.settingsFoot':
    'The foot of Settings shows which version this is and links to GitHub; tap the version to read these notes again.',

  // ---------------------------------------------------------------- 0.16.0
  'whatsnew.release.share':
    'Share a book by link: the cover shows in the chat, a friend here saves it as recommended by you, and anyone else can ask to join.',
  'whatsnew.release.quote':
    "A selection can run on past the page, and the selection menu shares a passage with the book's link.",
  'whatsnew.release.focus':
    'Stats count the times you go back for the thread, and say which hours you hold it best.',
  'whatsnew.release.bookLanguages':
    "Every book's language is read from its own text, and the library filters by language with a row of flags.",
  'whatsnew.release.friendsBeads':
    'Friends on the progress bar are beads with their initials, and a stack beside the percentage opens the list.',
  'whatsnew.release.readAlongLine':
    'Read-along sits on the line being spoken, scrolls with an ease, and shows where the voice picks up when you jump back.',

  // ---------------------------------------------------------------- 0.15.0
  'whatsnew.release.pairingTabs':
    'Pairing is four tabs - Suggested, Linked, Unpaired, Dismissed - with one line per pair, its state, and its alignment at a glance.',
  'whatsnew.release.exportOptions':
    'Exporting highlights asks how you want them: paper or night, a page for the desk or the phone, what to include, and the text size.',
  'whatsnew.release.shelvesDrawer':
    'The shelves drawer now leads to all your books, and on a phone to Stats and Pairing; a synced pair shows the switch arrows between its two formats.',

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
