/**
 * Strings of the sharing surface: the Share sheet on the book page, the
 * share page a link lands on (signed in, and not), the ask-to-join flow on
 * it, and the "recommended by" line on the reading list. Keys are `share.*`.
 */
export const share = {
  // The Share menu on the book page
  'share.button': 'Share',
  'share.sheet.lede':
    'Anyone with the link sees the cover, the title and your name, and can ask to join this library.',
  'share.sheet.copy': 'Copy link',
  'share.sheet.copied': 'Link copied',
  'share.sheet.copyFailed': 'Select and copy the link',
  'share.sheet.native': 'Share…',
  'share.sheet.text': '{name} shared {title} with you on ReadPort',
  'share.sheet.creating': 'Making the link…',
  'share.sheet.failed': 'Could not make a link just now.',
  'share.menu.whatsapp': 'Send on WhatsApp',
  'share.menu.withdraw': 'Withdraw the link',
  'share.menu.withdrawn': 'Link withdrawn',

  // The share page
  'share.page.checking': 'Checking the link…',
  'share.page.invalidTitle': 'This share link is no longer valid',
  'share.page.invalidLede': 'It may have been withdrawn, or the book has left the library.',
  'share.page.openLibrary': 'Open the library',
  'share.page.unreachableTitle': 'Could not check this link',
  'share.page.unreachableLede': 'The server did not answer. Try again in a moment.',
  'share.page.sharedWithYou': '{name} shared this book with you',
  'share.page.sharedTeaser': '{name} shared this with you on ReadPort',
  'share.page.addToList': 'Add to reading list',
  'share.page.onList': 'On your reading list',
  'share.page.added': 'Added to your reading list',
  'share.page.addFailed': 'Could not add it just now.',
  'share.page.openBook': 'Open book',
  'share.page.haveAccount': 'I have an account',
  'share.page.askToJoin': 'Ask to join',
  'share.page.signInLede': 'Sign in, and the book is one tap away.',
  'share.page.coverAlt': 'Cover of {title}',

  // Asking to join
  'share.join.lede':
    'Leave your email and an admin will let you in. Come back to this link afterwards.',
  'share.join.email': 'Email',
  'share.join.name': 'Your name',
  'share.join.message': 'A line to the admin',
  'share.join.messagePlaceholder': 'Optional - who you are, how you know them',
  'share.join.send': 'Send request',
  'share.join.sending': 'Sending…',
  'share.join.failed': 'Could not send the request. Is the server reachable?',
  'share.join.tooMany': 'Too many requests from here - try again later.',
  'share.join.pendingTitle': 'Request sent',
  'share.join.pendingBody': 'An admin has to approve it; come back to this link afterwards.',
  'share.join.pendingAs': 'Asked as {email}',
  'share.join.notYou': 'Not you? Ask with a different address',
  'share.join.declinedTitle': 'Not this time',
  'share.join.declinedBody':
    'This request was not approved. If that seems wrong, ask the person who shared the link with you.',
  'share.join.approvedTitle': "You're in",
  'share.join.approvedLede':
    'Pick a username and a password, and the book will be waiting on your reading list.',
  'share.join.approvedUsedTitle': 'Your account is ready',
  'share.join.approvedUsedBody':
    'This request was approved and the account created. Sign in to open the book.',
  'share.join.inviteLapsed': 'This invitation has lapsed. Ask to join again.',

  // The reading list
  'share.recommendedBy': 'Recommended by {name}',
} as const;
