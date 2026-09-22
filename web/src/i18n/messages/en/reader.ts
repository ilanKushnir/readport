/**
 * Strings of the reader surface: the chrome around a book, the contents,
 * settings, search and note sheets, the selection toolbar, read-along, and
 * every toast the reader can raise. Keys are `reader.*`; the book's own text,
 * language and direction are never touched here.
 */
export const reader = {
  // Opening a book, and when it cannot be opened
  'reader.error.title': 'Cannot open book',
  'reader.error.openFailed': 'Could not open this book. It may still be indexing.',
  'reader.error.chapterFailed': 'Could not load this chapter (offline and not downloaded?).',
  'reader.error.backToDetails': 'Back to details',
  'reader.loadingChapter': 'Loading chapter',

  // Top chrome
  'reader.chrome.backToBook': 'Back to book',
  'reader.chrome.contents': 'Table of contents',
  'reader.chrome.search': 'Search in book',
  'reader.chrome.bookmarkPage': 'Bookmark this page',
  'reader.chrome.removeBookmark': 'Remove bookmark from this page',
  'reader.chrome.marksWithCount': 'Bookmarks and notes ({n})',
  'reader.chrome.settings': 'Reading settings',
  'reader.chrome.previousPage': 'Previous page',
  'reader.chrome.nextPage': 'Next page',

  // The resumed position, and the way back after a jump
  'reader.resumeMarker': 'Your resumed reading position',
  'reader.return.backTo': 'Back to {label}',

  // End of a chapter
  'reader.chapterEnd.next': 'Next: {title}',
  'reader.chapterEnd.finish': 'Finish book',

  // Selecting text
  'reader.select.toolbar': 'Selected text',
  'reader.select.highlight': 'Highlight',
  'reader.select.highlightIn':
    '{color, select, amber {Highlight in amber} rose {Highlight in rose} plum {Highlight in plum} sky {Highlight in sky} sand {Highlight in sand} other {Highlight}}',
  'reader.select.note': 'Note',
  'reader.select.bookmark': 'Bookmark',
  'reader.select.share': 'Share',
  'reader.select.clear': 'Clear selection',
  // A selection carried over a page turn, and the pill that finishes it
  'reader.select.continue': 'Continue selection',
  'reader.select.continueArmed': 'Tap where it ends',

  // Sharing a quotation
  'reader.share.text': 'Look what I read in {title}: “{quote}” {url}',
  'reader.share.copied': 'Copied - paste it anywhere',

  // Highlight colours, as a screen reader says them
  'reader.color.amber': 'Amber',
  'reader.color.rose': 'Rose',
  'reader.color.plum': 'Plum',
  'reader.color.sky': 'Sky',
  'reader.color.sand': 'Sand',

  // A mark, and its popover
  'reader.mark.kind': '{kind, select, bookmark {Bookmark} note {Note} other {Highlight}}',
  'reader.mark.colour': 'Colour',
  'reader.quoted': '“{text}”',

  // Bottom chrome: where you are
  'reader.progress.position': 'Book position',
  'reader.progress.chapterScrolls': 'This chapter scrolls',
  'reader.progress.wholeChapter': 'Whole chapter on this page',
  'reader.progress.lastPage': 'Last page in chapter',
  'reader.progress.pagesLeft':
    '{n, plural, one {# page left in chapter} other {# pages left in chapter}}',
  'reader.progress.miniTitle': '{chapter} · chapter {pct}',

  // Bottom chrome: the audiobook of a pair
  'reader.tandem.readAlong': 'Read along',
  'reader.tandem.readingAlong': 'Reading along',
  'reader.tandem.aligning': 'Audio · aligning…',
  'reader.tandem.readAlongHint': 'Play the narration over the page you are reading',
  'reader.tandem.notReadyHint': 'Alignment not ready - the narration cannot follow the text yet',
  'reader.tandem.listenInstead': 'Listen instead',
  'reader.tandem.listenHint': 'Leave the page and switch to the audiobook at this sentence',

  // Switching to the audiobook
  'reader.switch.notStoredOffline': 'This spot was not stored for offline switching.',
  'reader.switch.noAlignedAudio': 'No aligned audio position here.',
  'reader.switch.nearestNarration': 'Nearest aligned narration: {time}.',
  'reader.switch.failed': 'Switching failed - server unreachable?',

  // Arriving from the player
  'reader.handoff.from': 'Continuing from your listening position',
  'reader.handoff.near': 'Continuing near your listening position',

  // Read-along transport and its messages
  'reader.readAlong.group': 'Read along',
  'reader.readAlong.play': 'Play narration',
  'reader.readAlong.pause': 'Pause narration',
  'reader.readAlong.find': 'Find the narration',
  'reader.readAlong.back': 'Back {n, plural, one {# second} other {# seconds}}',
  'reader.readAlong.finding': 'Finding the narration…',
  'reader.readAlong.timingsFailed': 'Could not load this chapter’s timings',
  'reader.readAlong.nothingTimed': 'Nothing timed in this chapter',
  'reader.readAlong.gap': 'No timed text here',
  'reader.readAlong.backToVoice': 'Back to the voice',
  'reader.readAlong.autoScrollOn': 'Scroll with the voice',
  'reader.readAlong.autoScrollOff': 'Stop scrolling with the voice',
  'reader.readAlong.speed': 'Speed {rate}×',
  'reader.readAlong.rate': '{rate}×',
  'reader.readAlong.stop': 'Stop reading along',
  'reader.readAlong.audiobookFailed': 'The audiobook could not be loaded.',
  'reader.readAlong.playFailed': 'This audio could not be played.',
  'reader.readAlong.formatFailed': 'This audio format could not be played by your browser.',
  'reader.readAlong.hint': 'Reading along - tap any line to move the voice there',
  'reader.readAlong.stillLoading': 'The narration is still loading.',
  'reader.readAlong.voiceElsewhere':
    'The voice is in another chapter. Press play and the page will find it.',
  'reader.readAlong.noTimedText': 'No timed text to return to on this page yet.',
  'reader.readAlong.reducedMotion':
    'Your system asks for reduced motion, so the page will not scroll by itself.',

  // Toasts
  'reader.toast.otherDeviceAt': 'Another device is at {pct}',
  'reader.toast.jumpThere': 'Jump there',
  'reader.toast.markMoved':
    "Landed at the words of this mark; the book's text has changed since it was made.",
  'reader.toast.finished': 'The End - marked as finished',
  'reader.toast.saved':
    '{kind, select, bookmark {Bookmarked} note {Note saved} other {Highlighted}}',
  'reader.toast.couldNotSave': 'Could not save - are you offline?',
  'reader.toast.couldNotSaveChange': 'Could not save the change - are you offline?',
  'reader.toast.couldNotDelete': 'Could not delete - are you offline?',
  'reader.toast.bookmarkRemoved': 'Bookmark removed',
  'reader.toast.couldNotRemoveBookmark': 'Could not remove the bookmark - are you offline?',
  'reader.toast.bookmarkedPage': 'Bookmarked page {n}',
  'reader.toast.bookmarkedPassage': 'Bookmarked this passage',
  'reader.toast.openBookmarks': 'Bookmarks',
  'reader.toast.copyFailed': 'Could not copy',

  // Progress notices from the engine
  'reader.notice.resetElsewhere': 'Your progress in this book was reset from another device.',
  'reader.notice.keepReadingHere': 'Keep reading from here',
  'reader.notice.storageDegraded':
    'This browser blocks site storage, so your place is kept only while this page is open.',

  // Contents sheet
  'reader.contents.title': 'Contents',
  'reader.contents.chaptersTab': 'Chapters',
  'reader.contents.marksTab': 'Bookmarks & notes',
  'reader.contents.marksTabCount': 'Bookmarks & notes · {n}',
  'reader.contents.noMarks':
    'No bookmarks yet. Tap the ribbon icon while reading to mark a page; select text to highlight or add a note.',
  'reader.contents.bookmarkedPage': 'Bookmarked page',
  'reader.contents.markWhere': '{kind} · {chapter} · {pct}',
  'reader.contents.markLabel': '{kind}, {chapter}, {pct}: {text}',
  'reader.contents.quoteAndNote': '{text} - {note}',
  'reader.contents.deleteMark':
    '{kind, select, bookmark {Delete bookmark} note {Delete note} other {Delete highlight}}',
  'reader.contents.noToc': 'No table of contents in this book.',

  // Settings sheet
  'reader.settings.title': 'Reading settings',
  'reader.settings.theme': 'Theme',
  'reader.settings.themeLabel': '{name} theme',
  'reader.theme.auto': 'Auto',
  'reader.theme.paper': 'Paper',
  'reader.theme.sepia': 'Sepia',
  'reader.theme.night': 'Night',
  'reader.theme.contrast': 'Contrast',
  'reader.settings.textSize': 'Text size',
  'reader.settings.smaller': 'Smaller text',
  'reader.settings.larger': 'Larger text',
  'reader.settings.brightness': 'Page brightness',
  'reader.settings.font': 'Font',
  'reader.font.literata': 'Literata',
  'reader.fontNote.literata': 'Bundled · designed for screens',
  'reader.font.iowan': 'Iowan Old Style',
  'reader.fontNote.iowan': 'Apple Books default',
  'reader.font.charter': 'Charter',
  'reader.fontNote.charter': 'Crisp, compact serif',
  'reader.font.palatino': 'Palatino',
  'reader.fontNote.palatino': 'Classic book face',
  'reader.font.georgia': 'Georgia',
  'reader.fontNote.georgia': 'Sturdy and familiar',
  'reader.font.baskerville': 'Baskerville',
  'reader.fontNote.baskerville': 'Elegant transitional serif',
  'reader.font.sans': 'System sans',
  'reader.fontNote.sans': 'Your device’s interface font',
  'reader.settings.mode': 'How it reads',
  'reader.mode.paginated': 'Pages',
  'reader.mode.scroll': 'Scroll',
  'reader.settings.columns': 'Pages at a time',
  'reader.columns.auto': 'Auto',
  'reader.columns.one': 'One',
  'reader.columns.two': 'Two',
  'reader.settings.pageTurn': 'Page turn',
  'reader.pageTurn.slide': 'Slide',
  'reader.pageTurn.fade': 'Fade',
  'reader.pageTurn.instant': 'Instant',
  'reader.settings.pagesNote': 'Tap either edge, swipe, or use the arrow keys.',
  'reader.settings.scrollNote': 'One continuous column. Scroll, or swipe up and down.',
  'reader.settings.progressBar': 'Progress bar',
  'reader.progressBar.full': 'Full',
  'reader.progressBar.compact': 'Compact',
  'reader.progressBar.hidden': 'Hidden',
  'reader.settings.spacing': 'Spacing',
  'reader.settings.lines': 'Lines',
  'reader.settings.lineHeight': 'Line height',
  'reader.settings.weight': 'Weight',
  'reader.settings.fontWeight': 'Font weight',
  'reader.settings.margins': 'Margins',
  'reader.margin.compact': 'Compact',
  'reader.margin.normal': 'Normal',
  'reader.margin.wide': 'Wide',
  'reader.settings.text': 'Text',
  'reader.settings.alignment': 'Text alignment',
  'reader.align.start': 'Ragged',
  'reader.align.justify': 'Justified',
  'reader.settings.hyphenation': 'Hyphenation',

  // Search sheet
  'reader.search.title': 'Search in book',
  'reader.search.placeholder': 'Find in this book',
  'reader.search.input': 'Search text',
  'reader.search.go': 'Search',
  'reader.search.firstMatches': 'First {n} matches',
  'reader.search.matches': '{n, plural, one {# match} other {# matches}}',
  'reader.search.failed': 'Could not search - are you offline?',
  'reader.search.none': 'No matches.',

  // Note sheet
  'reader.note.add': 'Add note',
  'reader.note.edit': 'Edit note',
  'reader.note.discard': 'Discard this note?',
  'reader.note.label': 'Note',
  'reader.note.save': 'Save note',
  'reader.note.saveChanges': 'Save changes',
} as const;
