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
} as const;
