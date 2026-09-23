# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org);
while ReadPort is pre-1.0 a minor bump may still change a contract, and
anything that does is called out under **Upgrading**.

## 0.21.1 - 2026-09-23

### Added

- **Your account at the top of Settings.** Your initial, and your name
  where there is room, at the end of the page's title, opening a short
  menu: who is signed in, the account settings, and Sign out. Signing out
  was a button near the foot of a long page.

### Changed

- **Save offline and Download file.** The book page's two download buttons
  said "Download" and "Save a copy", which read as the same thing twice.
  Save offline keeps the book inside ReadPort to open without a connection,
  under the cloud the On this device shelf wears, with a tick in it once
  saved. Download file hands the book's own file to the device. Save
  offline has no border now, like the other tools in its row, and on a
  phone the row's icons line up.
- **Read, Read along, Listen** stay those three words once a book is
  started. "Continue reading", "Read along from here" and "Listen from
  here" made the buttons long, and the progress bar above them already
  says where they continue from.
- **The pairing note** under a paired book shows only when switching will
  not do what the buttons promise: the pair is not timed yet, or the other
  edition is not on this device. It was on every paired book.
- **A book's language shows by itself.** Where it came from, such as "read
  from the text", is the chip's tooltip.

### Fixed

- **Auto-scroll draws no margin mark.** The page moves under a fixed line
  for the voice, and the mark in the margin said nothing the moving page
  did not.

## 0.21.0 - 2026-09-23

### Added

- **Prints.** Small linocut vignettes of a harbour town that keeps books:
  an empty bookcase on a pier for an empty library, a boat of books while
  the first scan runs, a bare shelf, a stack tied with string for the
  reading list, a ship's log for notes, two deck chairs for friends, a sea
  chest for this device's downloads, and a telescope for a search that
  finds nothing. The harbour itself runs along the foot of the sign-in
  page, and a printer's flower closes every chapter. Each is printed in the
  theme's own ink, so it is terracotta on paper and a lighter terracotta on
  the dark ground.
- **Clothbound covers.** A book with no cover of its own is bound in one of
  six bookcloths (waves, gulls, lighthouses, anchors, shells, stars) with
  its title and author on a paper label, instead of a plain block of
  colour.

### Changed

- **One language at a time.** The row of language chips is one button
  beside Ebooks and Audiobooks, "All languages" until a language is
  chosen. It opens a card of the library's languages with their counts;
  choosing one closes it, and the button shows the language in the accent.
  On a phone it sits at the end of the format control's row, as the globe
  or the chosen language's flag.

### Fixed

- **"All" is as wide as its neighbours** in the library's format control on
  a phone. A rule meant for four labels on the Notes page trimmed every
  segmented control to four pixels of padding, and "All" shrank to its
  three letters.

## 0.20.0 - 2026-09-23

### Added

- **Read along from the book page.** A paired book's page now offers all
  three ways to take it - Read, Read along, Listen - as three buttons in
  the same order whichever edition you are on, with Read along between the
  other two because it is both. It opens the ebook at the resolved
  position with the voice already on the page (`?along=1`), and is
  disabled with a reason until the pair is aligned. This also puts two
  secondaries on the phone's second line, where before one sat alone at
  half width.

### Changed

- **The read-along icon is a narrator.** A head and shoulders with the
  voice coming off them, mirrored in RTL so the voice faces the text; the
  text-lines-with-bars it replaces read as an equaliser.
- **The scroll-with-the-voice icon** is text with a doubled chevron
  running down beside it, for "keeps going by itself", in place of a plain
  down arrow.

## 0.19.2 - 2026-09-23

### Changed

- **The read-along transport grows out of its button.** The controls are
  a card above the bar with a beak pointing at the Read along button,
  which wears a halo in the card's tint while the voice is on the page,
  so the two read as one thing. Listen steps aside while it is.

## 0.19.1 - 2026-09-23

### Fixed

- **Page mode on an iPhone, at last.** WebKit lays out a single column
  declared by count alone as no columns at all: one tall column running
  off the page, which every check then rightly called trapped, so page
  mode fell back to scrolling on every phone. The page box now declares
  the width of its column as well as the count, which is what WebKit
  needs to form the columns, and the overflow columns that are the pages.
- **A figure taller than the page** is scaled to the page in page mode
  instead of trapping the rest of the chapter below it.
- **The voice's mark in a chapter that scrolls.** In the scrolling
  fallback the mark was dropped whenever the page was to be driven for
  the voice, and came back only once a scroll had detached the following.
  The fallback now uses its own scrolling box everywhere the scroll mode
  uses its own: the mark, the driven page, and a tap at the page's edge,
  which moves a screen rather than a chapter.

## 0.19.0 - 2026-09-22

### Fixed

- **Pages that blinked.** A chapter the page layout could not hold - one
  with a figure taller than the page, say - was let scroll, then judged
  again from the scrolling layout, where nothing is trapped, and put back
  into columns, where it was, and so on at the speed of a render: the text
  and the footer flickering between the two while the tab ground to a halt.
  The judgement is made only while the chapter is in columns, and a chapter
  that scrolls stays scrolling until it is opened again.
- **The resumed line, let go by the voice.** The mark where you last
  stopped fades as the sentence being spoken leaves it, the way it fades
  when you scroll past it. It used to stay: a bar in the margin at the
  resumed line while the voice was a page away, which read as the voice's
  own mark gone astray - and, with the sentence highlighted instead of
  marked, as a marker that would not go.
- **The search pill keeps to the end of the top bar** on a phone, where
  the chapter title between the buttons and the pill is gone.
- **A row under a finger no longer lights up** while the contents list is
  scrolled: hover is for pointers that can hover.

### Changed

- **The selection's menu** is a pill, each icon with its name under it, and
  the small cross that dropped a selection is gone: Escape, or a tap
  elsewhere, does that. A tapped highlight's row is captioned the same way.
