/**
 * The same book in other languages: the row on the book page that names
 * them, the sheet a curator links them in, carrying on in another language
 * from the reader and the player, the passage shown in another language,
 * and friends reading a translation.
 *
 * `{language}` is always a language's name in the interface's own language
 * ("Russian", "Russe", "Русский" to a reader of each).
 */
export const translations = {
  // The book page
  'translations.rowLabel': 'This book in other languages',
  'translations.alsoIn': 'Also in',
  'translations.chip': '{language}: {title}',
  'translations.chipProgress': '{language}: {title}, {pct} read',
  'translations.chipFinished': '{language}: {title}, finished',
  'translations.tool': 'Languages',
  'translations.toolHint': 'Link this book to its editions in other languages',

  // The sheet a curator links them in
  'translations.sheet.title': 'Other languages',
  'translations.sheet.lede':
    'Link the editions of this book in other languages. Everyone sees them on the book page, friends reading one appear in the other, and a reader can carry on in either from the same paragraph.',
  'translations.sheet.linked': 'Linked',
  'translations.sheet.suggested': 'Looks like this book',
  'translations.sheet.find': 'Find the edition',
  'translations.sheet.search': 'Title or author',
  'translations.sheet.searching': 'Searching…',
  'translations.sheet.noResults': 'No book in another language matches.',
  'translations.sheet.sameLanguage': 'Same language',
  'translations.sheet.link': 'Link',
  'translations.sheet.linking': 'Linking…',
  'translations.sheet.notThis': 'Not this one',
  'translations.sheet.unlink': 'Unlink',
  'translations.sheet.unlinkYes': 'Yes, unlink',
  'translations.sheet.keep': 'Keep',

  // How closely two editions' texts line up
  'translations.match.close': 'Matched paragraph by paragraph',
  'translations.match.rough': 'Matched loosely: an abridged or rearranged edition',
  'translations.match.pending': 'Matching paragraphs…',
  'translations.match.none': 'No text to match, so places carry by how far through',

  // Why a book looks like a translation
  'translations.evidence.author': 'Same author',
  'translations.evidence.series': 'Same place in the series',
  'translations.evidence.length': 'The right length',
  'translations.evidence.chapters': 'Same chapters',

  'translations.toast.linked': 'Linked the {language} edition',
  'translations.toast.unlinked': 'Unlinked the {language} edition',
  'translations.toast.dismissed': 'It will not be suggested again',
  'translations.toast.failed': 'Could not change the link. Try again.',
  'translations.error.sameLanguage':
    'That book is in the same language. An ebook and its audiobook are paired, not linked.',
  'translations.error.sameTitle': 'That is this book in its other format: they are paired already.',

  // Carrying on in another language, from the reader or the player
  'translations.continue.title': 'Other languages',
  'translations.continue.read': 'Read from here',
  'translations.continue.listen': 'Listen from here',
  'translations.continue.readIn': 'Read in {language} from here',
  'translations.continue.listenIn': 'Listen in {language} from here',
  'translations.continue.paragraph': 'Opens at the same paragraph.',
  'translations.continue.pending':
    'Opens at about the same place: the paragraphs are still being matched.',
  'translations.continue.approximate': 'Opens at about the same place.',
  'translations.continue.peek': 'See this passage in {language}',
  'translations.continue.opening': 'Opening…',
  'translations.continue.offline': 'Carrying on in another language needs a connection.',
  'translations.continue.failed': 'Could not open the {language} edition.',
  'translations.handoff.from': 'Continuing from the same paragraph of the {language} edition',
  'translations.handoff.near': 'Continuing near where you were in the {language} edition',

  // A passage in another language, from the text selected
  'translations.peek.toolbar': 'Languages',
  'translations.peek.showIn': 'Show in {language}',
  'translations.peek.title': 'In {language}',
  'translations.peek.loading': 'Finding the passage…',
  'translations.peek.notMatched':
    'The two editions are still being matched paragraph by paragraph. Try again in a minute.',
  'translations.peek.approximate': 'About here: this passage has no exact counterpart.',
  'translations.peek.continue': 'Continue in {language} from here',
  'translations.peek.failed': 'Could not find the passage.',

  // Friends reading a translation
  'translations.friends.in': 'in {language}',
  'translations.friends.reading': 'Reading it in {language}: {title}',
  'translations.friends.bead': '{name}, {pct}, in {language}',

  // Recommending a book that is in more than one language
  'translations.recommend.edition': 'Language',
  'translations.recommend.readsIn': '{name} reads in {language}',

  // The pairing page: every guess in the library
  'translations.review.title': 'Same book, other languages',
  'translations.review.lede':
    'These look like one book in two languages. Linked, friends reading either appear in the other, and a reader can carry on from one to the other at the same paragraph.',
} as const;
