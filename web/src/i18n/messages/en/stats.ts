/**
 * The reading stats page.
 *
 * Numbers arrive already formatted by useFormat (durations, percentages,
 * hours of the day), so the strings here carry sentences, not arithmetic.
 */
export const stats = {
  'stats.title': 'Your reading',
  'nav.stats': 'Stats',

  // The lead sentence
  'stats.lead.week':
    '{seconds, select, zero {Nothing yet this week.} other {This week: {time} across {sittings, plural, one {# sitting} other {# sittings}}, on {days, plural, one {# day} other {# days}} out of seven.}}',
  'stats.lead.empty': 'Nothing to show yet.',
  'stats.lead.emptyBody':
    'Read or listen for a while and come back. Every sitting is counted from the moment you open a book, on every device.',
  'stats.lead.openLibrary': 'Open the library',
  'stats.error': 'The stats could not be loaded. Check the server connection.',
  'stats.olderServer': 'This server is a version behind and does not keep reading stats yet.',

  // Figures
  'stats.figure.thisWeek': 'This week',
  'stats.figure.sittings': 'Sittings',
  'stats.figure.streak': 'Streak',
  'stats.figure.streakDays': '{n, plural, one {# day} other {# days}}',
  'stats.figure.streakToday': 'read today',
  'stats.figure.streakKeep': 'read today to keep it',
  'stats.figure.streakNone': 'five minutes a day starts one',
  'stats.figure.longest': 'Longest run: {n, plural, one {# day} other {# days}}',

  // When you read
  'stats.when.title': 'When you read',
  'stats.when.lede': 'Every sitting of the last {days} days, by day of the week and hour.',
  'stats.when.less': 'less',
  'stats.when.more': 'more',
  'stats.when.cell': '{day}, {hour}: {time}',
  'stats.when.weekdays': 'Weekdays',
  'stats.when.weekends': 'Weekends',
  'stats.when.split': '{weekdayPct}% of your reading is on weekdays, {weekendPct}% at the weekend.',

  // Focus: going back for the thread. "Went back" and "held the thread",
  // never "distracted" - re-reading is also how careful readers read.
  'stats.focus.title': 'Holding the thread',
  'stats.focus.lede':
    'A step back of a page or two is a re-read: the thread slipped and you went back for it. Careful readers do it too - this is about when you do it least.',
  'stats.focus.collecting':
    'Still collecting. Once a few more sittings have a step back in them, this page will say when you hold the thread best.',
  'stats.focus.week':
    '{n, plural, =0 {This week you have not gone back once in {time} of reading} one {This week you went back once in {time} of reading} other {This week you went back # times in {time} of reading}}{verdict, select, less {, less than usual.} more {, more than usual.} usual {, about your usual.} other {.}}',
  'stats.focus.weekEmpty':
    'Nothing yet this week. Over the last {days} days you went back {n, plural, =0 {not once} one {once} other {# times}} in {time} of reading.',
  'stats.focus.stripLabel': 'When you hold the thread, by hour of the day',
  'stats.focus.cell': '{hour}: went back about {rate} times an hour of reading',
  'stats.focus.cellThin': '{hour}: not enough reading here to say',
  'stats.focus.less': 'went back more',
  'stats.focus.more': 'held the thread',
  'stats.focus.steadiest':
    'Between {from} and {to} you go back {pct}% less often than your usual: that is when you hold the thread best.',
  'stats.focus.even': 'No hour stands out: you hold the thread about as well whenever you read.',

  // The recommendation
  'stats.best.title': 'Your best time to read',
  'stats.best.collecting':
    'Still collecting. After {days, plural, one {# more day} other {# more days}} with a book open, this page will tell you when you read best.',
  'stats.best.collectingSittings':
    'Still collecting. A few more sittings and this page will tell you when you read best.',
  'stats.best.window': 'You read best between {from} and {to}.',
  'stats.best.sittingLonger':
    'Sittings there run about {minutes} minutes, {pct}% longer than your average.',
  'stats.best.sittingUsual': 'Sittings there run about {minutes} minutes, about your average.',
  'stats.best.sittingShorter':
    'Sittings there run about {minutes} minutes, a little shorter than your average - but there are more of them.',
  'stats.best.paceFaster': 'You also get through a book {pct}% faster in that window.',
  'stats.best.paceUsual': 'Your pace there is about your usual.',
  'stats.best.paceSlower':
    'You read a little more slowly there, which is often a sign of reading more carefully.',
  'stats.best.focus': 'You also go back for the thread less often there.',
  'stats.best.advice':
    'If you want to read more, that is the hour to protect. Everything else on this page is description; this is the one suggestion.',
  'stats.best.share': '{pct}% of all your reading happens there.',

  // Reading and listening
  'stats.split.title': 'Reading and listening',
  'stats.split.reading': 'Reading',
  'stats.split.listening': 'Listening',
  'stats.split.words': '{n, plural, one {# word} other {# words}} read',
  'stats.split.wordsUnknown':
    "Words are counted for books whose length the server knows; none of this week's were.",
  'stats.split.pace': 'about {n} words a minute',
  'stats.split.sitting': 'A typical sitting is {time}; the longest was {longest}.',

  // Books
  'stats.books.title': 'On the go',
  'stats.books.lede': 'Every book you have opened in the last {days} days.',
  'stats.books.timeIn': '{time} in',
  'stats.books.left': 'about {time} left at your pace',
  'stats.books.finished': 'Finished',
  'stats.books.finishedOn': 'Finished {date}',
  'stats.books.unknownTitle': 'A book no longer in the library',
  'stats.books.lastRead': 'last {when}',

  // Weeks
  'stats.weeks.title': 'The last eight weeks',
  'stats.weeks.bar': 'Week of {date}: {time}',
  'stats.weeks.average': 'Average {time} a week',

  // All time
  'stats.alltime.title': 'All time',
  'stats.alltime.since': 'Since {date}',
  'stats.alltime.hours': 'Hours',
  'stats.alltime.sittings': 'Sittings',
  'stats.alltime.finished': 'Books finished',
  'stats.alltime.truncated':
    'Showing the most recent sittings; the older ones still count in the totals.',

  // The strip on the library home
  'stats.strip.title': 'Your week',
  'stats.strip.empty': 'Your reading stats will appear here.',
  'stats.strip.open': 'See your stats',
} as const;
