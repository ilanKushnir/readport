/** Strings of the player surface. Filled during extraction; keys are `player.*`. */
export const player = {
  // Loading, and the two ways it can fail.
  'player.couldNotLoad': 'Could not load this audiobook.',
  'player.error.title': 'Cannot play',
  'player.error.formatUnplayable': 'This audio format could not be played by your browser.',
  'player.error.formatTitle': 'Format not playable in this browser',
  'player.backToDetails': 'Back to details',
  // Top bar: where you are in the book, and the bookmark split control.
  'player.backToBook': 'Back to book',
  'player.top.chapterOf': 'Chapter {n} of {total}',
  'player.top.partOf': 'Part {n} of {total}',
  'player.bookmarks.markHere': 'Bookmark this moment',
  'player.bookmarks.removeHere': 'Remove bookmark at this moment',
  'player.bookmarks.countLabel': 'Bookmarks ({n})',
  // Titles under the cover.
  'player.buffering': 'Buffering…',
  'player.chapterBuffering': '{title} · buffering…',
  // Scrubber and the times around it.
  'player.handoff.marker': 'Handoff from reading',
  'player.transport.position': 'Position in audiobook',
  'player.transport.positionOf': '{position} of {total}',
  'player.transport.leftInChapter': '{time} left in chapter',
  // Transport buttons.
  'player.transport.previousChapter': 'Previous chapter',
  'player.transport.nextChapter': 'Next chapter',
  'player.transport.backSeconds': '{n, plural, one {Back # second} other {Back # seconds}}',
  'player.transport.forwardSeconds':
    '{n, plural, one {Forward # second} other {Forward # seconds}}',
  'player.transport.play': 'Play',
  'player.transport.pause': 'Pause',
  // Secondary chips.
  'player.speed.label': 'Playback speed',
  'player.speed.rate': '{rate}×',
  'player.sleep.chip': 'Sleep',
  'player.sleep.chipChapterEnd': 'Chapter end',
  'player.chapters.title': 'Chapters',
  // Tandem pill: switching to the ebook edition.
  'player.tandem.openEbookTitle': 'Open the ebook at this sentence',
  'player.tandem.notReadyTitle': 'Alignment not ready - switching unavailable',
  'player.tandem.readFromHere': 'Read from here',
  'player.tandem.readFromHereHint': 'Switch to the ebook at the same sentence',
  'player.tandem.aligning': 'Ebook edition · aligning…',
  'player.tandem.aligningHint': 'Switching unlocks once the pair is aligned',
  // Playback sheet: speed and skip lengths.
  'player.speed.sheetTitle': 'Playback',
  'player.speed.current': 'Speed - {rate}×',
  'player.speed.note': 'Pitch is preserved at all speeds. Remembered per book.',
  'player.skip.back': 'Skip back',
  'player.skip.backSeconds': 'Skip back seconds',
  'player.skip.forward': 'Skip forward',
  'player.skip.forwardSeconds': 'Skip forward seconds',
  'player.skip.seconds': '{n}s',
  // Sleep timer sheet, and the toasts when it fires.
  'player.sleep.title': 'Sleep timer',
  'player.sleep.off': 'Off',
  'player.sleep.minutes': '{n} min',
  'player.sleep.hours': '{n, plural, one {# hour} other {# hours}}',
  'player.sleep.endOfChapter': 'End of chapter',
  'player.sleep.addMinutes': '{n, plural, one {Add # minute} other {Add # minutes}}',
  'player.sleep.pausedTimer': 'Sleep timer: paused',
  'player.sleep.pausedChapterEnd': 'End of chapter: paused',
  // Return pill after a jump.
  'player.return.backTo': 'Back to {time}',
  // Bookmarks sheet, and its toasts.
  'player.bookmarks.title': 'Bookmarks',
  'player.bookmarks.empty':
    'No bookmarks yet. Tap the ribbon icon at the top while listening - tap it again at the same spot to remove the mark.',
  'player.bookmarks.atHere': '{time} · here',
  'player.bookmarks.untitled': 'Bookmark',
  'player.bookmarks.delete': 'Delete bookmark',
  'player.bookmarks.addedAt': 'Bookmarked at {time}',
  'player.bookmarks.removed': 'Bookmark removed',
  'player.bookmarks.couldNotSave': 'Could not save the bookmark.',
  'player.bookmarks.couldNotDelete': 'Could not delete the bookmark.',
  // Toasts while listening.
  'player.toast.finished': 'Finished - nicely done',
  'player.toast.playbackBlocked': 'Playback blocked - tap play again',
  // Arriving from the ebook, and leaving for it.
  'player.handoff.startingBefore':
    '{n, plural, one {Starting # second before your reading position, so nothing is spoiled} other {Starting # seconds before your reading position, so nothing is spoiled}}',
  'player.handoff.fromPosition': 'Continuing from your reading position',
  'player.handoff.nearPosition': 'Continuing near your reading position',
  'player.handoff.notStoredOffline': 'This spot was not stored for offline switching.',
  'player.handoff.noAlignedText': 'No aligned text position here.',
  'player.handoff.noAlignedNearest': '{reason} Nearest aligned passage: {pct} through the book.',
  'player.handoff.switchFailed': 'Switching failed - server unreachable?',
} as const;
