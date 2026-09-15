/**
 * Strings of the people surface: Settings → People, its add / invite /
 * manage sheets, the server's error codes in words, and every toast it
 * raises. Keys are `people.*`.
 */
export const people = {
  // Page head
  'people.title': 'People',
  'people.lede':
    'Everyone keeps their own reading position, bookmarks and downloads. There is no open sign-up: add someone directly or send them a one-time link.',
  'people.adminsOnly': 'Only admins manage people.',
  'people.inviteByLink': 'Invite by link',
  'people.addPerson': 'Add person',
  // Roles: the legend and the picker
  'people.roles.label': 'Roles',
  'people.roles.admin.label': 'Admin',
  'people.roles.admin.blurb': 'Everything: users, libraries, models, server settings.',
  'people.roles.curator.label': 'Curator',
  'people.roles.curator.blurb':
    'Confirms and dismisses pairs, starts alignments, watches the queue.',
  'people.roles.reader.label': 'Reader',
  'people.roles.reader.blurb': 'Reads and listens; own progress, bookmarks and downloads.',
  // Accounts list
  'people.accounts.title': 'Accounts',
  'people.accounts.you': 'you',
  'people.accounts.disabled': 'Disabled',
  'people.accounts.proxySignIn': 'Proxy sign-in',
  'people.accounts.lastSeen': 'Last seen {when}',
  'people.accounts.booksInProgress': '{n, plural, one {# book} other {# books}} in progress',
  'people.accounts.devices': '{n, plural, one {# device} other {# devices}}',
  'people.accounts.manage': 'Manage',
  // Pending invitations
  'people.invites.title': 'Pending invitations',
  'people.invites.anyone': 'Anyone with the link',
  'people.invites.expires': 'Expires {date}',
  'people.invites.from': 'from {name}',
  'people.invites.revoke': 'Revoke',
  'people.invites.revoked': 'Invitation revoked',
  'people.invites.couldNotRevoke': 'Could not revoke',
  // Invitation link sheet
  'people.link.title': 'Invitation link',
  'people.link.shareOnce':
    'Share this once. It creates one {role, select, admin {admin} curator {curator} other {reader}} account and stops working after use or on {date}.',
  'people.link.codeLabel': 'Or read them this code',
  'people.link.codeHint':
    'They enter it on the sign-in page. Case does not matter, and it is the same invitation as the link.',
  'people.link.copy': 'Copy',
  'people.link.copied': 'Link copied',
  'people.link.copyFailed': 'Select and copy the link',
  // Fields the add, invite and manage sheets share
  'people.form.displayName': 'Display name',
  'people.form.role': 'Role',
  'people.form.letThemSave': 'Let them save copies',
  'people.form.adminsAlwaysDownload': 'Admins can always download the files.',
  // Add a person
  'people.add.title': 'Add a person',
  'people.add.optional': 'Optional',
  'people.add.username': 'Username',
  'people.add.temporaryPassword': 'Temporary password',
  'people.add.passwordHint': 'Tell them in person; they can change it under Settings → Account.',
  'people.add.adding': 'Adding…',
  'people.add.added': 'Added {name}',
  'people.add.failed': 'Could not add the account.',
  // Invite by link
  'people.invite.whoFor': 'Who is it for?',
  'people.invite.namePlaceholder': 'Optional - shown on the invite',
  'people.invite.saveCopiesHint':
    'Downloads the original file to their device, to keep. Reading and offline use do not need this.',
  'people.invite.validFor': 'Valid for',
  'people.invite.days': '{n, plural, one {# day} other {# days}}',
  'people.invite.creating': 'Creating…',
  'people.invite.createLink': 'Create link',
  'people.invite.failed': 'Could not create the invitation.',
  // Manage an account
  'people.manage.ownRoleHint': 'Ask another admin to change your own role.',
  'people.manage.saveCopiesHint':
    'Downloads the original EPUB or audio file to their device, to keep. Reading and offline use do not need this.',
  'people.manage.saveChanges': 'Save changes',
  'people.manage.saved': 'Saved',
  'people.manage.saveFailed': 'Could not save.',
  'people.manage.resetPassword': 'Reset password',
  'people.manage.resetPasswordHint':
    'Signs them out on every device; they sign back in with this one.',
  'people.manage.newPasswordPlaceholder': 'New password (10+ chars)',
  'people.manage.reset': 'Reset',
  'people.manage.passwordReset': 'Password reset',
  'people.manage.access': 'Access',
  'people.manage.signOutEverywhere': 'Sign out everywhere',
  'people.manage.signedOut': 'Signed out of {n, plural, one {# device} other {# devices}}',
  'people.manage.noSessions': 'No active sessions',
  'people.manage.signOutFailed': 'Could not sign out',
  'people.manage.enableAccount': 'Enable account',
  'people.manage.disableAccount': 'Disable account',
  'people.manage.accountEnabled': 'Account enabled',
  'people.manage.accountDisabled': 'Account disabled',
  'people.manage.deleteAccount': 'Delete account',
  'people.manage.deleteHint':
    'Removes their progress, bookmarks and sessions. Library files are never touched.',
  'people.manage.deleteNamed': 'Delete {name}…',
  'people.manage.deleteConfirm': 'Yes, delete permanently',
  'people.manage.keep': 'Keep',
  'people.manage.accountDeleted': 'Account deleted',
  'people.manage.deleteFailed': 'Could not delete.',
  // The server's error codes, in words
  'people.error.usernameTaken': 'That username is already taken.',
  'people.error.lastAdmin': 'This is the last active admin - promote someone else first.',
  'people.error.selfLockout': 'You cannot remove your own admin access.',
  'people.error.proxyManaged':
    'This account signs in through the reverse proxy; there is no local password.',
} as const;
