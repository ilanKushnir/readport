/**
 * Strings of the auth surface: the sign-in card, the invitation-code
 * entry beneath it, the page an invitation link lands on, and the first-run
 * setup wizard. Keys are `auth.*`.
 */
export const auth = {
  // Sign-in card
  'auth.login.title': 'Welcome back',
  'auth.login.lede': 'Sign in to your ReadPort server.',
  'auth.login.submit': 'Sign in',
  'auth.login.pleaseWait': 'Please wait…',
  'auth.login.tooManyAttempts': 'Too many attempts. Try again in a few minutes.',
  'auth.login.wrongCredentials': 'Wrong username or password.',
  'auth.login.failed': 'Sign-in failed. Is the server reachable?',

  // Account fields shared by sign-in, join and the wizard's admin step
  'auth.form.username': 'Username',
  'auth.form.password': 'Password',
  'auth.form.confirmPassword': 'Confirm password',
  'auth.form.displayName': 'Display name',
  'auth.form.optional': 'Optional',
  'auth.form.passwordHint': 'At least 10 characters.',
  'auth.form.passwordsMismatch': 'Passwords do not match.',

  // "I was given a code", tucked under the sign-in form
  'auth.invite.haveCode': 'I have an invitation code',
  'auth.invite.codeLabel': 'Invitation code',
  // An example of the code's shape; the alphabet is fixed ASCII.
  'auth.invite.codePlaceholder': 'ABCD-EFGH-JKMN',
  'auth.invite.codeHint': 'Twelve characters, in three groups. Case does not matter.',

  // Accepting an invitation link
  'auth.join.checking': 'Checking your invitation…',
  'auth.join.unreachableTitle': 'Could not check this invitation',
  'auth.join.unreachableLede':
    'The server did not answer. Your link is probably fine - try again in a moment.',
  'auth.join.expiredTitle': 'This link has expired',
  'auth.join.expiredLede':
    'Invitations are single-use and time-limited. Ask whoever invited you for a fresh link.',
  'auth.join.title': "You're invited",
  'auth.join.invitedBy':
    '{name} invited you to join as {role, select, admin {an admin} curator {a curator} reader {a reader} other {a member}}.',
  'auth.join.invited':
    'You have been invited to join as {role, select, admin {an admin} curator {a curator} reader {a reader} other {a member}}.',
  'auth.join.roleBlurb.admin': 'Everything: users, libraries, models, server settings.',
  'auth.join.roleBlurb.curator':
    'Confirms and dismisses pairs, starts alignments, watches the queue.',
  'auth.join.roleBlurb.reader': 'Reads and listens; own progress, bookmarks and downloads.',
  'auth.join.usernameTaken': 'That username is taken - pick another.',
  'auth.join.inviteInvalid': 'This invitation is no longer valid.',
  'auth.join.createFailed': 'Could not create the account. Is the server reachable?',
  'auth.join.creating': 'Creating…',
  'auth.join.submit': 'Create my account',

  // Setup wizard: the step strip and errors shared by every step
  'auth.setup.stepsLabel': 'Setup steps',
  'auth.setup.steps.welcome': 'Welcome',
  'auth.setup.steps.admin': 'Admin',
  'auth.setup.steps.books': 'Books',
  'auth.setup.steps.ready': 'Ready',
  'auth.setup.unreachable': 'Could not reach the server.',
  'auth.setup.checking': 'Checking…',

  // Welcome step
  'auth.setup.welcome.title': 'Welcome to your reading room',
  'auth.setup.welcome.lede':
    'ReadPort reads the ebook and audiobook folders you already have, never changes them, and lets you switch between reading and listening at the exact sentence. Everything runs on this server: no cloud account, no upload. Setup takes about three minutes.',
  'auth.setup.welcome.tokenLabel': 'Setup token',
  'auth.setup.welcome.tokenHint':
    'This server was started with RP_SETUP_TOKEN set, so setup asks for it.',
  'auth.setup.welcome.getStarted': 'Get started',
  'auth.setup.welcome.badToken': 'That token does not match the one in the server log.',
  'auth.setup.welcome.tooManyAttempts': 'Too many attempts - wait a few minutes.',
  'auth.setup.welcome.verifyFailed': 'Could not verify the token. Is the server reachable?',

  // Admin account step
  'auth.setup.admin.title': 'Your admin account',
  'auth.setup.admin.lede':
    'The first account runs the server: it adds people and chooses the folders. You can add readers and curators later.',
  'auth.setup.admin.confirm': 'Confirm',

  // Books step: folders, public address, language
  'auth.setup.books.title': 'Where are your books?',
  'auth.setup.books.lede':
    'Point ReadPort at the folders that hold your EPUBs and audiobooks, as the server sees them. Calibre, Audiobookshelf and plain folders all work. Test each one before moving on.',
  'auth.setup.books.ebookFolders': 'Ebook folders',
  'auth.setup.books.audiobookFolders': 'Audiobook folders',
  'auth.setup.books.alignmentFolder': 'Alignment folder',
  'auth.setup.books.alignmentHint':
    'Finished alignments are saved here, and this is the only folder ReadPort writes to. Leave it empty to keep them inside the app’s data volume, where rebuilding the container loses them.',
  'auth.setup.books.pinnedByEnv': 'Set by {name} on the server; change it there.',
  'auth.setup.books.publicUrlLabel': 'Address friends will use',
  'auth.setup.books.publicUrlHint':
    'Optional, and only needed if you invite people. An invitation link is built from this, so it works for whoever you send it to rather than only on your own network. You can set it later under Settings.',
  'auth.setup.books.languageLabel': 'Most of my books are in',
  'auth.setup.books.languageHint': 'Only used when a book doesn’t say.',
  'auth.setup.books.skip': 'Skip for now',

  // Ready step: the review, the model choice, the server check
  'auth.setup.ready.title': 'Ready to go',
  'auth.setup.ready.lede': 'Here is what will be set up. Nothing has been written yet.',
  'auth.setup.ready.language': 'Language',
  'auth.setup.ready.noneYet': 'None yet',
  'auth.setup.ready.inAppVolume': 'Inside the app data volume',
  'auth.setup.ready.alignerInstalled': 'The alignment model is already on this server.',
  'auth.setup.ready.alignerDownloading': 'The alignment model is downloading - {pct}.',
  'auth.setup.ready.downloadAligner': 'Download the alignment model when I finish ({size})',
  'auth.setup.ready.alignerLicence': 'Licensed for personal use, not for a paid service.',
  'auth.setup.ready.lastDownloadFailed': 'The last download attempt failed: {error}',
  'auth.setup.ready.importSaved': 'Use alignments already in that folder',
  'auth.setup.ready.importSavedHint':
    'On: any alignments a previous install left there are adopted, and those books are not timed again. Off: every book is timed from its audio, and the existing files are left where they are rather than deleted.',
  'auth.setup.ready.autoAlign': 'Align new matches automatically',
  'auth.setup.ready.autoAlignHint': 'Off means nothing runs until you press Start on a book.',
  'auth.setup.ready.serverCheck': 'Server check',
  'auth.setup.ready.runAgain': 'Run again',
  'auth.setup.ready.finish': 'Finish setup',
  'auth.setup.ready.settingUp': 'Setting up…',
  'auth.setup.ready.alreadyConfigured': 'This server was already set up - reload to sign in.',
  'auth.setup.ready.failed': 'Setup failed. Is the server reachable?',

  // Server self-check list (the check labels and details come from the server)
  'auth.setup.check.unavailable':
    'The server could not be checked from here. That does not block setup.',
  'auth.setup.check.passed': ': passed',
  'auth.setup.check.failed': ': failed',
  'auth.setup.check.warning': ': warning',

  // After Finish: the first scan and the model download, live
  'auth.setup.init.allSet': 'All set',
  'auth.setup.init.readingShelves': 'Reading your shelves',
  'auth.setup.init.noFolders': 'No folders yet - add them any time under Settings → Libraries.',
  'auth.setup.init.doneAligning':
    '{books, plural, one {# title is in.} other {# titles are in.}} {n, plural, one {# book is being timed} other {# books are being timed}} against their audio in the background - that takes a few minutes each, and reading and listening work now regardless.',
  'auth.setup.init.donePairing':
    '{books, plural, one {# title is in.} other {# titles are in.}} Pairing suggestions appear once indexing settles; confirm them on the Pairing page.',
  'auth.setup.init.scanning':
    'Scanning folders and indexing what they hold. {books, plural, one {# title} other {# titles}} so far{indexing, plural, =0 {} other {, # being indexed}}. You can go in now - it keeps running.',
  'auth.setup.init.downloadNotStarted':
    'The download could not be started. Fetch the model under Settings → Alignment - everything else is set up.',
  'auth.setup.init.alignerHeading': 'Alignment model',
  'auth.setup.init.alignerInstalled': 'Installed - your books can be aligned now.',
  'auth.setup.init.queued': 'Queued…',
  'auth.setup.init.starting': 'Starting…',
  'auth.setup.init.downloading': '{status} - it keeps downloading while you use ReadPort.',
  'auth.setup.init.downloadFailed': 'Download failed: {error}. Retry under Settings → Alignment.',
  'auth.setup.init.queuedWatch': 'Queued - watch it under Settings → Alignment.',
  'auth.setup.init.inviteSomeone': 'Invite someone',
  'auth.setup.init.openLibrary': 'Open the library',
} as const;