- **Search opens as a launcher does:** one field near the top of the page,
  the matches filling in as you type, Enter opening the first. No sheet,
  no Search button.
- **Following the voice, drawn.** The two ways of showing the voice - a
  mark in the margin beside the line, or the sentence highlighted - are
  chosen from two small drawings of a page rather than two phrases.
- **The contents sheet's tabs** stay in its head while the chapters or the
  bookmarks scroll under them.

## 0.18.0 - 2026-09-22

### Fixed

- **Pages on a phone.** The pages view scrolled whole chapters on an
  iPhone: the fallback to scrolling fired whenever the chapter's
  `scrollHeight` ran past its box, and WebKit reports a multi-column box's
  `scrollHeight` as if it were one column, so every chapter longer than a
  page "failed" and never recovered. Trapped text is judged by geometry
  now, on every pass, so a chapter is paged again once its fonts have
  settled.
- **Marks that keep up with the text.** The resumed line, the margin
  mark, the spoken sentence, the blink and the selection frame were
  positioned in the viewport and moved by script on scroll, a frame or
  two behind the text on a phone. They live inside the scrolling box now
  and move with it natively. The margin mark is held to the sentence being
  spoken, so it no longer drifts a line or two above the wash.
- **A selection that ends where the text does.** Only the text is
  selectable, so a drag to the foot of the page no longer runs into the
  chrome and lights the screen blue.
- **The library no longer pans sideways on a phone.**

### Changed

- **The reader's bars.** Above: back, contents (chapters and bookmarks in
  one sheet, opened on the chapter being read, which is now unmistakable),
  type, and search drawn as the small field it opens. Below: a people
  button for the friends in the book, the bar with their beads, the
  percentage, and round buttons for Read along and Listen. The page's own
  bookmark moved to the top of the bookmarks tab.
- **The selection.** One outline around the whole selection instead of a box
  per line; a toolbar of four icons, highlight, note, bookmark and share,
  with the colours behind the highlighter; a tapped highlight offers its
  colour, a note, sharing and removal the same way; the docked strip is
  gone. On a phone the platform's own edit menu is taken down once a
  selection settles, and a tap on the selected words brings it back while
  ours steps aside, so one menu shows at a time. A shared passage goes out
  whole, on its own lines, with the link on a line of its own.
- **Following the voice** is a setting: a mark in the margin (the default)
  or a wash on the sentence, one at a time.

## 0.17.0 - 2026-09-22

### Added

- **Friends who are here right now.** A friend whose position in a book
  moved within the last few minutes (six for a reader, a minute and a half
  for a listener, the cadences their devices report at) is in it now: their
  bead on your progress bar breathes, the card names them Reading now or
  Listening now, and so do the book page's friends line and the Friends
  page, which all ask again once a minute while they are in front of you.
  Presence is the same shared position, no more: a friend who does not
  share progress shows nothing new.
- **The foot of Settings** shows the version this is and a link to the
  project on GitHub. Tapping the version reopens What's new, seen or not.

### Changed

- **Share is one button.** It opens a small menu: copy the link, send it
  on WhatsApp, hand it to the phone's share tray, and, once a link exists,
  withdraw it. Opening the menu makes no link; the first thing that needs
  one does. The book page's actions are two rows now: the ways to open the
  book, then a quieter row of tools (Add to, offline, Share, Save a copy),
  which on a phone is four icons with short labels under them.
- The API answers `GET /api/books/:id/share` with the caller's live link
  for a book, or nulls, without making one; friends and their progress
  carry a `live` flag.

## 0.16.0 - 2026-09-22

### Added

- **A link to a book.** Share on the book page makes a link that previews
  in WhatsApp, Telegram or iMessage with a picture composed from the cover,
  the title and "Shared with you on ReadPort"; the plain app address keeps a
  card of its own. Someone with an account sees who shared the book and can
  put it on their reading list, where it says "Recommended by" in the
  friend's colour (a recommendation accepted from the Friends inbox says the
  same). Someone without one can sign in on the spot or ask to join with an
  email address; admins see the requests at the top of People, with a dot on
  Settings, and approving one lets the same link, with the same address,
  create the account and open the book. Nobody is let in without an admin
  saying so; the routes under `/s/` are the one public page about a book,
  rate limited and bounded to that book's title, author and cover.
- **Share a passage.** The selection menu in the reader has a Share button:
  "Look what I read in {title}", the quotation and the book's link, through
  the phone's share tray or to the clipboard.
- **A selection can run past the page.** Turn the page with a selection
  held and a Continue selection pill waits at the top of the next one;
  tapping it makes the reader's next tap the end of the selection, across
  as many pages as it takes. The selection is framed line by line in the
  theme's accent, with a small cross to drop it.
- **Holding the thread.** A step back of a page or two inside a sitting is
  a re-read, and the diary counts them (further back is navigation and is
  not). The stats page reads them as steadiness: how often you went back
  this week against your usual, the hours of the day by how well the
  thread held, drawn under the heatmap in its own cells, and the steadiest
  run of hours once there is evidence for it. The best-time recommendation
  weighs it lightly, under minutes and pace.
- **Every book's language is read from its text.** Twelve windows spread
  through the book, classified by script first and by character trigrams
  after, with an answer only when they agree by a clear margin; for an ebook
  that reading outranks the file's tag (so often a tool's default) and
  yields only to a curator's override. The library toolbar gains a row of
  language chips with flags and counts, kept in the address, and the
  sidebar's Languages group shows the same flags.

### Changed

- **Friends on the progress bar are beads.** A friend is a bead in their
  colour with their initial, on the reader's bar, its full slider and the
  player's scrubber alike; two friends too close step aside by a bead. The
  way to the card is a stack of the same beads beside the percentage, "+n"
  past three, and any bead opens it too.
