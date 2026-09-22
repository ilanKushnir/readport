/**
 * Strings of the shell surface: the shelf rail and the overlays it becomes,
 * browsing by the library's own groupings, the "Add to…" sheet, the library
 * folder editor, the processing queue and the alignment pipeline diagram.
 */
export const shell = {
  // Shared by the shelf forms and the folder editor
  'shell.add': 'Add',

  // Sidebar: the reading list row and the shelves
  'shell.shelves.nextUp': 'Next: {title}',
  'shell.shelves.mine': 'My shelves',
  'shell.shelves.new': 'New shelf',
  'shell.shelves.empty': 'A shelf is just a name and a pile of books.',
  'shell.shelves.name': 'Shelf name',
  'shell.shelves.unnamed': 'Shelf',
  'shell.shelves.removeQuestion': 'Remove this shelf?',
  'shell.shelves.removeKeepsBooks':
    '{n, plural, one {The # book on it stays in your library.} other {The # books on it stay in your library.}}',
  'shell.shelves.keepIt': 'Keep it',
  'shell.shelves.moveGroup': 'Move {name}',
  'shell.shelves.toTop': 'To top',
  'shell.shelves.up': 'Up',
  'shell.shelves.down': 'Down',
  'shell.shelves.toBottom': 'To bottom',
  'shell.shelves.removeEllipsis': 'Remove…',
  'shell.shelves.renameOrRemove': 'Rename or remove the shelf {name}',
  'shell.shelves.removed': 'Removed {name}',
  'shell.shelves.nameTaken': 'You already have a shelf with that name.',
  'shell.shelves.createFailed': 'Could not make that shelf just now.',
  'shell.shelves.renameFailed': 'Could not rename that shelf just now.',
  'shell.shelves.removeFailed': 'Could not remove that shelf just now.',
  'shell.shelves.reorderFailed': 'Could not save the new order - check the connection.',

  // Reordering a list: what a screen reader hears (reorder.ts)
  'shell.reorder.grabbed':
    'Grabbed {label}, position {at} of {total}. Use the arrow keys to move it, space to drop it, escape to leave it where it was.',
  'shell.reorder.dropped': 'Dropped at {label}, position {at} of {total}.',
  'shell.reorder.left': 'Left {label}, position {at} of {total}.',
  'shell.reorder.moved': 'Moved to {label}, position {at} of {total}.',
  'shell.reorder.cancelled': '{label} left where it was.',
  'shell.reorder.handle': 'Reorder {label}, position {at} of {total}',

  // Browse: the library's own groupings
  'shell.browse.heading': 'Browse',
  'shell.browse.nothingChosen': 'Nothing chosen.',
  'shell.browse.pickWhatToShow': 'Pick what to show',
  'shell.browse.showAll': 'Show all {n}',
  'shell.browse.customiseTitle': 'What to browse by',
  'shell.browse.customiseLede':
    'These come from your own files - Calibre tags, audiobook genres, whatever your library already says. {appName} never writes any of it back.',
  // Where each grouping's values come from (FACET_SPECS.source)
  'shell.facetSource.genre': 'Calibre tags (dc:subject) and audiobook genre tags',
  'shell.facetSource.author': "The book's own author metadata",
  'shell.facetSource.series': 'Calibre series, or a series tag',
  'shell.facetSource.narrator': 'The narrator or composer tag on the audio files',
  'shell.facetSource.publisher': 'dc:publisher',
  'shell.facetSource.language': "The book's declared language",
  'shell.facetSource.year': 'dc:date, or the audio date tag',
  'shell.facetSource.rating': 'calibre:rating',

  // "Add to…" sheet
  'shell.addTo.readNext': 'Read next',
  'shell.addTo.frontOfQueue': 'Front of the queue',
  'shell.addTo.onReadingList': 'On your reading list',
  'shell.addTo.addToReadingList': 'Add to reading list',
  'shell.addTo.noShelves': 'No shelves yet - a shelf is just a name and a pile of books.',
  'shell.addTo.newShelf': 'New shelf…',
  'shell.addTo.undo': 'Undo',
  'shell.addTo.addedTo': 'Added to {shelf}',
  'shell.addTo.takenOff': 'Taken off {shelf}',
  'shell.addTo.takenOffReadingList': 'Taken off your reading list',
  'shell.addTo.movedToFront': 'Moved to the front of your reading list',
  'shell.addTo.nextUp': 'Next up on your reading list',
  'shell.addTo.queuedAt':
    'Queued {n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} on your reading list',
  'shell.addTo.addedToReadingList': 'Added to your reading list',
  'shell.addTo.saveFailed': 'That did not save - check the connection.',

  // Library folders (setup wizard and Settings)
  'shell.folders.empty':
    '{kind, select, ebook {No ebook folders yet.} audio {No audiobook folders yet.} other {No alignment folders yet.}} Add the folder as the server sees it.',
  'shell.folders.notTested': 'Not tested yet',
  'shell.folders.alignmentsEmpty': 'Empty - new alignments will be saved here',
  'shell.folders.alignmentsSaved':
    '{n, plural, one {# saved alignment here} other {# saved alignments here}}',
  'shell.folders.noBooks': 'No books found in this folder',
  'shell.folders.filesFound':
    '{n, plural, one {# {kind, select, ebook {EPUB} other {audio}} file found} other {# {kind, select, ebook {EPUB} other {audio}} files found}}',
  'shell.folders.filesFoundSampled': '{n}+ {kind, select, ebook {EPUB} other {audio}} files found',
  'shell.folders.remove': 'Remove {path}',
  'shell.folders.addFolder':
    '{kind, select, ebook {Add ebook folder} audio {Add audiobook folder} other {Add alignment folder}}',
  'shell.folders.browse': 'Browse…',
  'shell.folders.testing': 'Testing…',
  'shell.folders.testAgain': 'Test again',
  // The folder picker
  'shell.folders.listFailed': 'Could not list that folder.',
  'shell.folders.pickerTitle': 'Choose a folder',
  'shell.folders.upOneLevel': 'Up one level',
  'shell.folders.commonLocations': 'Common locations',
  'shell.folders.mounted': 'mounted',
  'shell.folders.mountedHint':
    'marks a folder your container config maps in from the host. Only those, and what is inside them, exist for this server.',
  'shell.folders.noSubfolders': 'No sub-folders here.',
  'shell.folders.mountedInside': '{n, plural, one {# mounted inside} other {# mounted inside}}',
  'shell.folders.useThisFolder': 'Use this folder',

  // Processing queue: job types and states (keys are the server's own ids)
  'shell.jobType.align': 'Align to the text',
  'shell.jobType.model-download': 'Model download',
  'shell.jobType.scan': 'Library scan',
  'shell.jobType.index-ebook': 'Index ebook',
  'shell.jobType.index-audio': 'Index audiobook',
  'shell.jobType.pair-scan': 'Look for pairs',
  'shell.jobType.language-backfill': 'Read book languages',
  'shell.jobState.queued': 'Queued',
  'shell.jobState.running': 'Running',
  'shell.jobState.done': 'Finished',
  'shell.jobState.failed': 'Failed',
  'shell.jobState.cancelled': 'Cancelled',
  'shell.queue.label': 'Processing queue',
  'shell.queue.heading': 'Processing',
  'shell.queue.running': '{n, plural, one {# running} other {# running}}',
  'shell.queue.waiting': '{n, plural, one {# waiting} other {# waiting}}',
  'shell.queue.idleLede':
    'Nothing is being processed right now. Confirming a pair or downloading a model adds work here.',
  'shell.queue.busyLede':
    'Three lanes run side by side: one alignment, one model download, one library task - so a long alignment never blocks a scan.',
  'shell.queue.waitingList': 'Waiting',
  'shell.queue.showRecent': 'Show recent results ({n})',
  'shell.queue.hideRecent': 'Hide recent results ({n})',
  'shell.queue.cancelled': 'Job cancelled',
  'shell.queue.retried': 'Job queued again',
  'shell.queue.actionFailed': 'Action failed',
  // One job's row
  'shell.job.starting': 'Starting…',
  'shell.job.runningFor': 'running {spent}',
  'shell.job.elapsedSeconds': '{n}s',
  'shell.job.elapsedMinutes': '{m}m',
  'shell.job.elapsedHoursMinutes': '{h}h {m}m',
  'shell.job.waitingForLane':
    '{lane, select, alignment {Waiting for the alignment lane} download {Waiting for the download lane} other {Waiting for the library lane}}',
  'shell.job.cancel': 'Cancel job',
  'shell.job.getModel': 'Get model',

  // The alignment pipeline diagram
  'shell.pipeline.audiobookBody':
    'Each part is decoded to plain 16 kHz mono audio with ffmpeg. Your files are only read, never changed.',
  'shell.pipeline.listeningTitle': 'Listening',
  'shell.pipeline.listeningBody':
    'An acoustic model hears the narration and reports which sound it is hearing, twenty milliseconds at a time. It never decides which words were said - that is what makes it fast, and the same model works for every language.',
  'shell.pipeline.tagAcousticModel': 'acoustic model',
  'shell.pipeline.tagAlignerInstalled': 'aligner installed · 20 ms frames',
  'shell.pipeline.tagAlignerMissing': 'aligner not installed',
  'shell.pipeline.textTitle': 'Ebook text',
  'shell.pipeline.textBody':
    'The EPUB is split into sentences and reduced to the same small alphabet the model reports in, so the book and the narration can be compared letter for letter.',
  'shell.pipeline.tagLetters': '27 letters',
  'shell.pipeline.pinningTitle': 'Pinning',
  'shell.pipeline.pinningBody':
    'Passages that occur exactly once on each side pin text to audio, and only pins that keep their order are kept. Timings between two pins are interpolated; where nothing matches, the pair keeps an honest gap instead of a guess.',
  'shell.pipeline.tagPins': 'unique passages, in order',
  'shell.pipeline.mapTitle': 'Switching map',
  'shell.pipeline.mapBody':
    'Every pinned or interpolated sentence knows its second in the audio, and every second knows its sentence - that is what the switch between reading and listening lands on.',
  'shell.pipeline.tagMap': 'sentence ↔ second',
  'shell.pipeline.footSetup': 'One model covers every language - set it up in',
  'shell.pipeline.footSettingsLink': 'Settings → Models',
  'shell.pipeline.footDetail':
    'Step 2 is the expensive part, about a minute of computing per hour of audio - it samples the narration rather than listening to every second - which is why it runs one book at a time and reports live progress above. How many pins turn up is also the edition check: a narration that is not this text produces almost none, and {appName} refuses to publish timings rather than inventing them.',

  // The launcher for the other apps in this household.
  'shell.apps.heading': 'Apps',
  'shell.apps.open': 'Open {name}',
} as const;
