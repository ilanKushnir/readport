/**
 * Strings of the library surface: the grid and its shelves, the Continue
 * band, Reading Now, the reading list, the book page and offline downloads.
 * Keys are `library.*`; shelf and facet names live in common.ts.
 */
export const library = {
  // The library page: what it says when a shelf cannot be fetched
  'library.readingNowRefreshFailed':
    'Reading Now could not be refreshed. Reconnect and retry; your progress is kept on this device.',
  'library.offlineShowingDownloads':
    'You appear to be offline. Showing the titles downloaded to this device.',
  'library.loadFailed': 'Could not load the library. Check the server connection.',
  'library.shelf': 'Shelf',
  'library.shelfRemoved': 'Shelf removed',
  'library.missingOnDrive':
    '{n, plural, one {# book on this shelf is on a drive that is not mounted.} other {# books on this shelf are on a drive that is not mounted.}}',
  'library.stats':
    '{ebooks, plural, one {# ebook} other {# ebooks}} · {audio, plural, one {# audiobook} other {# audiobooks}}{paired, plural, =0 {} other { · # paired}}',
  'library.scanning': 'Scanning your libraries - new books appear as they are indexed.',
  // The toolbar: search, format, sort
  'library.searchPlaceholder': 'Search title, author, series',
  'library.searchLabel': 'Search this shelf',
  'library.kindGroup': 'Library type',
  'library.kind.all': 'All',
  'library.kind.ebooks': 'Ebooks',
  'library.kind.audiobooks': 'Audiobooks',
  // The language chips beside the format control
  'library.lang.group': 'Filter by language',
  'library.lang.allLanguages': 'All languages',
  'library.lang.button': 'Language: {name}',
  'library.lang.menuTitle': 'Show books in',
  'library.lang.search': 'Search languages',
  'library.lang.clear': 'Clear the search',
  'library.lang.noMatch': 'No language by that name in this library.',
  'library.sortBy': 'Sort by',
  'library.sort.title': 'By title',
  'library.sort.author': 'By author',
  'library.sort.shelfOrder': 'Shelf order',
  'library.sort.recent': 'Recently active',
  'library.sort.added': 'Recently added',
  // The Continue band and its hero card
  'library.hero.title': 'Continue',
  'library.hero.allInProgress': 'All in progress · {n}',
  'library.continueIn': '{kind, select, ebook {Continue reading} other {Continue listening}}',
  'library.hero.resume': '{kind, select, ebook {Resume reading} other {Resume listening}}',
  'library.hero.instead': '{kind, select, ebook {Listen instead} other {Read instead}}',
  'library.hero.switchSameSpot': 'Continue in the other edition at the same place',
  'library.hero.otherEdition': 'The other edition of this book',
  // Book cards in the grid
  'library.card.details': '{title} details',
  'library.card.audioFormat': 'AUDIO',
  'library.card.syncedTitle': 'Synced - switching lands in the same place',
  'library.card.downloadedTitle': 'Downloaded to this device',
  'library.card.finished': 'Finished',
  'library.card.indexing': 'Indexing…',
  'library.card.indexingFailed': 'Indexing failed',
  'library.card.addTo': 'Add to…',
  'library.card.addLabel': 'Add {title} to a shelf or your reading list',
  // Empty shelves
  'library.empty.scanningTitle': 'Reading your shelves',
  'library.empty.scanningBody':
    '{app} is going through your folders. Books appear here as it finds them.',
  'library.empty.goneTitle': 'That shelf is no longer here',
  'library.empty.goneBody':
    'It was removed - on this device or another one. The books that were on it are all still in your library.',
  'library.empty.backToLibrary': 'Back to the library',
  'library.empty.noMatchesTitle': 'No matches',
  'library.empty.noMatchesBody': 'Nothing here matches this search or filter.',
  'library.empty.deviceTitle': 'Nothing downloaded in this browser',
  'library.empty.deviceBody':
    'Downloads stay on the device that made them and are removed when you sign out. Open a book and choose Download to keep it here.',
  'library.empty.shelfTitle': 'This shelf is empty',
  'library.empty.shelfBody': 'Press the + on any cover in the library, then pick this shelf.',
  'library.empty.browseLibrary': 'Browse the library',
  'library.empty.facetTitle': 'Nothing under {value}',
  'library.empty.facetBody':
    '{facet} come from the books themselves, so this one goes away when the last book carrying it does.',
  'library.empty.autoTitle': 'Nothing here yet',
  'library.empty.auto.reading-now':
    'Start reading or listening and that edition appears here until you finish it.',
  'library.empty.auto.finished': 'Books you read to the end collect here on their own.',
  'library.empty.auto.both-formats':
    'This fills up as {app} matches an ebook to its audiobook. The Pairing page shows what it is considering.',
  'library.empty.auto.recently-added': 'Nothing new has turned up in the last month.',
  'library.empty.libraryTitle': 'Your library is empty',
  'library.empty.libraryBody':
    '{app} reads ebook and audiobook folders you already have, and never writes to them. Choose those folders in Settings → Libraries; each one is tested before it is saved.',
  // The Reading Now shelf: rows and the reset confirmation
  'library.readingNow.needsServerTitle': 'Reading Now needs the server',
  'library.readingNow.needsServerBody':
    'Your place in every book is kept on this device and will sync when you are back online. Downloaded titles are on the On this device shelf.',
  'library.readingNow.listLabel': 'Books you are reading or listening to',
  'library.readingNow.details': '{title}, {kind, select, ebook {Ebook} other {Audiobook}} details',
  'library.readingNow.resetButton': 'Reset progress…',
  // A row that stands for a linked pair must say WHICH edition it resets:
  // "Reset progress…" under a title owned twice is a question, not a label.
  'library.readingNow.resetEdition':
    '{kind, select, ebook {Reset ebook progress…} other {Reset audiobook progress…}}',
  'library.readingNow.resetTitle': 'Reset reading progress?',
  'library.readingNow.resetBody':
    'Reset your progress, checkpoints and reading history for “{title}” ({kind, select, ebook {ebook} other {audiobook}})? It leaves Reading Now and opens from the beginning next time.',
  'library.readingNow.pairedKeepsProgress': 'The paired edition keeps its own progress.',
  'library.readingNow.resetKeeps':
    'The book, its files, alignment, bookmarks, highlights, notes, shelves, reading list and downloads are kept. Nobody else’s progress changes.',
  'library.readingNow.resetFailed':
    'The reset could not be confirmed, so the book stays here. Trying again is safe.',
  'library.readingNow.resetting': 'Resetting…',
  'library.readingNow.resetConfirm': 'Reset reading progress',
  // The reading list (the queue)
  'library.queue.lede': 'What you plan to read next, in the order you plan to read it.',
  'library.queue.offlineCached': 'You appear to be offline. This is the queue as it last looked.',
  'library.queue.offlineNoList':
    'You appear to be offline, so your reading list could not be fetched.',
  'library.queue.loadFailed': 'Could not load your reading list.',
  'library.queue.missingOnDrive':
    '{n, plural, one {# book is on a drive that is not mounted, so it is not shown here.} other {# books are on a drive that is not mounted, so they are not shown here.}}',
  'library.queue.loadFailedTitle': 'Your reading list could not be loaded',
  'library.queue.loadFailedBody':
    'Nothing is lost - the list is on the server and will be here when it answers.',
  'library.queue.emptyTitle': 'Nothing queued yet',
  'library.queue.emptyBody':
    'Press the + on any cover, then Read next to put a book at the front of the line, or Add to reading list to put it at the end.',
  'library.queue.unknownAuthor': 'Unknown author',
  'library.queue.thisBook': 'this book',
  'library.queue.moreFor': 'More for {title}',
  'library.queue.moveGroup': 'Move {title}',
  'library.queue.moveTop': 'Move to top',
  'library.queue.moveUp': 'Move up',
  'library.queue.moveDown': 'Move down',
  'library.queue.moveBottom': 'Move to bottom',
  'library.queue.takeOff': 'Take off the list',
  'library.queue.takenOff': 'Taken off your reading list',
  'library.queue.undo': 'Undo',
  'library.queue.removeFailed': 'Could not remove that just now.',
  'library.queue.reorderFailed': 'Could not save the new order - check the connection.',
  // The book page: hero, banners, actions
  'library.book.loadFailed': 'Could not load this book.',
  'library.book.seriesIndex': '#{n}',
  'library.book.chapters': '{n, plural, one {# chapter} other {# chapters}}',
  'library.book.audioUnsupported':
    'This browser cannot play {format} audio. The file was detected and kept in your library, but listening here needs a browser with {format} support.',
  'library.book.indexingFailed': 'Indexing failed:',
  'library.book.stillIndexing':
    '{app} is still reading this book. It opens as soon as indexing finishes.',
  'library.book.filesMissing': 'The source files for this book are missing from the library mount.',
  'library.book.progress': '{pct} {kind, select, ebook {read} other {listened}}',
  'library.book.stillIndexedTitle': 'Still being indexed',
  'library.book.open': '{kind, select, ebook {Read} other {Listen}}',
  'library.book.openOther': '{kind, select, ebook {Listen} other {Read}}',
  'library.book.readAlong': 'Read along',
  'library.book.readAlongHint': 'The page, with the narration playing over it',
  'library.book.readAlongNotReady': 'Read along unlocks once the pair is aligned',
  'library.book.opening': 'Opening…',
  'library.book.part': 'Part {n}',
  // The book's own file, as opposed to Save offline
  'library.book.downloadFile': 'Download file',
  'library.book.downloadFiles': 'Download files…',
  'library.book.downloadFilesTitle': 'Download files',
  'library.book.downloadFileHint': "The book's own file, saved to this device",
  'library.book.downloadFilesLede': 'The book’s own files, saved to this device to keep.',
  'library.book.downloadZip': '{n, plural, one {# file} other {# files}} in one ZIP · {size}',
  'library.book.downloadParts': 'Or one of the {n} files on its own',
  // Save offline: the copy that stays inside the app
  'library.offline.save': 'Save offline',
  'library.offline.saving': 'Saving offline',
  'library.offline.saved': 'Saved offline',
  'library.offline.saveLabel': 'Save offline, to open without a connection',
  'library.offline.retryLabel': 'Save offline - the last attempt failed',
  'library.offline.savingPct': 'Saving offline, {pct}',
  'library.offline.savedManage': 'Saved offline - manage the offline copy',
  'library.offline.askTitle': 'Save offline?',
  'library.offline.starting': 'Saving offline…',
  'library.offline.startingBoth': 'Saving both editions offline…',
  'library.offline.saveBoth': 'Save both offline{hasSize, select, true { ({size})} other {}}',
  'library.book.otherNotOnDevice':
    'The {kind, select, ebook {audiobook} other {ebook}} is not on this device, so switching needs a connection.',
  'library.book.reviewPairing': 'Review pairing',
  'library.book.candidateFound':
    'A possible {kind, select, ebook {audiobook} other {ebook}} edition was found and is waiting for review.',
  'library.book.review': 'Review',
  'library.book.switchNotStored':
    'This spot was not stored for offline switching - opening the other edition.',
  'library.book.switchNoPosition': 'No aligned position here - opening the other edition.',
  'library.book.switchFailed': 'Could not resolve the position - opening the other edition.',
  // The book page: chapters, annotations, description
  'library.book.chaptersLabel': 'Chapters',
  'library.book.chaptersHead': 'Chapters ({n})',
  'library.book.annotationsLabel': 'Bookmarks and highlights',
  'library.book.annotationsHead': 'Bookmarks & highlights ({n})',
  'library.book.annotationKind':
    '{kind, select, bookmark {Bookmark} highlight {Highlight} other {Note}}',
  'library.book.about': 'About',
  'library.book.aboutMore': 'More',
  'library.book.aboutLess': 'Less',
  'library.meta.tool': 'Metadata',
  'library.meta.toolHint': 'The book\u2019s file, where it is, and what ReadPort knows about it',
  'library.meta.title': 'Metadata',
  'library.meta.loading': 'Loading\u2026',
  'library.meta.failed': 'Could not load the metadata.',
  'library.meta.onDisk': 'On disk',
  'library.meta.missing': 'The file is not on disk now. The next scan will mark the book missing.',
  'library.meta.fileName': 'File',
  'library.meta.folderName': 'Folder',
  'library.meta.location': 'Location',
  'library.meta.libraryTop': 'The top of the library folder',
  'library.meta.library': 'Library folder',
  'library.meta.fullPath': 'Full path',
  'library.meta.format': 'Format',
  'library.meta.modified': 'Modified',
  'library.meta.tracks': '{n, plural, one {# file} other {# files}}',
  'library.meta.fromFile': 'Book details',
  'library.meta.titleLabel': 'Title',
  'library.meta.author': 'Author',
  'library.meta.series': 'Series',
  'library.meta.language': 'Language',
  'library.meta.publisher': 'Publisher',
  'library.meta.identifiers': 'Identifiers',
  'library.meta.tagKind':
    '{kind, select, genre {Genre} narrator {Narrator} year {Year} rating {Rating} other {Tag}}',
  'library.meta.inReadPort': 'In ReadPort',
  'library.meta.id': 'Book ID',
  'library.meta.added': 'Added',
  'library.meta.indexed': 'Indexed',
  'library.meta.state': 'State',
  'library.meta.stateValue':
    '{state, select, ready {Ready} error {Could not be read} missing {Missing from the library} indexing {Being read} discovered {Waiting to be read} other {Unknown}}',
  'library.meta.languageSource':
    '{source, select, manual {Set by hand} metadata {From the file} pair {From the paired edition} detected {Read from the text} other {}}',
  'library.meta.cover': 'Cover',
  'library.meta.coverOwn': 'Its own',
  'library.meta.coverPicked': 'Picked from {source}',
  'library.meta.coverPickedEdition': 'Picked from its other format',
  'library.meta.coverNone': 'None',
  'library.meta.length': 'Length',
  'library.meta.duration': 'Duration',
  'library.meta.chapters': '{n, plural, one {# chapter} other {# chapters}}',
  'library.meta.characters': '{n, plural, one {# character} other {# characters}}',
  'library.meta.pairedWith': 'Paired with',
  'library.meta.pairKind': '{kind, select, audio {Audiobook} other {Ebook}}',
  'library.meta.pairStatus':
    '{status, select, confirmed {Confirmed} auto {Matched automatically} candidate {Suggested} other {Unknown}}',
  'library.meta.hidden': 'Hidden',
  'library.meta.hiddenBy': '{when}, by {name}',
  'library.meta.notSet': 'Not set',
  'library.meta.copy': 'Copy',
  'library.meta.copyPath': 'Copy the full path',
  'library.meta.copyId': 'Copy the book ID',
  'library.meta.copied': 'Copied',
  'library.meta.copyFailed': 'Could not copy that.',
  'library.cover.suggested': 'Suggested',
  'library.cover.suggestedAlt': 'A suggested cover for {title}',
  'library.cover.from': 'From {source}',
  'library.cover.fromAudiobook': 'The audiobook’s cover',
  'library.cover.fromEbook': 'The ebook’s cover',
  'library.cover.use': 'Use this cover',
  'library.cover.saving': 'Saving…',
  'library.cover.previous': 'Previous suggestion',
  'library.cover.next': 'Next suggestion',
  'library.cover.of': '{n} of {total}',
  'library.cover.notThese': 'No thanks',
  'library.cover.keep': 'Keep the current cover',
  'library.cover.find': 'Find a cover',
  'library.cover.finding': 'Looking…',
  'library.cover.nothing': 'No cover turned up for this book.',
  'library.cover.lookFailed': 'Could not look for covers just now. Try again later.',
  'library.cover.failed': 'Could not change the cover just now.',
  'library.cover.saved': 'Cover saved. Your library files are unchanged.',
  'library.cover.dismissed': 'No more cover suggestions for this book.',
  'library.cover.removed': 'Cover removed.',
  'library.cover.pickedFrom': 'Cover from {source}.',
  'library.cover.pickedFromAudiobook': 'Cover from the audiobook.',
  'library.cover.pickedFromEbook': 'Cover from the ebook.',
  'library.cover.change': 'Change',
  'library.cover.remove': 'Remove',
  'library.book.noChaptersTitle': 'No chapters listed',
  'library.book.noChaptersBody':
    'This book has no chapter metadata; you can still {kind, select, ebook {read} other {listen}} normally.',
  // Shelves this book is on
  'library.book.membershipLabel': 'Shelves this book is on',
  'library.book.takeOffQueue': 'Take off the reading list',
  'library.book.takeOffShelf': 'Take off {name}',
  'library.book.takenOffShelf': 'Taken off {name}',
  // The language chip and where a language came from
  'library.book.language': 'Language',
  'library.book.languageUnknown': 'Language unknown',
  'library.book.languageTitle':
    'Language {source, select, manual {set by hand} metadata {from the file} pair {from the paired edition} detected {read from the text} other {}}',
  'library.book.languageAutoOption': 'Auto',
  'library.book.languageUnknownSet': 'Unknown · set by hand?',
  'library.book.languageSet': 'Language set to {name}',
  'library.book.languageAuto': 'Language follows the file again',
  'library.book.languageFailed': 'Could not change the language.',
  // What owning both editions means (lib/pairLabel.ts)
  'library.pair.handoffReady':
    'Read/listen handoff is ready - {pct}% of sentences switch exactly; the rest is approximate or unavailable.',
  'library.pair.candidate': 'A possible matching edition was found - review it in Pairing.',
  'library.pair.linkedUnaligned':
    'Paired edition linked. Switching between text and audio is unavailable until alignment completes.',
  'library.pair.unalignedNote':
    'Not aligned yet - switching between editions is unavailable until alignment completes.',
  'library.pair.manualLinkNote':
    'Choose an ebook and an audiobook of the same work. Alignment runs after linking; switching between editions is unavailable until alignment completes.',
  'library.pair.switchUnaligned':
    'You own {kind, select, ebook {the audiobook} other {the ebook}} too. Timing the two together has not finished, so moving between them will start at the beginning for now.',
  'library.download.inProgress': 'Downloads in progress',
  'library.download.title': 'Downloads',
  'library.download.downloadingN': 'Downloading {n}',
  'library.download.interrupted': 'Interrupted download',
  'library.download.starting': 'Starting…',
  'library.download.progress': '{stored} of {total} · {pct}',
  'library.download.stop': 'Stop',
  'library.download.failed': 'Download failed',
  // The offline button on the book page
  'library.download.bytesOf': '{stored} of {total}',
  'library.download.stopped': 'Download stopped',
  'library.download.available': 'Available offline',
  'library.download.doneBoth': 'Both editions are available offline',
  'library.download.removed': 'Offline copy removed',
  'library.download.needsHttps':
    'Offline downloads need HTTPS (or localhost). See the self-hosting guide in the {app} README.',
  // The offline sheet: before, during and after a download
  'library.download.askLede':
    'Keep {title} on this device for flights and dead zones - about {bytes}{kind, select, ebook { including images} other { of audio}}. {kind, select, ebook {Reading} other {Listening}} works fully offline and your position syncs back when you reconnect. Signing out removes offline copies.',
  'library.download.companionSeparate':
    'The {kind, select, ebook {audiobook} other {ebook}} edition is a separate download{hasSize, select, true { of about {size}} other {}}. Take only this one and you will have the {kind, select, ebook {text} other {audio}} offline but not the other, and no way to switch between them until you reconnect.',
  'library.download.partialLede':
    '{bytes} from the last attempt is still on this device. Starting again continues from there; removing it frees the space now.',
  'library.download.interruptedLede':
    'The download was interrupted - starting again continues from where it stopped.',
  'library.download.onlyThis': '{kind, select, ebook {Ebook} other {Audiobook}} only ({size})',
  'library.download.retry': 'Retry download',
  'library.download.removePartial': 'Remove partial download',
  'library.download.notNow': 'Not now',
  'library.download.cancel': 'Cancel download',
  'library.download.storedLede':
    '{title} is stored on this device ({bytes}). You can {kind, select, ebook {read} other {listen to}} it with no connection; progress syncs when you are back online.',
  'library.download.companionMissing':
    'The {kind, select, ebook {audiobook} other {ebook}} edition is not on this device{hasSize, select, true { ({size})} other {}}. Add it to switch between reading and listening offline.',
  'library.download.addOther': '{kind, select, ebook {Add the audiobook} other {Add the ebook}}',
  'library.download.remove': 'Remove offline copy',
  'library.download.keep': 'Keep',
  // Why a download stopped (offline/downloads.ts error codes)
  'library.download.error.no-cache-storage': 'Offline storage is not available in this browser.',
  'library.download.error.out-of-space':
    'There is not enough room on this device. Remove an offline copy or free up space, then try again.',
  'library.download.error.http': 'The server could not send part of this book.',
  'library.download.error.invalid-response': 'The server sent something this app could not read.',
  'library.download.error.size-mismatch': 'Part of the download arrived incomplete.',
  'library.download.error.integrity':
    'Part of the download did not match what the server promised, so it was not kept.',
  'library.download.error.missing-integrity':
    'The server did not provide the checks this download needs.',
  'library.download.error.no-range': 'The server does not support downloading audio in parts.',
  'library.download.error.wrong-range': 'The server sent the wrong part of an audio file.',
  'library.download.error.source-changed':
    'The book changed on the server during the download. Start again to fetch the new version.',
  'library.download.error.network':
    'The connection kept dropping. Try again when it is steadier; what is saved so far is kept.',
  'library.download.error.server':
    'The server kept answering with an error. Try again in a while; what is saved so far is kept.',
  'library.download.error.stalled':
    'The download kept stalling. Try again; what is saved so far is kept.',
  'library.download.error.interrupted':
    'The download stopped when the app was closed. Try again to carry on from where it got to.',
  'library.download.error.unauthorized': 'You were signed out, so the download stopped.',
  // A download under way, wherever it is shown
  'library.offline.preparing': 'Preparing…',
  'library.offline.preparingLede':
    'The server is getting {title} ready to save: {pct} read so far. It only has to do this once.',
  'library.offline.checking': 'Checking what is already saved…',
  'library.offline.waiting': 'Waiting for a connection…',
  'library.offline.retrying': 'The connection dropped. Trying again…',
  'library.offline.progress': '{stored} of {total} · {pct}',
  'library.offline.keepOpen':
    '{app} keeps the screen on while it saves. On a phone, stay in the app until it finishes.',
  'library.offline.pill': 'Saving offline',
  'library.offline.pillLabel': 'Saving {title} offline, {pct}. Open the book.',
  'library.offline.pillMore': '+{n} more',
  // Hidden books: an admin takes one off everyone else's shelves
  // On the On this device shelf: which editions of a title are saved here
  'library.card.savedHere': '{kind, select, ebook {Ebook} other {Audiobook}} saved on this device',
  'library.card.notSavedHere':
    '{kind, select, ebook {Ebook} other {Audiobook}} not saved on this device',
  'library.hidden.tool': 'Hide',
  'library.hidden.toolHint': 'Hide this book from everyone but admins',
  'library.hidden.askTitle': 'Hide from readers?',
  'library.hidden.askLede': 'Only admins will see {title}.',
  'library.hidden.askShelves':
    'It leaves everyone else’s library, search, shelves and reading lists.',
  'library.hidden.askLinks':
    'Its share links stop opening, and friends stop seeing it in each other’s reading.',
  'library.hidden.askKept':
    'Nothing is deleted. Readers’ progress, notes and shelves come back when you show it again.',
  'library.hidden.askPair': 'The ebook and the audiobook are hidden together.',
  'library.hidden.confirm': 'Hide book',
  'library.hidden.done': 'Hidden. Only admins can see it now.',
  'library.hidden.noteTitle': 'Hidden from readers',
  'library.hidden.noteBy': 'Only admins can see this book. {name} hid it {when}.',
  'library.hidden.noteWhen': 'Only admins can see this book. Hidden {when}.',
  'library.hidden.show': 'Show to everyone',
  'library.hidden.shown': 'Everyone can see it again.',
  'library.hidden.failed': 'Could not change who sees this book.',
  'library.hidden.badge': 'Hidden from readers',
  'library.hidden.shelfLede':
    'Only admins see these books. Open one and choose Show to everyone to put it back.',
  'library.empty.auto.hidden': 'Nothing is hidden. Every book is on everyone’s shelves.',
  'library.book.gone': 'This book is not in the library.',
} as const;