- **Read-along sits on the line.** The spoken mark is drawn on the exact
  line boxes of the words in every theme, size and mode; auto-scroll eases
  in and out instead of jumping; and tapping an earlier passage to move the
  narration back shows where the voice picks up, a gradient over the
  sentence that is full at its first word and gone by its last, pulsing
  gently twice. A sentence the page ends in the middle of now turns the
  page the moment the voice crosses onto the next one, judged by where the
  voice is within the sentence rather than where the sentence starts; on a
  two-page spread it used to read the rest from a page you could not see.
- **The other-device offer stays.** "Another device is at 69%, jump
  there" left after eight seconds; it is an offer, not a report, so it now
  waits until it is taken or closed with its cross, and leaves with the
  book.

### Fixed

- **The compact progress bar** was caught by the footer's chapter-label
  rule, which clipped its position dot (and now the friends' beads) to the
  line's three pixels and let the line shrink to nothing beside the
  read-along pill on a phone. It keeps a minimum width, and a friend's bead
  that steps aside from a neighbour no longer lands on the next one.

### Upgrading

- Two migrations: one adds the share and join-request tables and the
  reading list's provenance; the other adds two counters to the reading
  diary and clears the sittings of the last 29 days, which the first start
  derives again from the progress history. After the upgrade a job reads
  every ebook's language again from the chapter text already on disk, a
  hundred books at a time, behind every scan.
- The container carries two fonts under `server/fonts` for the preview
  picture. Nothing in the configuration changes; set `publicUrl` in Settings
  if share links should carry an address other than the one the sharer's
  browser used.

## 0.15.2 - 2026-09-22

### Fixed

- **A page left open no longer counts as reading.** A sitting's time is now
  the sum of its steps, each counted only up to what it can plausibly hold:
  an ebook records a checkpoint when the position moves and nothing while
  one page stays on screen, so a page is five minutes at most, and a device
  left open on a page and picked up again inside the ten-minute gap counts
  five minutes rather than nine. Audio reports every fifteen seconds while
  it plays and nothing while paused, so a pause counts twenty seconds at
  most. Sittings from before this rule keep their wall-clock time; the
  recent ones, whose every heartbeat the progress history still holds, are
  derived again with the new rule on first start. Narration left playing is
  listening as far as the app can tell; the sleep timer is the tool for
  that.

### Upgrading

- One migration adds a column to the reading diary and clears the sittings
  of the last 29 days, which the first start derives again from the progress
  history. Nothing else changes.

## 0.15.1 - 2026-09-22

### Fixed

- **The search on the Pairing page's Unpaired tab looked unfinished:** a bare
  field with the icon beside it. It is now the library's own search box.

## 0.15.0 - 2026-09-22

### Added

- **Export options for highlights.** Export as PDF opens a sheet first:
  Paper or Night, an A4, Letter or Phone page (the phone page is narrow and
  reads at full width on a phone screen), what to include (highlights,
  notes, bookmarks, the cover, chapter headings, position and date lines,
  notes under highlights), the order, and the text size. Choices are
  remembered on the device and can be changed from the preview. The
  document itself is redesigned: the ReadPort mark and wordmark on a title
  page with the cover, the counts and a colour legend; running chapter
  heads; colour bars printed as borders so printers keep them; and a Night
  look with light type on dark pages that survives Save as PDF.

### Changed

- **The Pairing page is four tabs.** Suggested holds the matches waiting
  for a yes or no, Linked every pair with where its alignment stands,
  Unpaired the books with no other edition, Dismissed the noes in case of
  a change of mind. Each pair is one compact row - the two covers, the
  title, its state in a chip (aligned, aligning, queued, ready to align,
  model needed, failed) and, once aligned, the coverage strip at a glance -
  with only the one action that state calls for. Evidence, the narration
  language, the full alignment report and unlinking open under the row.
  The alignment work panel names what it counts: the rows marked Ready to
  align sit directly beneath it, with a checkbox each, and the two
  alignment options fold away behind one line. The processing panel folds
  to one line when nothing is running.
- **A synced pair wears the switch arrows between its two formats** on the
  library tile, in ember, instead of a third pill saying SYNC. The badge
  already said the title was owned twice; the join now says whether the
  two editions meet.
- **The shelves drawer leads to everything.** All books at the top of the
  shelves, and on a phone a More group with Stats and Pairing, which the
  five-tab bar has no room for.

## 0.14.2 - 2026-09-22

### Fixed

- **A book opened and closed again appeared under On the go** with 0:00 in
  and an empty bar. A book is on the go once you have spent a minute with it
  or covered any ground.

## 0.14.1 - 2026-09-22

### Changed

- **The three actions on a Reading Now row carry icons** - the open book or
  the play triangle to resume, the headphones or the book for the other
  edition, a turn of the arrow for the reset - and the reset stands apart at
  the end of the row in soft ink, so it no longer reads as loudly as the two
  ways into the book.

## 0.14.0 - 2026-09-22

### Added

- **"What's new."** A reader who was here before a release is told, once, on
  the way in: the version, a short list of what changed, and older releases
  one tap away with a divider per version. Three ways to close it. The seen
  version lives on the account, so dismissing it on a phone dismisses it on
  the laptop, and a brand-new account is never handed a changelog for
  software it has not opened. Never over a book.
- **Your reading.** A stats page at `/stats`, and a one-line strip on the
  library home. Every sitting is recorded as it happens - one book, one
  device, one stretch of time - and kept for good, unlike the progress
  history it is derived from, which is compacted after a month. The page
  says when you read (a week-by-hour map), how much, in which format, how
  long a typical sitting runs, how far through each open book you are and
  roughly how long is left at your own pace on it, and, after two weeks of
  evidence, the one suggestion the page allows itself: the hour of the day
  you read best, judged on how long your sittings run there and how fast
  you move, relative to your own average - never to anyone else's. Hours
  are worked out in the browser's own timezone, streaks need five minutes
  to count a day, and one long Sunday is not allowed to become advice.
- **Connected apps.** Settings → Connected apps takes the addresses of the
  apps beside this library - Calibre-Web Automated, Audiobookshelf,
  Shelfmark, ReadMeABook, Kavita, or anything else - and shows them as
  tiles at the foot of the shelves for everyone on the server. A "smart
  integration" switch sits beside each, disabled and labelled as coming:
  reading those apps through their own APIs is not built yet, and the
  settings page says so rather than implying it.
- **Friends.** Everyone on a server already shares one library; a
  friendship is consent to see each other's place in it. Ask, accept or
  decline from a Friends page; each friend wears a colour you choose. Open
  a book a friend has open and a small button sits by the progress bar:
  it names where they are - chapter, percent, how long ago, how far ahead
  or behind you - and a switch per friend draws them on your bar as a thin
  mark in their colour, remembered per book. A friend listening to the
  audiobook edition of a linked pair counts as being in the ebook, and the
  other way round. Recommend a book to a friend with a one-line note; it
  waits on their Friends page and as a dot on the tab until they look.
  Sharing can be switched off, and then friends are told nothing at all.
  Nothing written in the margins is ever shared.
- **Highlights and notes, by book.** The Notes page opens on the books
  that carry marks, with counts and the colours used; a book's own page
  lists every highlight, note and bookmark under its chapter, sortable by
  place, date or colour, filtered by kind and colour, each one a tap from
  its place in the book. Export as PDF prints a clean document: a title
  page with the cover and the counts, then the marks under running chapter
  heads, colour bars that survive printing, passages in the reading face,
  and right-to-left passages set the right way round.

### Changed

- **Release notes are the one exception to full translation.** They are
  written in English when a release is cut; a language that has not caught
  up shows the English line rather than holding the release. The dialog's
  own chrome is translated everywhere.

### Fixed

- **A title owned in both formats appeared twice on Reading Now, Finished
  and the Continue band.** Collapsed to one row, which stands for the
  edition touched most recently - a row that resumed at page one of an
  untouched ebook while the reader was half way through the narration was
  the complaint. The row names the other edition's position and offers it;
  a title finished in one format and under way in the other appears once on
  each shelf and never twice on either; the sidebar counts rows, not
  editions; reset stays per edition and the button now names which.
- **Manual linking offered books that were already linked** - and the two
  pickers did not even agree, since paired audiobooks were hidden behind
  their ebooks while paired ebooks were offered. `filter=unpaired` now does
  it in SQL. An unreviewed candidate still counts as unlinked: that is
  exactly what somebody opens the sheet to correct.
- **Turning an iPad lost the page.** The reader now re-lays itself out on
  any change of viewport - orientation, a split view, a keyboard - and
  lands back on the sentence it was showing, in one column or two; auto
  layout decides one or two pages again after every turn. Every page turn
  recorded the page after the one on screen when turns were instant (which
  reduced motion forces), so each later relayout moved the reader forward:
  fixed, and the place is re-checked on return from another app too.
- **Jumping to a highlight in a two-page spread landed a page early.** The
  jump measured against a page count that a rotation had made stale; it
  now measures the live layout and verifies the passage is on screen.
- **The contents panel opened on whichever tab was last used** and gave no
  hint of the current chapter. It opens on Chapters, with the current one
  marked; the audiobook's chapter list is marked the same way.
- **The Look Up and Translate menu on an iPhone stopped appearing after a
  few highlights.** A transition that never ended left the selection
  toolbar re-measuring itself on every frame, which is what stops iOS from
  drawing its own callout. The loop is gone, and the pointer kind that
  decides how much room to leave for that callout is read per selection
  rather than remembered from the last mouse click.

### Upgrading

- Two migrations run on first start: the reading diary and the friends
  tables. The diary is then derived once from the progress history the
  library already holds, so the stats page does not begin on upgrade day;
  on a large library that first start takes a few seconds longer. Nothing
  else changes: no new configuration, no change to the API already in use.

## 0.13.0 - 2026-09-16

### Added

- **The interface in 23 languages.** English, Hebrew, Russian, Arabic,
  Spanish, French, German, Portuguese, Italian, Dutch, Polish, Ukrainian,
  Czech, Romanian, Swedish, Danish, Norwegian Bokmål, Finnish, Greek, Turkish,
  Japanese, Korean and Simplified Chinese, chosen per account in Settings and
  followed to every device; the browser's language is the default, English the
  last resort. Hebrew and Arabic turn the shell right-to-left while every book
  keeps its own direction. Plurals, numbers, dates, relative times and
  language names follow the interface language. Translations other than
  English are model-generated and say so. See docs/localization.md.
- **A book's language, with where it came from.** A curator's override that
  survives every rescan, the file's own tag, the other _verified_ edition of
  the same book, or the prose itself - and "unknown" is browsable too. Filter
  by several languages at once from the sidebar. A French audiobook paired
  with an English ebook is now under French, because language narrows
  editions before a pair collapses to one card.
- **Facet counts describe the view in front of you** - a search, a format, a
  progress shelf, the downloads on this device - rather than the whole
  library, and Browse survives being offline.
- `GET /api/pairs/:id/chapters`: where each chapter sits in the narration,
  which is what lets "Back to the voice" open the right chapter in one move.

### Changed

- **Pointing Compose at your library is a `.env` edit, not a file edit.**
  `RP_EBOOK_PATH`, `RP_AUDIOBOOK_PATH`, `RP_ALIGNMENT_PATH` and
  `RP_HTTP_PORT` are read by `docker-compose.yml`, which no longer has to be
  touched at all - so `git pull` stops conflicting with your mounts. The
  defaults are the sample library and port 8383, exactly what the file
  hard-coded before, so an existing install behaves identically.
- **Compose passes through the variables `.env.example` always claimed it
  did.** `RP_SESSION_DAYS`, `RP_LOG_LEVEL`, `RP_CLIENT_IP_HEADER` and
  `RP_CLIENT_IP_SOURCES` were documented but silently dropped by the stock
  file; setting them in `.env` now does what it says. CI fails if that drifts
  again, and if any `RP_*` the server reads is missing from `.env.example` or
  the reference table.

### Fixed

- **The dedicated worker did not get the alignment settings.** With
  `--profile worker`, `RP_DEFAULT_LANGUAGE` and `RP_SCAN_INTERVAL_MINUTES`
  reached the web container and not the container that actually aligns and
  scans, so a library whose language of last resort was not English aligned as
  though it were. The worker now receives them, plus `RP_LOG_LEVEL` and the
  session secret it was otherwise generating a second copy of into `/data`.
- **Reading progress could be filed under the wrong person.** Signing out
  while a player was open, or leaving a tab on the login screen while someone
  else signed in from another tab, could deliver one account's checkpoints
  under another's. Every checkpoint now carries the account it was captured
  for, the server refuses to file it under anybody else, a page delivers
  nothing until it has confirmed who is signed in, and sign-out seals the
  queue.
- **A reader lost an hour of page turns after a phone glanced at the book.**
  A visible reader whose heartbeats are being recorded but not applied now
  re-states its position once and holds the claim again.
- **Without IndexedDB a book would not open.** Progress lives in memory for
  the page instead, and the reader is told.
- **Opening the app with no network recorded nothing at all.** Because no
  server could confirm who was signed in, every checkpoint was dropped -
  emptying durable progress in exactly the case it exists for. Reading
  offline now records for the account this device already had signed in;
  each event still carries that account, and the server still refuses to
  file it under anyone else.
- **Read-along in scroll mode yanked the page back to the start of the
  chapter** about a second and a half in, with no glide to hide it under
  reduced motion. A re-landing timer was re-armed when the top bar was
  measured, long after the narration had moved the page.
- **A reset made on another device stopped your progress silently.** It is
  announced, with a way to keep reading from where you are.
- **A device with a slow clock lost every move it made offline.** Batches
  carry the client's clock and the server corrects for the skew.
- **"Back to the voice" was dead while paused in another chapter, and while
  playing it attached to the wrong chapter first.** It opens the chapter the
  voice is in. A rewind into the untimed stretch between two chapters could
  strand the page behind the voice with no way back; it cannot.
- **The read-along marker pointed a hand's width below the spoken line after
  every relocation** (two anchors, one line), vanished on pause, and slid
  through the text when the voice changed column. Scroll anchoring, a pinch,
  or a wheel in paginated mode no longer detach the page; the first swipe
  under auto-scroll is honoured; auto-scroll is remembered and comes back with
  the voice; and the page follows again by itself when the voice reaches the
  page you went to.
- **A chapter that would not paginate was dead to progress, resume and
  bookmarks.** It is tracked, landed and bookmarked like a scrolling chapter.
- **A resumed or bookmarked line landed under the top bar on a phone with a
  notch.** Landings sit under the measured chrome. Bookmarks whose words moved
  are found by their excerpt; a bookmark jump marks the line; opening a mark
  from the Notes page offers the way back; bookmark rows are real buttons.
- **The selection toolbar sat under Apple's edit menu** when a selection
  began near the top of the screen or was a short word. It keeps clear of the
  menu's real width and position, drops a stale span, clips to the page box,
  and keeps the selection under a touch.
- **"Hide shelves" could not be undone on an iPad.** The header offers "Show
  shelves" and docks the rail back.
- **Dragging a reading-list row led the finger by a full row**, autoscroll
  needed a moving finger, Escape did nothing during a drag and closed the
  shelves dialog during a keyboard grab, and a mouse drag on a shelf grip swept
  a text selection. All fixed; overlays follow the visual viewport when the
  keyboard is up; an iPad mini held upright gets the tablet shell.
- **Reading Now:** the home page's Continue band hid a paired audiobook in
  progress behind its untouched ebook, "All in progress · N" showed the
  band's length rather than the count, offline it said "nothing here yet",
  and it opened alphabetically. One predicate now serves the count, the shelf
  and the band, narrowed in SQL.
- **A saved alignment was recomputed anyway on a fresh container**, because
  the import was queued behind the alignment it should have prevented. The
  scan imports before it queues anything, an aligned pair is not aligned
  again unless asked, a pair linked by hand comes back pair and all, a
  duration two milliseconds across a rounding boundary still matches, an
  alignment folder reached through a symlink is read (it silently imported
  nothing, and on macOS every temp folder is one), and one damaged file
  cannot stop the rest.
- **Agent API:** refusals are metered by address, `Retry-After` is measured,
  unknown key prefixes are hashed too, query strings stay out of the request
  log, and a next offset past the ceiling is not offered.
- **On a wide desktop the scrollbar was drawn down the middle of the page.**
  The scrolling element was also the element capped at the reading measure,
  so its scrollbar landed wherever that column ended, with page either side
  of it. The pane now fills the space it is given and the column is centred
  inside it, which puts the scrollbar back against the window edge. A page
  that wants a narrower measure sets `--rp-measure` instead of its own
  `max-width`.

### Security

- **`npm ci` verified nothing.** 279 of 318 entries in `package-lock.json`
  carried neither an integrity hash nor a resolved URL, so neither a local
  build nor the release image could detect a tampered tarball - while
  `docs/security.md` claimed the dependencies were pinned. Every entry now
  carries its SHA-512 hash. No version changed: the hashes were fetched for
  the exact versions already pinned.
- **Authenticated API responses carried no `Cache-Control`.** Behind a CDN
  or caching proxy configured to cache aggressively - which is ordinary in
  this audience - one account's `/api/auth/me` or `/api/annotations` could be
  served to the next visitor. `/api/` now defaults to `private, no-store`;
  content routes keep their own longer private caching, and offline
  downloads are unaffected.
- **CI ran dependency install scripts next to a write-capable token.** The
  workflow declared no top-level `permissions`, so `checks` and `docker`
  inherited the repository default. They are now `contents: read`; `publish`
  keeps its own minimal `packages: write`.
- `.dockerignore` excluded `.env` only at the root, so a stray
  `server/.env` could be copied into a build stage.
- `docs/security.md` has been corrected where it had drifted from the code:
  the real EPUB zip limits, the `.rpalign` decompression cap that does exist,
  which settings endpoints answer a non-admin, and the fact that trusting a
  proxy with `RP_TRUST_PROXY=1` hands the rate-limit guarantee to that proxy.

## 0.12.0 - 2026-09-14

### Added

- **Read-along continuity on iPad.** The active-line marker follows the
  current text column on a two-column spread, in both directions; manual
  scrolling detaches the page from the voice while the audio keeps playing,
  and _Back to the voice_ finds the nearest honest cue, gaps included.
- **Durable, exact reading progress.** Character-level locators saved to
  IndexedDB before the network, last-gasp capture on page hide, server reset
  generations that old offline queues cannot undo, and a resume marker on the
  exact line.
- **Reading Now** as a compact list of what is genuinely in progress, with a
  per-edition reset that leaves the book, its files, notes, bookmarks and
  other people's progress alone.
- **A read-only agent API** under `/api/agent/v1`, with a closed route
  catalog, per-owner rate limiting and audit logging.
- **The selection toolbar stays out of the native selection menu's way**, and
  the tablet shell scrolls its rail and its library independently.

## 0.11.1 - 2026-09-13

### Fixed

- **Behind a tunnel, every client counted as one address**, which turned the
  sign-in limits inside out: instead of protecting the owner they became a
  lever against them, since ten wrong passwords against a guessed username
  could keep the real owner locked out indefinitely, from anywhere, for as
  long as the attacker cared to keep going. `X-Forwarded-For` is only walked
  back through the hops named in `RP_TRUST_PROXY`, and a tunnel daemon sits
  one hop further out than the proxy - so the walk stopped there and the
  whole internet shared a bucket.
- `RP_CLIENT_IP_HEADER` (with `RP_CLIENT_IP_SOURCES`) names the header that
  carries the real address - `cf-connecting-ip` behind Cloudflare. It is read
  only when the TCP peer is on the list, checked on the socket rather than on
  anything forwarded, and it is used **only** as a rate-limit key: never an
  identity, never an authorization input, and it does not feed
  `RP_TRUST_PROXY`. Misconfigured, it falls back to the socket address and
  logs; it can never let anybody in.
- **The warning for this fired only in the obvious case.** It checked whether
  proxy trust was unset at all, so the subtler configuration - naming the
  proxy but not the tunnel in front of it, which looks correct - stayed
  silent. It now notices what it is actually counting, and says so when that
  is a private address.

## 0.11.0 - 2026-09-13

### Changed

- **First run no longer asks for a token.** You start the server, open it, and
  create your admin account. The token it used to demand was generated at boot
  and printed to the log, so getting past your own welcome screen meant going
  and finding it - friction for the owner, and only ever protection for the
  seconds between a container starting and its owner opening it. The window is
  still exactly "no accounts yet", and it still closes for good the moment one
  exists.
- **`RP_SETUP_TOKEN` now locks that window instead of decorating it.** Set it
  and the wizard demands it, for anyone whose instance will be reachable from
  somewhere hostile before they have finished setting it up. A token is never
  generated any more, so unset means open - and the server says so in its log
  rather than letting that be a surprise.

### Upgrading

- **If you relied on the generated token, there is nothing to do** unless your
  instance is both un-set-up and publicly reachable. On upgrade the stale
  `<data>/setup-token` file is deleted, `/api/setup/status` reports
  `setupTokenRequired` in place of `setupTokenSource`, and `setupToken` is
  optional in the `POST /api/setup` body. An instance that already has an
  admin is unaffected in every respect.
- **If your instance is exposed and not yet set up, set `RP_SETUP_TOKEN`
  before upgrading.** Otherwise the first person to reach it makes the
  account.

## 0.10.1 - 2026-09-13

### Added

- **An account signed in through an identity provider can give itself a
  password.** It never could, which meant a library fronted by Authentik had
  no way in when Authentik was down - and no way to stay reachable if that
  gate were ever removed to let invited friends in. Settings -> Account offers
  it; no old password is asked for because there is none, and once one is set
  the ordinary rule applies again.

### Documentation

- **What it actually takes to open a library that sits behind forward-auth**,
  including the part that is easy to get wrong: dropping the middleware
  without also dropping `RP_PROXY_AUTH_HEADER` leaves the username header
  forgeable by anyone.

## 0.10.0 - 2026-09-13

### Added

- **Invitation codes you can read out**: `ABCD-EFGH-JKMN` instead of 32
  characters of base64url. Case, spaces and dashes are ignored, and the
  letters that look like digits are folded onto them - so a code dictated over
  the phone still works. The sign-in page now has somewhere to type one.
- **A public address**, asked during setup and editable under Sharing.
  Invitation links are built from it, so they work for the person you send
  them to rather than only on your own network. Optional.

### Fixed

- **A rewind could strand the reader** in a chapter the voice was not in, with
  nothing to point at - the chapter walker refuses to reverse, and a rewind
  could put it in a position where the only way back counted as a reversal.
- **"Back to the voice" did nothing in a gap**, which is exactly when it is
  pressed.
- **Auto-scroll lurched line to line**; it now moves at the speed the
  narration is working down the page.
- **The highlight colours were invisible.** The selection menu's button reset
  out-specified the swatch colours and painted all five transparent.
- **The selection menu needed two tries** on a phone, and could be wider than
  the screen.
- **Chapters did not open at their beginning**, and short front matter left
  the next-section button floating in the middle of a blank screen.

## 0.9.7 - 2026-09-13

### Fixed

- **Dark theme corrections never applied on the default setting.** Three rules
  fixed low-contrast text for dark, keyed on an attribute that is only set
  when Dark is chosen explicitly - and the default is Auto, which sets none.
  Coloured text now uses the token that is correct in both themes, and a test
  keeps it that way.
- **Explanations under switches rendered as full-size body text**: `.hint` was
  styled only inside a form field.
- **A working folder looked like a broken one** in setup: the success colour
  was never defined and fell back to the primary.
- **The book page hero never stacked on a phone**, leaving the body 191px wide
  and one action button per line.
- **The offline button's downloading state had no styling**, so its label ran
  together as "Downloading12.4 MB of 210 MB"; and "Downloaded" was as loud as
  the button that opens the book.
- **Reading progress was invisible on covers in dark theme.**
- **"Yes, delete permanently" turned the friendly primary colour on hover.**

## 0.9.6 - 2026-09-13

### Added

- **Save a copy of a book.** Separate from "download for offline", which keeps
  a book inside the app: this hands over the original file. It is a capability
  an admin grants to a person - not a role - set when they are invited and
  changed later, off by default. Admins always may. Revoking it takes effect
  immediately rather than whenever a session expires.
- **Read-only API keys, for agents.** A key lets an assistant see your
  library, lists and progress and can never change anything, take the book
  files, or manage keys. The secret is shown once and only a hash is kept.
  See `docs/api.md`.

### Changed

- **The book page leads with what you can do**, not a card announcing that a
  paired edition exists. "Sync ready" is gone: it was a word this app invented,
  followed by an admission that most sentences do not switch exactly.
- **Em dashes are gone from the whole project**, and a test keeps them out.
- **Covers resolve out of the book's own colour** instead of snapping in.
- **Reading settings are ordered**, and page turns are a choice: Slide, Fade
  or Instant.

### Fixed

- **A changed file loses its pairing and its alignment.** Both describe the
  content; replace the file and they are not stale, they are wrong. A book
  that merely goes missing keeps them, so a NAS that fails to mount does not
  cost hours of computed timings.
- The library filter clipped "Audiobooks" while the control had room to spare.
- The read-along pace marker hung at a stale position while you scrolled, and
  "Back to the voice" blinked as following turned itself back on.
- Auto-scroll now holds the marker still and moves the text under it, with
  manual scrolling disabled and the toggle lit while it runs.

## 0.9.5 - 2026-09-13

### Changed

- **The reading settings are ordered.** "Layout" held the mode, the progress
  bar, and then - under the heading "Progress bar", unlabelled - the column
  count. It is now _How it reads_ (Pages or Scroll) with each mode's own
  options nested under it, and the progress bar as its own group.
- **Page turns**: Slide, Fade or Instant. Reduced-motion settings override
  the choice.

### Fixed

- Every button in the player transport rendered at 56px, making the row wider
  than the box that clips it: the skip buttons' own rule had equal
  specificity and came earlier, so it never applied.
- The reader footer's chapter label pushed the Listen pill over the
  percentage until it truncated.
- The return pill's dismiss was a `<span role="button">` nested inside a
  `<button>` - invalid, keyboard-unreachable, and a 14px target.
- The reading-list row menu opened behind the tab bar on the last rows.
- The audiobook scrubber seeked on every input event of a drag; it now moves
  the audio once, when the finger lifts.
- The read-along speed menu could not be dismissed by tapping away or Escape.
- On touch, the shelf tools covered the book count and the end of the name.
- A sheet that did not clear the notch in landscape.

## 0.9.4 - 2026-09-13

### Fixed

- **The reader could hide the end of a chapter.** Pagination was measured the
  instant the chapter was injected - before its images had any height - so a
  chapter with figures measured as a single page, paging switched off, and
  the text that arrived with the images was trapped in a box that cannot
  scroll. It is measured again once images and fonts settle; and if a chapter
  still will not divide into pages, it scrolls and says so rather than hiding
  its own text.
- **The wrong book was suggested as a match.** Sharing an author was worth a
  quarter of the pairing score - worthless as evidence when you own a dozen
  books by one writer - and a length ratio of 0.56 passed a band that ran to
  1.9 and scored full marks. Titles now carry the pair, the ratio is a curve
  centred on 1.0, and candidates compete: a book has one audiobook, so a pair
  is offered only when nothing clearly better wants either half.

### Changed

- **Read-along shows a pace marker beside the text** instead of washing every
  sentence. The wash claimed a precision the alignment cannot always keep,
  and left the page looking marked up when it drifted. The text is now lit
  only where the aligner is sure, briefly, to re-anchor the eye.
- **Auto-scroll**: a toggle that holds the marker at the middle of the screen
  and eases the page along with the narration.

## 0.9.3 - 2026-09-13

### Added

- **"Link all" on the Pairing page.** A library owned mostly in both formats
  produces dozens of suggestions, and each one was a separate tap on the very
  page whose purpose is to get them linked. Confirming in bulk makes exactly
  the same decision as confirming one at a time - alignment queued included -
  and leaves anything already settled untouched.

## 0.9.2 - 2026-09-13

### Fixed - mobile

- **The setup wizard never finished.** "Reading your shelves" waited for
  every queued job, including the alignments that are queued as soon as a
  pair is found and run for minutes each; and `/api/jobs` returns only the
  newest 100 rows, so on a library of any size the scan job fell out of the
  window and the progress bar sat on its 5% placeholder. Setup now finishes
  when the books are in, and reports progress by books indexed.
- **The setup card slid sideways** whenever a step changed: `overflow-x:
hidden` still makes a scroll container, and focusing the step heading
  scrolled the card by the width its background glow bleeds past the edge.
- **The folder picker took several taps.** Rows were 37px and the icon
  buttons 36px, under the 44px minimum, with no gap between rows.
- **Username validation never ran.** `pattern="[a-zA-Z0-9._-]+"` is invalid
  under the `v` flag browsers compile `pattern` with, so it was ignored.
- **A setup token typed on a phone was rejected** - iOS capitalised its
  first character. Usernames had the same problem.
- **Alignments could not be highlighted near either page edge**, because
  the page-turn zones sat on top of the text on touch.
- **A long URL or code block in an EPUB scrolled the whole chapter
  sideways**, or was silently cut off in paginated mode.
- **The Pairing page could be swiped two thousand pixels sideways**: the
  coverage strip drew one bar per minute of audio, unbounded.
- **A mark's popover fell off the bottom of the screen**, putting Edit and
  Remove out of reach inside a reader that cannot scroll.
- **Sheets and drawers let the page scroll behind them.**
- **The toast covered the narration transport** it was reporting on.
- Touch targets raised to 44px across chips, segmented controls, highlight
  swatches, scrubbers, speed buttons and the reorder grip.

### Changed

- **A book owned as both an ebook and an audiobook is one card**, naming
  both formats, instead of appearing twice side by side. Filtering to
  Ebooks or Audiobooks still shows that side on its own.
- **Alignment accuracy and "align every new match" are on the Pairing
  page**, next to the queue they govern, as well as in Settings.
- **Download progress is visible**: bytes rather than files on the book
  page, and a live section on the On-this-device shelf with a stop.

## 0.9.1 - 2026-09-13

### Fixed

- **Alignments could not be saved into a mounted alignment folder.** The
  entrypoint took ownership of the data, cache and model volumes but not of
  the folders named by `RP_ALIGNMENT_DIRS`, so a folder created with `mkdir`
  on the host stayed root-owned and every save failed. Setup's preflight
  reported it, but there was nothing to do about it short of a manual
  `chown`. Read-only alignment mounts are still left alone.

## 0.9.0 - 2026-09-13

The first public release. Everything before this was development under an
earlier working name and is not documented here.

### Reading and listening

- **EPUB reader**: paginated (two-page spreads on wide screens) and scroll
  modes, TOC with fragment and footnote links, in-book search, five themes,
  page dimming, seven typefaces, and full control over size, weight, leading,
  margins, justification and hyphenation. RTL is honoured when the book
  declares it and inferred from the language when it does not.
- **Audiobook player**: chapters from embedded metadata or per-file, a
  scrubber with chapter ticks, configurable skips, 0.5–3× with pitch
  preserved and remembered per book, a sleep timer, and a lock-screen Media
  Session that reports live position.
- **Read along**: the narration playing over the page you are reading. The
  spoken sentence is washed as it is read, the page turns itself to keep up,
  and tapping any line moves the voice to it. Turning a page by hand stops the
  page following; it starts again on its own once the voice reaches wherever
  you went.
- **Two-way switching** on aligned pairs, at the sentence: reader ⇄ player
  from either surface, from the book page, and from the library. Switching
  from reading to listening lands _behind_ you by however far the alignment
  admits it might be wrong, because hearing a sentence twice is a nuisance
  and hearing one you have not reached is a spoiler.

### Marks, shelves and lists

- Highlights in five colours, chosen as you make one and changed afterwards
  by tapping the highlight.
- Notes carried by a dashed underline in the text rather than being invisible,
  and a **Notes & marks** page that collects every mark across every book and
  searches note, quoted passage, title and author at once.
- A sidebar of shelves - automatic ones (Reading now, Finished, Both formats,
  Recently added, On this device) alongside shelves you make yourself - and a
  **reading list** you can order by hand.
- **Browse by what the library already says**: groups built from Calibre tags,
  audiobook genre tags, narrators, publishers, years, Calibre ratings, series,
  authors and languages, with counts, one click from the grid. A grouping the
  library cannot support is never offered, and each reader picks which ones
  they see. Nothing is written back to the files.

### Alignment

- Timing is done by **forced alignment**, not transcription: the words are
  already in the EPUB, so one CTC acoustic model (317 MB, one download, every
  language) is run over the narration and matched against the book's own
  characters.
- `standard` precision puts about 7% of the audio through the model - roughly
  six minutes for a six-hour audiobook on a 6-CPU host. `exact` decodes
  everything and takes some fifteen times as long.
- Every finished alignment is written to a mounted **alignment folder** as one
  gzipped JSON document per pair (`.rpalign`). Files are matched back to books
  by a fingerprint of the ebook's sentences and the audiobook's track lengths
  - never by path - so a from-scratch reinstall imports whatever it
    recognises after its first scan.
- The book's language is read off the book's own text, by script and then by
  function words. Nothing is downloaded to answer that.

### Offline

- Installable PWA with an offline app shell, explicit per-title downloads with
  real progress, size and removal, and a Downloaded shelf that works with no
  network at all. Downloaded pairs bring their alignment with them, so
  switching still works on a plane.
- Progress is written to IndexedDB first as idempotent events and replayed
  when the network returns; the server keeps append-only history with
  revisions, and a stale background tab can never override a deliberate
  rewind.

### Deployment

- Library folders are mounted **read-only**. The alignment folder is the only
  thing ReadPort writes to, and only through one module.
- Optional header-based SSO from Authentik, Authelia or oauth2-proxy, trusted
  only from the proxy's own address.
- A first-run wizard that tests the folders, checks ffmpeg, free space and
  permissions, creates the admin, and offers the model download; after that,
  invite links and three roles. No open sign-up.
