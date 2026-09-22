/**
 * Friends on the progress bar, in the reader and the player. Kept apart
 * from the Friends page's own strings because it ships with the reader.
 */
export const friendsBar = {
  'friends.bar.button':
    '{n, plural, one {# friend is reading this} other {# friends are reading this}}',
  'friends.bar.title': 'Friends in this book',
  'friends.bar.lede': 'Where each of them is, and whether to draw them on your bar.',
  'friends.bar.finished': 'Finished it',
  'friends.bar.atChapter': '{chapter} · {pct}',
  'friends.bar.together': 'Right where you are',
  'friends.bar.ahead': '{pct}% ahead of you',
  'friends.bar.behind': '{pct}% behind you',
  'friends.bar.show': 'Show {name} on my progress bar',
} as const;
