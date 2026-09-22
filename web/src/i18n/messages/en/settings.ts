/** Strings of the settings surface, in the order the page shows them; keys are `settings.*`. */
export const settings = {
  // Page head, and the page when the server cannot be reached
  'settings.lede': 'Everything this server is doing, and everything you can change about it.',
  'settings.serverUnreachable':
    'Could not reach the server, so server settings are unavailable. Downloaded books still work.',
  'settings.saved': 'Settings saved',
  'settings.couldNotSave': 'Could not save those settings.',

  // Overview cards
  'settings.overview.label': 'Overview',
  'settings.overview.titles': 'titles',
  'settings.overview.stillIndexing': '{n} still indexing',
  'settings.overview.libraryBreakdown':
    '{ebooks, plural, one {# ebook} other {# ebooks}} · {audiobooks, plural, one {# audiobook} other {# audiobooks}}',
  'settings.overview.pairs': 'Pairs',
  'settings.overview.linked': 'linked',
  'settings.overview.awaitingReview': '{n} awaiting review',
  'settings.overview.aligned': '{n} aligned',
  'settings.overview.processing': 'Processing',
  'settings.overview.running': 'running',
  'settings.overview.idle': 'idle',
  'settings.overview.waiting': '{n} waiting',
  'settings.overview.failed': '{n} failed',
  'settings.overview.aligningNewMatches': 'Aligning new matches',
  'settings.overview.manual': 'Manual',
  'settings.overview.ready': 'Ready',
  'settings.overview.setUp': 'Set up',
  'settings.overview.toAlign': 'to align',
  'settings.overview.needed': 'needed',
  'settings.overview.unavailable': 'Unavailable',
  'settings.overview.modelInstalled': 'Model installed',
  'settings.overview.modelNotInstalled': 'Model not installed yet',
  'settings.overview.people': 'People',
  'settings.overview.accounts': '{n, plural, one {account} other {accounts}}',
  'settings.overview.rolesAndInvitations': 'Roles and invitations',
  'settings.overview.offline': 'Offline',
  'settings.overview.onThisDevice': 'on this device',
  'settings.overview.ofAbout': 'of about {quota}',
  'settings.overview.notReported': 'Not reported',

  // Libraries: the folders, and the alignment store beside them
  'settings.libraries.title': 'Libraries',
  'settings.libraries.lede':
    'Your book folders are only ever read. New titles are picked up by the periodic rescan, or right away with the button below.',
  'settings.libraries.ebookFolders': 'Ebook folders',
  'settings.libraries.audiobookFolders': 'Audiobook folders',
  'settings.libraries.alignmentFolder': 'Alignment folder',
  'settings.libraries.notConfigured': 'Not configured',
  'settings.libraries.rescanNow': 'Rescan libraries now',
  'settings.libraries.rescanQueued': 'Rescan queued',
  'settings.libraries.rescanFailed': 'Rescan failed',
  'settings.libraries.pinnedBy': 'Pinned by {name} on the server.',
  'settings.libraries.alignmentFolderLede':
    'Where the timings are saved once a book has been lined up, so they survive rebuilding the container. This is the only folder {app} writes to - mount it read-write. Without one, the timings live in the app’s own data and a rebuild takes them with it.',
  'settings.libraries.nothingSavedYet': 'Nothing saved yet.',
  'settings.libraries.savedCount': '{n} saved · {size}',
  'settings.libraries.useExisting': 'Use alignments already in this folder',
  'settings.libraries.useExistingOnHint':
    '{n, plural, one {On, the one saved here is adopted after a scan and that book is not timed again.} other {On, the # saved here are adopted after a scan and those books are not timed again.}}',
  'settings.libraries.useExistingHint':
    'Applies after a scan finds files here - typically the first scan of a rebuilt container.',
  'settings.libraries.exportAll': 'Save all alignments to this folder',
  'settings.libraries.importExisting': 'Import what is already there',
  'settings.libraries.importStarted': 'Looking for saved alignments',
  'settings.libraries.exportStarted': 'Saving alignments',
  'settings.libraries.couldNotStart': 'Could not start that.',
  'settings.libraries.couldNotSaveThat': 'Could not save that.',
  'settings.libraries.saveAndRescan': 'Save folders & rescan',
  'settings.libraries.foldersSaved': 'Folders saved - rescanning',
  'settings.libraries.couldNotSaveFolders': 'Could not save folders',

  // Appearance (the interface-language picker uses the shared `language.*` keys)
  'settings.appearance.title': 'Appearance',
  'settings.appearance.appTheme': 'App theme',
  'settings.appearance.theme':
    '{theme, select, auto {Match system} light {Light} dark {Dark} other {{theme}}}',
  'settings.appearance.readerThemeHint':
    'Reader pages have their own theme, set inside the reader.',

  // Alignment engine
  'settings.alignment.title': 'Alignment',
  'settings.alignment.lede':
    'Lining a book up with its audiobook is what lets you switch between reading and listening at the same place. It happens once per book, here on this server - no audio, text or metadata ever leaves it.',
  'settings.alignment.download': 'Download',
  'settings.alignment.couldNotStartDownload': 'Could not start the download.',
  'settings.alignment.removed': 'Removed',
  'settings.alignment.couldNotRemove': 'Could not remove it.',
  'settings.alignment.licenceNote':
    'Fine for your own library, not for a paid service. Everything else in {app} is AGPL-3.0.',
  'settings.alignment.catalogOutOfDate': 'This server’s catalog is out of date - update {app}.',
  'settings.alignment.runtimeMissing':
    'The model is installed but its runtime did not load, so nothing can be aligned. The Docker image includes it; on other installs see docs/self-hosting.md.',
  'settings.alignment.whenItRuns': 'When it runs',
  'settings.alignment.autoAlign': 'Align new matches automatically',
  'settings.alignment.autoAlignTimed':
    'About {span} for a six-hour audiobook on this server. One book at a time.',
  'settings.alignment.autoAlignHint':
    'One book at a time, in the background. Off means nothing runs until you press Start on a book.',
  'settings.alignment.precisionTitle': 'How closely it listens',
  'settings.alignment.precision.standard': 'Standard',
  'settings.alignment.precision.standardBlurb':
    'A few minutes for a six-hour audiobook. Switching lands on the right paragraph.',
  'settings.alignment.precision.exact': 'Sentence-perfect',
  'settings.alignment.precision.exactBlurb':
    'Hours per book instead of minutes. Worth it only if you follow the narration word by word on the page.',
  'settings.alignment.behindNote':
    'Switching from reading to listening always lands a little behind where you were, never ahead - so a switch never plays you a sentence you have not read yet.',
  'settings.alignment.languageTitle': 'Language',
  'settings.alignment.fallbackLanguage': 'Fallback language',
  'settings.alignment.pinnedTag': '(env)',
  'settings.alignment.fallbackHint':
    'Used only when a book says nothing about its own language and its text is not enough to tell. Any single book can be overridden on the Pairing page.',
  'settings.alignment.saveChanges': 'Save changes',

  // The model card
  'settings.model.installed': 'Installed',
  'settings.model.downloading': 'Downloading',
  'settings.model.notInstalled': 'Not installed',
  'settings.model.licence': 'Licence: {licence}.',
  'settings.model.queued': 'Queued…',
  'settings.model.starting': 'Starting…',
  'settings.model.onDisk': '{size} on disk',
  'settings.model.downloadSize': '{size} download',
  'settings.model.lastAttemptFailed': 'Last attempt failed',
  'settings.model.retryDownload': 'Retry download',

  // Offline storage
  'settings.offline.title': 'Offline storage',
  'settings.offline.usage':
    'This browser is using {usage} of about {quota} available for offline books.',
  'settings.offline.notReported': 'Storage usage is not reported by this browser.',
  'settings.offline.perTitle':
    'Downloads are per-title and explicit - manage them from each book page.',

  // Background activity (job types are the server's real names; see server/src/jobs/handlers.ts)
  'settings.jobs.title': 'Background activity',
  'settings.jobs.none': 'No background jobs yet.',
  'settings.jobs.type':
    '{type, select, align {Align to the text} model-download {Model download} scan {Library scan} index-ebook {Index ebook} index-audio {Index audiobook} pair-scan {Look for pairs} other {{type}}}',
  'settings.jobs.state':
    '{state, select, done {Finished} failed {Failed} cancelled {Cancelled} running {Running} other {Queued}}',

  // Account
  'settings.account.title': 'Account',
  'settings.account.signedInAs': 'Signed in as',
  'settings.account.role':
    '{role, select, admin {Admin} curator {Curator} reader {Reader} other {{role}}}',
  'settings.account.roleLine':
    '{via, select, proxy {{role}, through your identity provider.} other {{role}.}}',
  'settings.account.proxySignOut':
    'Sign-in is handled by the reverse proxy in front of {app}; sign out from there.',
  'settings.account.signOut': 'Sign out',
  'settings.account.displayName': 'Display name',
  'settings.account.nameSaved': 'Name saved',
  'settings.account.couldNotSave': 'Could not save',
  'settings.account.changePassword': 'Change password',
  'settings.account.addPassword': 'Add a password',
  'settings.account.currentPassword': 'Current',
  'settings.account.newPasswordPlaceholder': 'New (10+ chars)',
  'settings.account.passwordPlaceholder': 'Password (10+ chars)',
  'settings.account.newPassword': 'New password',
  'settings.account.password': 'Password',
  'settings.account.change': 'Change',
  'settings.account.set': 'Set',
  'settings.account.otherDevicesHint': 'Other devices are signed out; this one stays in.',
  'settings.account.proxyPasswordHint':
    'You sign in through your identity provider, so this account has no password of its own. Adding one is a way back in if the provider is ever unavailable - and what you would use if the app is opened up beyond it.',
  'settings.account.noPasswordHint': 'This account has no password yet.',
  'settings.account.passwordChangedRevoked':
    'Password changed - signed out of {n, plural, one {# other device} other {# other devices}}',
  'settings.account.passwordChanged': 'Password changed',
  'settings.account.passwordSet':
    'Password set - you can now sign in without your identity provider',
  'settings.account.wrongCurrentPassword': 'Current password is wrong',
  'settings.account.couldNotChangePassword': 'Could not change the password',

  // Sharing: the public address
  'settings.sharing.title': 'Sharing',
  'settings.sharing.lede':
    'Where people reach this library from outside your network. Invitation links are built from it, so it is what makes an invitation work for the person you send it to.',
  'settings.sharing.publicAddress': 'Public address',
  'settings.sharing.emptyHint':
    'Empty is fine for a library only you use: invitation links will use whatever address you are on.',
  'settings.sharing.localHint':
    'That address only works on your own network, so an invitation built from it will not open for anyone else.',
  'settings.sharing.usedHint': 'Invitation links will use this address.',

  // Agent access keys
  'settings.keys.title': 'Agent access',
  'settings.keys.lede':
    'A key lets something else - an assistant, a script - see your library, your lists and how far through you are. It can only ever read: it cannot change anything, and it cannot download the books themselves.',
  'settings.keys.defaultName': 'Agent',
  'settings.keys.couldNotCreate': 'Could not create the key.',
  'settings.keys.copyNow': 'Copy this now.',
  'settings.keys.notShownAgain': 'It is not shown again.',
  'settings.keys.copy': 'Copy',
  'settings.keys.copied': 'Key copied',
  'settings.keys.copyFailed': 'Could not copy - select it by hand',
  'settings.keys.lastUsed': 'last used {when}',
  'settings.keys.neverUsed': 'never used',
  'settings.keys.revoke': 'Revoke',
  'settings.keys.revoked': 'Key revoked',
  'settings.keys.couldNotRevoke': 'Could not revoke it.',
  'settings.keys.namePlaceholder': 'What is it for? e.g. Claude Code',
  'settings.keys.creating': 'Creating…',
  'settings.keys.newKey': 'New key',

  // Connected apps
  'settings.apps.title': 'Connected apps',
  'settings.apps.lede':
    'The other apps beside this library. Their addresses appear as tiles at the foot of the shelves, for everyone on this server.',
  'settings.apps.empty': 'No apps yet. Add the ones this library sits beside.',
  'settings.apps.add': 'Add an app',
  'settings.apps.kind': 'App',
  'settings.apps.name': 'Name',
  'settings.apps.url': 'Address',
  'settings.apps.urlPlaceholder': 'https://books.example.com',
  'settings.apps.remove': 'Remove {name}',
  'settings.apps.custom': 'Something else',
  'settings.apps.smart': 'Smart integration',
  'settings.apps.smartHint':
    'Reading this app through its own API - shared progress, one-click sends, the lot. Not built yet; the address is a link for now.',
  'settings.apps.soon': 'Coming soon',
  'settings.apps.saved': 'Apps saved.',
  'settings.apps.invalidUrl': 'That address needs to start with http:// or https://.',
} as const;
