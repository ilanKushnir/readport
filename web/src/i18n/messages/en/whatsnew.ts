/**
 * The "What's new" dialog, and the card that says a newer version is ready.
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

  // The card at the bottom of the screen when the server runs a newer version
  'whatsnew.update.title': 'A new version of ReadPort is ready',
  'whatsnew.update.detail': 'Refresh to start using version {version}.',
  'whatsnew.update.refresh': 'Refresh',
  'whatsnew.update.refreshing': 'Refreshing…',
  'whatsnew.update.later': 'Not now',

  // ---------------------------------------------------------------- 0.29.0
  'whatsnew.release.editMany':
    'Edit in the library: select several books and set their language, put them on a shelf or your reading list, take them off a shelf or hide them, all at once.',
  'whatsnew.release.desktopDialogs':
    'On a computer, what a book page’s tools open - Metadata, Pair, Add to and the rest - is a dialog in the middle of the screen, not a strip down its edge.',

  // ---------------------------------------------------------------- 0.28.0
  'whatsnew.release.pairFromBook':
    'Pair a book from its own page: Pair lists the books of the other format, the likeliest match first, and your pick replaces a pairing that was wrong.',
  'whatsnew.release.pairingOnPhone':
    'On a phone, Pairing and Stats sit at the top of the Shelves sheet, with a count of the suggestions waiting for review.',

  // ---------------------------------------------------------------- 0.27.0
  'whatsnew.release.audiobookNames':
    'Audiobooks are named after their folders when their files disagree: author, series and volume number, no more books called after their first track.',
  'whatsnew.release.bookMetadata':
    'Admins can open a book\u2019s metadata from its page: the file, where it is on the server, and what ReadPort made of it.',

  // ---------------------------------------------------------------- 0.26.0
  'whatsnew.release.coverSuggestions':
    'A book without a cover can get one: curators pick from its other format\u2019s cover or what Apple Books, Audible, Google Books and Open Library have for it.',
  'whatsnew.release.languageSearch':
    'The language button in the library opens a list you can search, with each language\u2019s own name and how many books it has.',
  'whatsnew.release.dragSheets':
    'On a phone, panels like Shelves slide up from the bottom and close again when you pull their handle down.',
  'whatsnew.release.aboutLaidOut':
    'A book\u2019s About section shows its formatting instead of its tags, and a long one folds away under More.',

  // ---------------------------------------------------------------- 0.25.0
  'whatsnew.release.otherLanguages':
    'Link a book to its translation: a friend reading it in another language is on your bar, and you can carry on in the other language from the same paragraph.',
  'whatsnew.release.passageIn':
    'Select a passage and see it as the book\u2019s other language has it, or open that edition right there.',

  // ---------------------------------------------------------------- 0.24.0
  'whatsnew.release.updateCard':
    'When a new version of ReadPort is ready, a card at the bottom of the screen says so, with a button to refresh into it.',

  // ---------------------------------------------------------------- 0.23.0
  'whatsnew.release.turnWithVoice':
    'Reading along in page view, the tabs at the sides of the page turn it, and the voice starts reading the new page.',

  // ---------------------------------------------------------------- 0.22.0
  'whatsnew.release.offlineSurvives':
    'Saving a big audiobook offline carries on through a dropped connection, and shows its progress wherever you are in the app.',
  'whatsnew.release.audiobookZip':
    'Download files gives you the ebook and the whole audiobook, all its files in one ZIP.',
  'whatsnew.release.scrollByPassage':
    'Scroll with the voice holds the page still while a passage is read, and moves once for the next.',
  'whatsnew.release.hiddenBooks':
    'Admins can hide a book from everyone else, and show it again without anyone losing their place.',

  // ---------------------------------------------------------------- 0.21.0
  'whatsnew.release.prints':
    "Empty shelves, notes and friends have small harbour prints, the sign-in page has the harbour, and every chapter ends with a printer's flower.",
  'whatsnew.release.clothCovers':
    'A book with no cover of its own is bound in cloth, with its title on a paper label.',
  'whatsnew.release.languagePicker':
    'Languages are one button beside Ebooks and Audiobooks: pick one from the list, or All languages.',

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
