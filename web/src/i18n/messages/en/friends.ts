/**
 * Strings of the friends surface: the Friends page, its sheets, the row on
 * the book page, and every toast they raise. Keys are `friends.*`.
 */
export const friends = {
  // Page head
  'friends.title': 'Friends',
  'friends.lede':
    'Everyone here already shares the library. A friend can also see where you are in a book, and put one in front of you.',
  'friends.loadFailed': 'Could not load your friends - check the connection.',

  // A server with nobody else on it
  'friends.empty.title': 'Nobody else is here yet',
  'friends.empty.body':
    'Friends are other accounts on this server. An admin can add people under Settings → People.',
  'friends.empty.openPeople': 'Open People',

  // Recommended to you
  'friends.inbox.title': 'Recommended to you',
  'friends.inbox.empty': 'Nothing yet. When a friend puts a book in front of you, it lands here.',
  'friends.inbox.new': 'New',
  'friends.inbox.from': 'from {name}',
  'friends.inbox.openBook': 'Open book',
  'friends.inbox.addToList': 'Add to reading list',
  'friends.inbox.onList': 'On your reading list',
  'friends.inbox.added': 'Added to your reading list',
  'friends.inbox.addFailed': 'Could not add it just now.',
  'friends.inbox.dismiss': 'Dismiss {title}',
  'friends.inbox.dismissed': 'Recommendation dismissed',
  'friends.inbox.dismissFailed': 'Could not dismiss that just now.',

  // Friends
  'friends.list.title': 'Friends',
  'friends.list.empty': 'No friends yet. Everyone else on this server is listed below.',
  'friends.list.reading': '{kind, select, ebook {Reading} other {Listening to}} {title} · {pct}',
  'friends.list.notSharing': 'Not sharing progress',
  'friends.list.nothingOnTheGo': 'Nothing on the go',
  // Here right now: a position that moved within the last few minutes
  'friends.live.reading': 'Reading now',
  'friends.live.listening': 'Listening now',
  'friends.live.here': '{name} is in this book right now',
  'friends.list.recommend': 'Recommend a book…',
  'friends.list.remove': 'Remove',
  'friends.list.removeYes': 'Yes, remove {name}',
  'friends.list.keep': 'Keep',
  'friends.list.removed': '{name} is no longer a friend',
  'friends.list.removeFailed': 'Could not remove.',
  'friends.list.colourFor': 'Colour for {name}',
  'friends.list.colourName':
    '{colour, select, plum {Plum} sky {Sky} moss {Moss} rose {Rose} amber {Amber} sand {Sand} other {{colour}}}',
  'friends.list.colourFailed': 'Could not save the colour.',

  // Requests
  'friends.requests.title': 'Requests',
  'friends.requests.asked': 'Asked to be friends {when}',
  'friends.requests.youAsked': 'You asked {when}',
  'friends.requests.accept': 'Accept',
  'friends.requests.decline': 'Decline',
  'friends.requests.cancel': 'Cancel request',
  'friends.requests.nowFriends': 'You and {name} are now friends',
  'friends.requests.declined': 'Request declined',
  'friends.requests.cancelled': 'Request cancelled',
  'friends.requests.failed': 'That did not go through - check the connection.',

  // People on this server
  'friends.people.title': 'People on this server',
  'friends.people.add': 'Add friend',
  'friends.people.sent': 'Request sent to {name}',
  'friends.people.addFailed': 'Could not send the request.',

  // Sharing
  'friends.settings.title': 'Sharing',
  'friends.settings.share': 'Share my reading progress with friends',
  'friends.settings.shareHint':
    'Friends see which book you are in and how far along you are - never your notes, highlights or bookmarks.',
  'friends.settings.saveFailed': 'Could not save.',

  // The recommend sheet on the Friends page
  'friends.recommend.title': 'Recommend to {name}',
  'friends.recommend.search': 'Search the library',
  'friends.recommend.searchLabel': 'Find a book to recommend',
  'friends.recommend.noMatch': 'Nothing matches that.',
  'friends.recommend.moreHint': 'Showing the first {n} - type to narrow it down.',
  'friends.recommend.change': 'Change book',
  'friends.recommend.noteLabel': 'A line to go with it',
  'friends.recommend.notePlaceholder': 'Optional - why they might like it',
  'friends.recommend.send': 'Recommend',
  'friends.recommend.sending': 'Sending…',
  'friends.recommend.sent': 'Recommended {title} to {name}',
  'friends.recommend.already': 'You already recommended this to {name}.',
  'friends.recommend.failed': 'Could not send the recommendation.',

  // The row on the book page
  'friends.book.label': 'Friends',
  'friends.book.entry': '{name} · {pct}',
  'friends.book.entryChapter': '{name} · {pct} · {chapter}',
  'friends.book.entryFinished': '{name} · finished',
  'friends.book.recommend': 'Recommend to a friend',
  'friends.book.sheetTitle': 'Recommend {title}',
  'friends.book.to': 'To',
  'friends.book.noFriends': 'No friends to recommend it to yet.',
  'friends.book.openFriends': 'Open Friends',
} as const;
