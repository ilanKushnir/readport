/** Strings of the notes surface, in the order the page shows them; keys are `notes.*`. */
export const notes = {
  // Page head
  'notes.title': 'Notes & marks',
  'notes.emptyLede': 'Nothing marked yet.',
  'notes.counts':
    '{note, plural, one {# note} other {# notes}} · {highlight, plural, one {# highlight} other {# highlights}} · {bookmark, plural, one {# bookmark} other {# bookmarks}}',

  // Search and filters
  'notes.searchPlaceholder': 'Search your notes, quotes and books',
  'notes.searchLabel': 'Search your marks',
  'notes.kind': 'Kind',
  // "All", not "Everything": four labels have to share a phone's width, and
  // this is the word the library filter already uses for the same idea.
  'notes.filter.all': 'All',
  'notes.filter.notes': 'Notes',
  'notes.filter.highlights': 'Highlights',
  'notes.filter.bookmarks': 'Bookmarks',
  'notes.highlightColour': 'Highlight colour',
  'notes.onlyColour':
    '{color, select, amber {Only amber highlights} rose {Only rose highlights} plum {Only plum highlights} sky {Only sky highlights} sand {Only sand highlights} other {Only {color} highlights}}',

  // Empty states
  'notes.emptyTitle': 'Nothing marked yet',
  'notes.emptyBody':
    'Select a passage while reading to highlight it or write a note, and tap the ribbon to bookmark a page. Everything you mark lands here.',
  'notes.openLibrary': 'Open the library',
  'notes.noMatch': 'Nothing matches that.',

  // Cards
  'notes.openIn':
    '{kind, select, note {Open note in {title}} highlight {Open highlight in {title}} bookmark {Open bookmark in {title}} other {Open mark in {title}}}',
  'notes.bookmarkedPage': 'Bookmarked page',
  'notes.markedPassage': 'Marked passage',
  'notes.deleteFailed': 'Could not delete - are you offline?',
  'notes.openInBook': 'Open in book',
  // Where in the book a mark sits: the chapter, then how far in.
  'notes.where': '{chapter} · {pct}',

  // The books: the overview's default view, one card per book with marks
  'notes.books.label': 'Books with marks',
  'notes.book.highlights': '{n, plural, one {# highlight} other {# highlights}}',
  'notes.book.notes': '{n, plural, one {# note} other {# notes}}',
  'notes.book.bookmarks': '{n, plural, one {# bookmark} other {# bookmarks}}',
  'notes.book.lastMarked': 'Last marked {when}',
  'notes.book.colours': 'Colours used: {list}',
  'notes.results.count': '{n, plural, one {# mark matches} other {# marks match}}',

  // Colour names as they read inside a sentence; the reader's own labels
  // (reader.color.*) are capitalised for standing alone.
  'notes.colour.amber': 'amber',
  'notes.colour.rose': 'rose',
  'notes.colour.plum': 'plum',
  'notes.colour.sky': 'sky',
  'notes.colour.sand': 'sand',

  // One book's marks
  'notes.allBooks': 'All books',
  'notes.bookPage': 'Book page',
  'notes.bookLoadFailed': 'Could not load this book.',
  'notes.bookEmptyTitle': 'Nothing marked in this book yet',
  'notes.bookEmptyBody':
    'Select a passage while reading to highlight it or write a note, and tap the ribbon to bookmark a page.',
  'notes.readBook': '{kind, select, audio {Open the audiobook} other {Open the book}}',
  'notes.sort': 'Sort',
  'notes.sort.position': 'Position',
  'notes.sort.newest': 'Newest',
  'notes.sort.color': 'Colour',
  'notes.marksLabel': 'Marks',
  'notes.exportPdf': 'Export as PDF…',

  // The printed page
  'notes.export.documentTitle': '{title} – Highlights & notes',
  'notes.export.heading': 'Highlights & notes',
  // Followed by the date on the title page: "Exported from ReadPort · 22 Sept 2026".
  'notes.export.from': 'Exported from {app}',
  'notes.export.scope.kind':
    '{kind, select, highlight {Highlights only} note {Notes only} bookmark {Bookmarks only} other {Everything marked}}',
  'notes.export.scope.colours': 'Only highlights in {list}',
  'notes.export.print': 'Print / Save as PDF',
  'notes.export.back': 'Back to the marks',
  'notes.export.hint':
    'A preview of the pages as they will print. Print / Save as PDF opens the print sheet; choose “Save as PDF” as the destination to keep a file.',
  'notes.export.empty': 'Nothing to export with these filters.',
  'notes.export.options': 'Options…',

  // The export options sheet
  'notes.export.sheetTitle': 'Export highlights & notes',
  'notes.export.look': 'Look',
  'notes.export.look.paper': 'Paper',
  'notes.export.look.paperHint': 'Ink on white',
  'notes.export.look.night': 'Night',
  'notes.export.look.nightHint': 'Light type on dark pages',
  'notes.export.page': 'Page',
  'notes.export.page.a4': 'A4',
  'notes.export.page.a4Hint': '210 × 297 mm, the usual sheet outside North America.',
  'notes.export.page.letter': 'Letter',
  'notes.export.page.letterHint': '8½ × 11 in, the usual sheet in North America.',
  'notes.export.page.phone': 'Phone',
  'notes.export.page.phoneHint': 'A narrow page that reads at full width on a phone screen.',
  'notes.export.include': 'Include',
  'notes.export.include.cover': 'Cover on the title page',
  'notes.export.include.heads': 'Chapter headings',
  'notes.export.include.where': 'Position and date lines',
  'notes.export.include.notes': 'Notes under highlights',
  'notes.export.order': 'Order',
  'notes.export.textSize': 'Text size',
  'notes.export.text.compact': 'Compact',
  'notes.export.text.comfortable': 'Comfortable',
  'notes.export.text.large': 'Large',
  // One line saying what will come out: "12 highlights, 2 notes, 1 bookmark · only plum and sky".
  'notes.export.summary': '{counts} · {scope}',
  'notes.export.summary.colours': 'only {list}',
  'notes.export.nothing': 'Nothing to export - tick at least one kind of mark.',
  'notes.export.go': 'Export',
  'notes.export.apply': 'Apply',

  // The title page and the marks on the pages after it
  'notes.export.figures': 'What this export holds',
  'notes.export.figure.highlights': '{n, plural, one {highlight} other {highlights}}',
  'notes.export.figure.notes': '{n, plural, one {note} other {notes}}',
  'notes.export.figure.bookmarks': '{n, plural, one {bookmark} other {bookmarks}}',
  'notes.export.legend': 'Highlight colours',
  'notes.export.scope.kinds':
    '{kinds, select, hn {Highlights and notes} hb {Highlights and bookmarks} nb {Notes and bookmarks} other {Everything marked}}',
  'notes.export.bookmark': 'Bookmark',
  'notes.export.whereWhen': '{where} · {date}',
} as const;
