# HTTP API

All endpoints are same-origin JSON under `/api`, authenticated by session
cookie except where noted. Mutating requests require the `x-rp-csrf: 1`
header. Schemas are zod-validated; canonical types live in
`shared/src` (`@readport/shared`). A role named below is a floor rather than
an exact match - roles rank reader, curator, admin, and anything a curator may
do an admin may do too.

## Agent access (read-only API keys)

A key lets something else - an assistant, a script, a home agent - see a
person's library, lists and progress without being able to change any of it.

    curl -H 'Authorization: Bearer rp_a1b2c3d4_...' https://readport.example/api/agent/v1/books

Keys are created in Settings -> Agent access, or with a session:

| Method | Path            | Notes                                                  |
| ------ | --------------- | ------------------------------------------------------ |
| GET    | `/api/keys`     | the caller's own keys (never the secret)               |
| POST   | `/api/keys`     | `{name}`; returns `{key}` ONCE - only a hash is stored |
| DELETE | `/api/keys/:id` | revoke; takes effect on the next request               |

**What a key may do.** Only the explicitly listed `GET /api/agent/v1` routes
below. Every key has the fixed `agent:read` scope; there are no configurable
grants or write scopes. Account roles and export permissions cannot widen it.
The global hook checks credentials and the closed route catalog before public
routes, CSRF, static assets or fallback handling. Existing clients using legacy
API paths with keys must migrate to v1. Browser session APIs are unchanged.

| Path relative to `/api/agent/v1` | Response                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| (base path)                      | version, authentication, read-only capabilities, routes, limits and JSON schemas                  |
| `/me`                            | `{user: {id, username, displayName}, scopes}`                                                     |
| `/books`                         | paginated safe book metadata; optional literal `query` search across title/author/series          |
| `/books/:id`                     | `{book}` including nullable aggregate `alignment: {coverage, meanConfidence}`                     |
| `/shelves`                       | paginated own shelves                                                                             |
| `/shelves/:id/books`             | paginated safe books, in shelf order; non-owned shelf is 404                                      |
| `/reading-list`                  | paginated `{bookId, addedAt}` items in queue order                                                |
| `/annotations`                   | paginated own non-deleted marks, canonical locator and bounded authored note, never selected text |
| `/books/:id/progress`            | `{progress}` or null; bookId, canonical locator, finished, updatedAt                              |
| `/books/:id/history`             | paginated own positions with occurredAt, receivedAt and applied                                   |

Lists return `{items, nextOffset}`. `nextOffset: null` means no further row in
that query. `limit` defaults to 50 (1–100); `offset` defaults to 0 (0–100000).
Both accept decimal integers only. Search is at most 200 characters. Unknown
or repeated query parameters are rejected with 400, including tenant/scope
overrides. All ordering has a stable ID tie-breaker; offset pagination is not
a snapshot across concurrent library changes. Missing books are excluded.
Books are shared library data; shelves, annotations, queue and progress are
always scoped to the key owner in SQL.

There are no content, export, cover, chapter, asset, track, job or filesystem
endpoints. DTOs omit infrastructure, errors, raw metadata, device/session IDs,
event IDs and excerpt text. Position JSON is validated and stripped to the
canonical ebook/audio locator schema; malformed/oversized positions are null,
not guessed. Sentence IDs must be opaque `s`-prefixed identifiers, not paths.
Metadata text is bounded to 500 characters, authored notes to 2000 with an
explicit `noteTruncated` flag. Responses over 1 MiB return 413; request a smaller
page. URLs are limited to 2048 characters and GET request bodies are refused.

Every response uses `Cache-Control: no-store`. A dedicated atomic SQLite
counter permits 120 allowlisted requests per minute per owner, shared across
keys and server processes, separate from browser login limits. Exhaustion is
429 with a measured `Retry-After`. Invalid credentials remain 401; valid
credentials on forbidden routes/methods remain 403, even when the read budget
is exhausted - up to 300 such refusals per minute per client address, after
which that address is answered 429 until the minute turns. The address is only
a cost bound, never an identity. A `nextOffset` that the route would refuse
(past 100,000) is reported as `null`.
API reads do not update reading state, history, annotations or queues. Only
security bookkeeping changes: rate counters and the existing at-most-once-per-
minute key last-used timestamp. Structured `agent-api` audit logs record verified
key/user IDs, catalog route templates and status, never credentials, query
strings or content. Operators control log retention through normal server logs.

Every non-GET (including HEAD/OPTIONS), unknown agent route, encoded path alias
and every legacy/public/future/non-agent path is denied with
`403 {"error":"read-only"}`. Malformed, duplicate, invalid or revoked
Authorization gets 401 even on public/static paths and never falls back to a
cookie or proxy identity. Disabled owners' keys stop working on the next request.
The agent API requires a key; sessions remain for the ordinary browser API.

## Auth & setup

| Method | Path                    | Notes                                                                                     |
| ------ | ----------------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/api/health`           | public; liveness - `{status, version, time}`                                              |
| GET    | `/api/setup/status`     | public; `{needsSetup, setupTokenRequired, libraries, languages, defaultLanguage}`         |
| POST   | `/api/setup/verify`     | public until first user exists; checks `RP_SETUP_TOKEN` when one is set, else `{ok:true}` |
| POST   | `/api/setup/test-paths` | admin; before setup, `x-rp-setup-token` if locked, else open; `{paths, kind?}`            |
| GET    | `/api/setup/browse`     | admin; before setup, `x-rp-setup-token` if locked, else open; folder picker               |
| POST   | `/api/setup`            | public until first user exists; creates admin (+ folders, language), starts the scan      |
| POST   | `/api/auth/login`       | rate limited; `403 account-disabled` for disabled accounts                                |
| POST   | `/api/auth/logout`      |                                                                                           |
| GET    | `/api/auth/me`          | `{user, via, needsLibraries, librariesEnvPinned, locale}`                                 |
| PATCH  | `/api/auth/me`          | own display name                                                                          |
| POST   | `/api/auth/password`    | own password (current + new); revokes other sessions                                      |

`libraries` in the status payload covers all three folder lists - `ebookDirs`,
`audiobookDirs` and `alignmentDirs` - each with a flag saying whether an
environment variable has pinned it, because the wizard shows a pinned folder
rather than offering to edit it. `test-paths` takes the same `kind` vocabulary:
an `alignment` folder is checked for writability as well as for readability,
by actually writing, since a bind mount can report the permission bits and
still refuse.

`GET /api/auth/me` answers one question the login response cannot: whether an
admin still has setup to finish. Behind reverse-proxy SSO the first account is
provisioned automatically and never sees the first-run screen, so
`needsLibraries` is how the client knows to resume the wizard at the Libraries
step.

## People (admin)

| Method | Path                                 | Notes                                                               |
| ------ | ------------------------------------ | ------------------------------------------------------------------- |
| GET    | `/api/users`                         | accounts + pending invites                                          |
| POST   | `/api/users`                         | `{username, password, role, displayName?}`                          |
| PATCH  | `/api/users/:id`                     | `{role?, status?, displayName?, password?}`; last-admin/self guards |
| POST   | `/api/users/:id/sign-out-everywhere` |                                                                     |
| DELETE | `/api/users/:id`                     | removes the account and its personal data                           |
| POST   | `/api/invites`                       | `{role, displayName?, username?, expiresInDays}` → one-time link    |
| DELETE | `/api/invites/:id`                   | revoke                                                              |
| GET    | `/api/invites/:token`                | public, rate limited; what the link offers                          |
| POST   | `/api/invites/:token/accept`         | public; `{username, password, displayName?}` → account + session    |

## Library & books

| Method | Path                                  | Notes                                           |
| ------ | ------------------------------------- | ----------------------------------------------- |
| GET    | `/api/library?query&kind&filter&sort` | `{books, continueRail, scanActive}`             |
| GET    | `/api/library?collapse=none`          | both halves of every pair, for the device shelf |
| POST   | `/api/books/:id/language`             | curator; `{language}` or `{language: null}`     |
| GET    | `/api/library?filter=both-formats`    | one row per paired title (see Shelves)          |
| GET    | `/api/library?filter=recently-added`  | arrivals of the last 30 days, capped at 60      |
| GET    | `/api/library?facet=kind:value`       | one grouping the library itself carries         |
| GET    | `/api/facets`                         | every grouping this library supports, counted   |
| POST   | `/api/library/rescan`                 | admin                                           |
| GET    | `/api/library/roots`                  | admin; the configured read-only roots           |
| GET    | `/api/books/:id`                      | detail: chapters, tracks, pair, progress        |
| GET    | `/api/books/:id/cover`                | image                                           |
| GET    | `/api/books/:id/manifest`             | ebook derived manifest (spine/toc/pct math)     |
| GET    | `/api/books/:id/chapter/:idx`         | sanitized chapter HTML fragment                 |
| GET    | `/api/books/:id/sentences/:idx`       | sentence index (ids + char offsets)             |
| GET    | `/api/books/:id/asset/*`              | sanitized-referenced images only                |
| GET    | `/api/books/:id/search?q`             | in-book text search                             |
| GET    | `/api/books/:id/track/:idx`           | audio stream, HTTP Range                        |
| GET    | `/api/books/:id/offline-manifest`     | URLs + sizes + integrity for the PWA download   |
| GET    | `/api/books/:id/offline-switch`       | precomputed switch answers for that download    |

A book summary carries `pair`, and a pair carries both `switchable` and
`handoff`. They are not the same claim: `switchable` means a handoff is
available at all, while `handoff` reports the honest numbers behind it -
`coverage`, `meanConfidence` and `exactSentenceCoverage`. A client that shows
one without the other will over-promise.

The offline package is a list of URLs with sizes, and for audio a
`sourceVersion` plus a SHA-256 per 8 MiB chunk, so a download that silently
lost bytes is caught rather than cached. `offline-switch` is in that list
because a downloaded pair that can be read and listened to but not switched
between is missing the one thing owning both editions is for. It is a table of
precomputed answers rather than a copy of the alignment: for an audiobook it is
sampled on a five-second grid, and the client always takes the entry at or
before its position, so the rounding can only ever land the reader earlier in
the text - the same direction the resolver's own margin errs in.

## Progress & annotations

| Method       | Path                            | Notes                                                                                             |
| ------------ | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| POST         | `/api/progress/events`          | idempotent batch; returns per-event ack + reconciled state                                        |
| GET          | `/api/progress/:bookId`         | current state + reset generation                                                                  |
| GET          | `/api/progress/:bookId/history` | recent events incl. rejected + reasons                                                            |
| DELETE       | `/api/progress/:bookId`         | reset this user's progress for one edition → `{generation}`; 404 for a book the library never had |
| GET          | `/api/annotations?q&kind`       | every mark this reader has made, across every book                                                |
| GET/POST     | `/api/books/:id/annotations`    | bookmarks/highlights/notes                                                                        |
| PATCH/DELETE | `/api/annotations/:annId`       | own marks only; `PATCH` takes `{note?, color?}`                                                   |

A batch of progress events is a drained offline queue, not a form. Refusing all
two hundred because one is malformed would lose the other hundred and
ninety-nine and leave the client resending the same slice forever, so each bad
event comes back named and rejected instead - a durable verdict the client can
act on by dropping it.

The envelope is `{events, ownerId?, clientNow?}`. `ownerId` is the account
the queue was captured for: a mismatch with the session is `403
owner-mismatch` and nothing in the batch is filed; a single event stamped for
somebody else comes back `rejected` / `owner-mismatch`. `clientNow` is the
device's wall clock at send time; the server corrects every event's effective
time by the measured skew (bounded to a day) before judging it, so a slow
clock does not lose its owner's offline moves. Results are `applied` (moved
the state), `recorded` (kept in history but did not move it, with a `reason`
such as `unclaimed-session` or `stale-explicit`; `progress-reset` is answered
without a history row), `duplicate`, or `rejected` (drop it).

`GET /api/annotations` exists separately from the per-book list because it
answers a different question: not "what did I mark in this book" but "where was
that thing I wrote down". So it joins the book in and returns `bookTitle` and
`bookAuthor` alongside each mark, orders newest first, and caps at 500. `q`
matches the note, the highlighted text or the book title; `kind` narrows to
`highlight`, `note` or `bookmark`. This is what the Notes & marks page reads.

A highlight's colour is a short lowercase word, not a hex value, so the reader
can restyle the palette without rewriting anyone's marks. `PATCH` is how a
colour is changed after the fact and how a note gets its text. Deletes are
soft: the row is tombstoned rather than removed.

## Reading statistics

| Method | Path                 | Notes                                                                 |
| ------ | -------------------- | --------------------------------------------------------------------- |
| GET    | `/api/stats?days=90` | own sittings in the window, the books they name, whole-history totals |

The stats page draws from `reading_sessions`, a diary the progress pipeline
keeps beside the position: every event it applies is folded, in the same
transaction, into a **session** - one sitting with one book on one device in
one medium (`ebook` or `audio`). An event within ten minutes of the sitting's
last one extends it; anything later begins a new one, because a reader who
put the book down for lunch has ended a sitting. Time (`seconds`) is the
sitting's steps added up, each step counted only up to what it can plausibly
hold: an ebook records a checkpoint when the position moves and nothing while
one page stays on screen, so a step is time on one page and counts five
minutes at most - a device left open on a page and picked up again inside
the gap counts five minutes, not nine; audio checkpoints arrive every fifteen
seconds while the narration plays and stop when it pauses, so a step longer
than twenty seconds is a pause and counts twenty. Sittings recorded before
this rule existed are measured by the clock, from first event to last, and
say so with a null `active_ms` in the table. Distance (`pctAdvanced`) is the
sum of forward movement only, so re-reading a page is time spent and not ground
covered - and only forward movement at a pace a person reads at (nine percent
of a book a minute, with a two-percent floor for a page turned a moment after
the last event), so a chapter picked from the contents or a highlight jumped
to moves the position without counting as reading.

A step **back** of a page or two is a re-read, and a sitting counts them
(`rereads`) with the ground they went back over (`rereadPct`): the eye reached
the foot of a page and the sense had not come with it, so back it went. The
fold only has the position as a share of the book, so "a page or two" is two
percent of an ebook - a page of the shortest book, a few pages of a novel,
short of any chapter - and one and a half percent of an audiobook, three
minutes of a three-hour one, which covers the fifteen-second skip-back button
tapped a few times in a row. A step back smaller than a twentieth of a percent
is jitter (a scroll settling, a re-layout) and is not counted; a step back
further than the limit is navigation - a chapter picked from the contents, a
bookmark followed, a jump to the start - and says nothing about how the
reading went, so it is not counted either. Re-reading is also how careful
readers read: the count is offered as a signal of how well a sitting held the
thread, not as a verdict. `pctAdvanced` is unchanged by any of this - going
back is still time spent and not ground covered. Sittings from before the
counters existed carry zeros.

Resetting a book's progress deletes its position and its history but
never its sessions - having read is not the same as where one is. At every
start the diary is derived, with the same rule, from whatever progress
history it does not cover yet: on a first start that is everything a library
already has, and after an upgrade that changes the rule the recent sittings
are cleared and derived again from the history that still holds their every
heartbeat.

The answer is `{generatedAt, since, sessions, truncated?, books, allTime}`.
`days` is 1–365 and defaults to 90; `since` is 00:00 UTC on the day `days`
days before `generatedAt`, and a session is in the window when it ended at or
after `since`. `sessions` come newest first, each
`{id, bookId, medium, deviceId, startedAt, endedAt, seconds, pctStart, pctEnd, pctAdvanced, rereads, rereadPct}`,
and at most 3000 of them: past that the newest are kept and `truncated: true`
says so. Timestamps are UTC and there are no hour-of-day or weekday fields on
purpose - only the browser knows the reader's timezone, so streaks and the
hour a person reads at are the client's arithmetic.

`books` has one entry per book the sessions name, keyed by id:
`{id, title, author, kind, totalChars, durationMs, pct, finished, finishedAt, lastReadAt}`,
joined from the library and from the caller's own progress. A book that has
since left the library still gets an entry, with `title: null` and the medium
it was read in as its `kind`. `totalChars` is the ebook's indexed text length

- the figure the reader's manifest is built on - and `null` until the book has
  been indexed; `durationMs` is the audiobook's length. `pct` is the current
  position, 0 when there is none. `finishedAt` is the time of the finishing
  event while the history still holds it, else the time the state was last
  written; `lastReadAt` is the end of the latest session with that book, in any
  window.

`allTime` is `{seconds, sessions, firstSessionAt, booksFinished, rereads}`
over the whole diary regardless of `days`; `booksFinished` counts every
edition the caller has finished, whether or not its file is still on disk, and
`rereads` is every step back of a page or two the diary holds.

## Friends

Everyone on a server already shares one library; a friendship is consent to
see each other's place in it, and to have a book put in front of you. All of
this is per account and behind `requireUser`; an admin has no extra reach.

| Method | Path                                | Notes                                                                   |
| ------ | ----------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/api/friends`                      | `{friends, incoming, outgoing, people}`                                 |
| POST   | `/api/friends/requests`             | `{userId}`; 201 pending, or 200 accepted when they had already asked    |
| POST   | `/api/friends/requests/:id/accept`  | the person asked                                                        |
| POST   | `/api/friends/requests/:id/decline` | the person asked declines, or the asker takes it back                   |
| DELETE | `/api/friends/:userId`              | either side                                                             |
| GET    | `/api/friends/progress?bookId=`     | friends with a place in this book (or a linked edition of it)           |
| POST   | `/api/friends/recommend`            | `{toUserId, bookId, note?}` to a friend; 409 while one is still waiting |
| GET    | `/api/friends/inbox`                | recommendations to you, undismissed, newest first                       |
| POST   | `/api/friends/inbox/:id/seen`       | and `/dismiss`, which also marks seen                                   |
| GET    | `/api/friends/sent`                 | what you recommended, and whether it was seen                           |
| GET    | `/api/prefs/friends`                | `{friends: {shareProgress, colours, shown}}`; `PUT` the whole document  |

`friends[]` are `{userId, username, displayName, friendshipId, since, colour,
sharesProgress, reading}`, where `reading` is the book they touched most
recently and have not finished (`{bookId, title, kind, pct, updatedAt}`) or
`null`; `people[]` are the other active accounts you have no row with.
`/api/friends/progress` returns `{friends: [{userId, username, displayName,
colour, locator, pct, finished, updatedAt, chapterTitle}], friendCount}`,
furthest along first. A linked pair counts as one work: a friend listening to
the audiobook edition is in the ebook you are reading, at the edition they
touched last. Two absences are deliberate and reported as nothing at all,
never as a 403: someone who is not an accepted friend, and a friend whose
`shareProgress` is off. Nothing written in the margins is ever shared.

Colours are the viewer's: `colours` maps a friend's id to one of the six
palette names in `@readport/shared` (`plum`, `sky`, `moss`, `rose`, `amber`,
`sand`); until one is chosen a friend is dealt a colour in the order the
friendships were made. `shown` maps a book id to the friends drawn on its
progress bar; a book with no entry draws everyone. `/api/auth/me` carries
`friendRequests` (pending, incoming) and `recommendations` (unseen) so the
shell can mark the tab.

## Connected apps

| Method | Path        | Notes                                                        |
| ------ | ----------- | ------------------------------------------------------------ |
| GET    | `/api/apps` | `{apps: [{id, kind, name, url}]}` for everyone on the server |

The list is the `apps` field of the settings document (admin, `PUT
/api/settings`): at most twelve entries, `kind` one of `cwa`, `abs`,
`shelfmark`, `readmeabook`, `kavita` or `custom`, `url` http(s). They are links
and nothing more; no request is ever made to them from the server.

## Browsing by the library's own metadata

`GET /api/facets` answers what _this_ library can be browsed by, computed from
the books rather than configured: Calibre tags (`dc:subject`), audiobook genre
tags, narrators (`narrator`, else `composer`), publishers, years, Calibre
ratings, plus the author, series and language already on the book row. Each
group carries its values and how many books hold each.

Two rules are enforced here rather than in the client:

- a grouping with fewer than two distinct values is not returned at all - one
  publisher is not a way to browse anything;
- books the scanner has marked `missing` are excluded throughout, so a genre
  never leads to an empty grid.

Counts are of **rows, not titles**: a paired book shows up as an ebook and an
audiobook, so a genre both sides carry counts two, which is exactly how many
cards `?facet=` then returns. A count that did not match its own list would be
the worse lie.

Values are grouped case- and whitespace-insensitively (`Science Fiction` and
`science fiction` are one), and one spelling is chosen to display; filtering
matches on the same fold. The filter's wire form is `kind:value`, split at the
_first_ colon only, so `series:Harborlight: Book Two` works.

Author, series and language are read from the `books` columns; everything else
comes from `book_facets`, rebuilt inside the same transaction that writes a
book's metadata. Nothing is ever written back to the library's files.

| Method | Path                                | Notes                                                             |
| ------ | ----------------------------------- | ----------------------------------------------------------------- |
| GET    | `/api/facets`                       | `{groups: [{kind, label, values: [{value, label, count}]}]}`      |
| GET    | `/api/facets?query&kind&filter&ids` | the same, counted over that narrowing only                        |
| GET    | `/api/prefs/sidebar`                | `{sidebar: {facets, chosen}}`; `chosen:false` = never set         |
| PUT    | `/api/prefs/sidebar`                | `{facets, chosen}`; per account, deduped, order preserved         |
| GET    | `/api/prefs/locale`                 | `{locale}`: the interface language this account chose, or null    |
| PUT    | `/api/prefs/locale`                 | `{locale}` from the supported list, or null to follow the browser |

`continueRail` is a list of whole book summaries - the eight most recently
touched, unfinished editions - computed from progress rather than from the
list above it, because the list above it answers a different question. It is
collapsed to one card per settled pair like every other shelf, and the
edition that survives is the one touched most recently, so the card resumes
where the reader actually is rather than at page one of the other format. It
is filled only for the open library (no query, kind, filter or facet).

A facet narrows EDITIONS, before a pair collapses to one card, so a French
audiobook paired with an English ebook is under `language:fr`. The language
facet takes several values joined with `+` - `language:fr+de+unknown` - and
`unknown` is the books with no language at all. Counts from `/api/facets`
without parameters describe the whole library and keep the two-values rule;
with `query`, `kind`, `filter` or a comma-separated `ids` list (at most 400)
they describe that view, one-value groups included, so the client lays them
over the library's own group list.

A book's `language` comes with a `languageSource`: `manual` (a curator's
override, which no rescan touches), `metadata` (the file's own tag), `pair`
(the other, verified edition of the same book - confirmed, or an automatic
pair with an alignment - lending its answer), `detected` (the ebook's prose),
or null. `POST /api/books/:id/language` sets or clears the override and
recomputes both books of any pair the book is in.

Which groups appear is per person, not per server: two people share every book
and no furniture. An empty `facets` with `chosen:true` means "show none" and is
honoured; `chosen:false` means the defaults apply, and those adapt - a library
with no genres and no series gets the first two groupings it does support
rather than an empty section.

## Shelves & reading list

Personal furniture, one set per account. Not gated on role - the guard is
ownership: every statement is scoped `WHERE user_id = ?`, every shelf
sub-resource resolves through one owned-shelf lookup, and a miss answers 404
rather than 403 so a shelf id cannot be probed. Ordering uses a fractional
TEXT rank minted only on the server (`server/src/util/rank.ts`), so a move
writes exactly one row; the client sends the gesture (`afterBookId`), never a
key, and a neighbour that moved underneath answers `409 stale-order`.

| Method | Path                                      | Notes                                                                              |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| GET    | `/api/shelves`                            | the whole sidebar: automatic counts, own shelves, queue count + what is next       |
| POST   | `/api/shelves`                            | `{name}`; `409 shelf-name-taken` (case-insensitive), `409 too-many-shelves`        |
| PATCH  | `/api/shelves/:id`                        | `{name?, afterShelfId?}` - an ABSENT `afterShelfId` means "do not move"            |
| DELETE | `/api/shelves/:id`                        | removes the shelf and its membership; no book, no file                             |
| GET    | `/api/shelves/:id/books?sort=`            | `manual` (default) \| `title` \| `author` \| `added`; + `missingCount`             |
| PUT    | `/api/shelves/:id/books/:bookId`          | idempotent add → `{added, count}`; optional `{afterBookId}`                        |
| POST   | `/api/shelves/:id/books`                  | `{bookIds: []}` up to 200 in one transaction → `{added, skipped}`                  |
| DELETE | `/api/shelves/:id/books/:bookId`          | `{removed, count}`                                                                 |
| PATCH  | `/api/shelves/:id/books/:bookId/position` | `{afterBookId}`; null = first                                                      |
| GET    | `/api/reading-list`                       | queue order, with notes; missing books reported not hidden                         |
| PUT    | `/api/reading-list/:bookId`               | queue or re-place; `{position?, afterBookId?, note?}` → `{added, moved, position}` |
| PATCH  | `/api/reading-list/:bookId`               | `{note}` - a note belongs to a place in the queue, not to a book                   |
| PATCH  | `/api/reading-list/:bookId/position`      | `{afterBookId}`; null = first                                                      |
| DELETE | `/api/reading-list/:bookId`               | `{removed}`                                                                        |
| GET    | `/api/books/:id/shelves`                  | `{shelfIds, onReadingList, readingListPosition}` for the book page                 |

The automatic shelves are NOT endpoints of their own: `filter=reading-now` is
`in-progress`, and `both-formats`, `recently-added` and `unpaired` are three
more values on `GET /api/library?filter=`, so one code path still owns
filtering, sorting and the missing-book exclusion. `both-formats` keeps one
row per pair (the ebook side, or the audio side when the ebook is missing),
because a title owned twice is one title.

The PROGRESS shelves collapse a settled pair too, and there the surviving row
is the edition touched most recently rather than the ebook - a row that
resumed at page one of an untouched ebook, while the reader was half way
through the narration, was the whole complaint. The row it keeps carries
`pair.otherProgress`, so a single card can still name the position it is not
showing; a title finished in one format and under way in the other therefore
appears once on Finished and once on Reading Now, and never twice on either.
`kind=ebook` or `kind=audio` suppresses the collapse, because a question
about editions deserves an answer about editions.

`filter=unpaired` returns only books that belong to no settled pair, which is
what the manual linking sheet offers. A `candidate` does not count as paired:
an unreviewed guess is exactly what somebody opens that sheet to correct. "On this device" has no endpoint at all - downloads live
in one browser and only that browser can count them.

`PUT /api/reading-list/:bookId` with a `position` or an `afterBookId` MOVES a
book that is already queued; with an empty body it only queues one that is
not. "Read next" has to mean the front of the queue even for a book sitting
seventh, or the button is describing something other than what it does. Every
`position` reported back - here and in `readingListPosition` - counts the list
the reader can actually open, so a queued book on an unmounted drive holds its
rank without pushing the visible numbers along.

## Pairing & alignment

| Method | Path                                             | Notes                                                                                            |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| GET    | `/api/pairs`                                     | `{pairs, summary}` - evidence, compat, handoff, last job                                         |
| GET    | `/api/pairs/:id` / `/api/pairs/:id/alignment`    | detail; per-minute confidence                                                                    |
| POST   | `/api/pairs/link`                                | curator; manual link `{ebookId, audioId}`                                                        |
| POST   | `/api/pairs/:id/confirm` \| `reject` \| `unlink` | curator; decisions are durable                                                                   |
| POST   | `/api/pairs/:id/language`                        | curator; `{language}` or `{language: null}` to clear                                             |
| POST   | `/api/pairs/:id/align`                           | curator; queue this pair → `{jobId, queued}`                                                     |
| POST   | `/api/pairs/align-many`                          | curator; `{pairIds: []}` → `{queued, skipped}`                                                   |
| POST   | `/api/pairs/:id/resolve`                         | `{from: Locator}` → `{to, resolution}` - the two-way switch                                      |
| GET    | `/api/pairs/:id/segments/:spineIdx`              | one chapter's timings - what read-along reads                                                    |
| GET    | `/api/pairs/:id/chapters`                        | `{chapters: [{spineIdx, firstMs, lastMs, segments}]}` - where each chapter sits in the narration |

Each pair reports its `language` as three values rather than one, because the
useful thing to show is not just the answer but where it came from: `override`
is what a curator set here, `detected` is what the alignment settled on, and
`effective` is the one that will actually be used, with `source` naming the
step that supplied it (`override`, `alignment`, `ebook-metadata`, `audio-tags`
or `unknown`). Posting to `/language` sets the override; posting `null` removes
it and lets detection speak again.

`/align` always sets `force`, because a person asking for a specific book
should get it even on a server configured to match and wait. Both it and
`align-many` are ordinary queued jobs, deduplicated per pair, so the same lane
and the same live progress apply; `queued: false` means one was already
waiting, not that anything failed.

`summary` on `GET /api/pairs` describes exactly what a "Start all" would queue -
linked pairs with no alignment and nothing already in the queue - as
`pendingPairs` and `pendingAudioMs`, with `candidatePairs` counting suggestions
still awaiting a decision. `speedRatio` is seconds of audio per second of wall
clock, measured from real runs on this machine; while it is `0` there has been
no run to measure and `estimatedMs` is `null` rather than a guess.

`/resolve` returns `{to: null}` with a `resolution` explaining why when the pair
has not been aligned yet, `409 not-linked` when the pair is a rejected or
unconfirmed suggestion, and `409 ebook-not-indexed` when the derived index is
missing. The resolution's `confidence` and `granularity` are what the reader
uses to decide how far to rewind before playing.

## Portable alignments

| Method | Path                     | Notes                                          |
| ------ | ------------------------ | ---------------------------------------------- |
| POST   | `/api/alignments/import` | admin; queues `import-alignments` → `{queued}` |
| POST   | `/api/alignments/export` | admin; queues `export-alignments` → `{queued}` |

Finished alignments live as files in a folder the operator mounts from their
own library, which is the only place ReadPort writes. Both jobs run by
themselves - import after every scan, export when an alignment finishes - so
these two routes are for the operator who has just mounted another folder and
does not want to wait for the next scan. Both are deduplicated, so pressing the
button twice queues one job.

Where those files are, and whether they can be written, is reported by
`GET /api/settings` under `alignments`: `{dirs, writeDir, files, bytes,
problem}`. `writeDir` is the first folder that accepted a test write, and
`problem` is a sentence to show the operator when none of them did - alignments
then fall back to the data directory, so nothing is lost, but they stop being
portable until the mount is fixed.

## Preflight

| Method | Path             | Notes                                                                                     |
| ------ | ---------------- | ----------------------------------------------------------------------------------------- |
| POST   | `/api/preflight` | admin; before setup, `x-rp-setup-token` if locked, else open; "can this container align?" |

Read-only: it probes binaries with `-version`, stats directories and asks the
catalog what is on disk. Nothing is written, downloaded or enqueued. It is a
POST because the setup wizard checks the folders the operator is _about_ to
save, which are not in the settings yet and must not travel in a query
string; with no body it checks the roots the server would use today.
`GET /api/health` remains the machine-readable liveness probe.

The response is `{ok, checks[], modelsDir, aligner}`. Each check is
`{id, label, state: 'ok'|'warn'|'fail', detail, fix?}` with a concrete
`detail` (a version, a path, a byte count) and a `fix` whenever the state is
not `ok`. `ok` is true when no check failed - a `warn` does not sink it. The
checks are `audio-tools` (ffmpeg/ffprobe), `onnx-runtime` (the native module
actually loads on this CPU), `aligner-model`, `disk`, `writable`, `libraries`
and `alignments`. Two of them can only ever `warn`. A missing model is one:
everything else about the container is fine and the download is one click
away. An alignment folder that will not take a file is the other, and it is
the one people get wrong - every other library line in the stock compose file
ends in `:ro` - but a book still aligns without it, so the honest verdict is
that the timings will not survive the container, not that the container is
broken. `aligner`
summarises the catalog entry - id, label, `licence`, `note`, `sizeBytes` across
**all** its files, `installed`, live `download` state and `lastError`.

## The alignment model

| Method | Path                       | Notes                                                               |
| ------ | -------------------------- | ------------------------------------------------------------------- |
| GET    | `/api/models`              | `{modelsDir, alignerRuntime, models[], languages[]}`                |
| POST   | `/api/models/:id/download` | admin; queues a `model-download` job → `{queued, installed, jobId}` |
| DELETE | `/api/models/:id`          | admin; removes every artefact and any partial download              |

There is exactly one entry, `alignment-model`, and it covers every language:
it works on a romanized character stream rather than on words, so a Russian
audiobook costs it no more than an English one. The route keeps its plural
shape because the download machinery, the jobs list and the settings page all
want a list.

`alignerRuntime` is `{available, error?}` and answers a different question from
`installed`. The runtime is a native module, so a file on disk is not enough:
the settings page has to be able to tell "not downloaded" apart from
"downloaded, but this build cannot run it on this CPU".

`languages[]` is the shared language catalog (`code`, `label`, `native`). It
is not a list of things to download - the one model covers all of them - but
the set a client may offer as a default language or as a per-pair override,
and the set `POST /api/pairs/:id/language` validates against.

Each entry in `models[]` is the catalog's `ModelSpec`
(`server/src/alignment/model.ts` - `id`, `label`, `licence`, `url`, `file`,
`sizeBytes`, `extraFiles`, `note`) plus `installed`, `installedBytes`,
`download` (live job state or `null`) and `lastError`. `licence` is always
present and clients must display it before the download button: today's model
is `CC-BY-NC-4.0 (non-commercial)`.

**A model is a multi-file artefact.** `file` contains a subdirectory
(`mms-fa/model_int8.onnx`) and `extraFiles` carries the rest
(`mms-fa/vocab.json`, `mms-fa/config.json`). Consequences a client should know
about:

- `installed` is all-or-nothing: every file must exist and be at least 90% of
  its published size, so a truncated or partial download never reads as
  installed.
- The download job fetches the small companions first, then streams the large
  file to `<file>.part` with resumable HTTP Range and renames on completion -
  so a finished big file is never left without the metadata that makes it
  usable.
- `installedBytes` and `sizeBytes` describe the **primary file only**; the
  companions are kilobytes and are not counted. Preflight's `aligner.sizeBytes`
  counts all of them, which is why the two numbers differ slightly.
- `DELETE` removes every artefact and its `.part`, so nothing lingers on the
  volume after an uninstall.

`GET /api/models` also re-queues any alignment that was blocked on a
`model-missing` error, so a model dropped into `RP_MODELS_DIR` by hand or by
the `readport-model` CLI unblocks work without a restart. That error is
structured (`model-missing:<id>|<message>`) and surfaces on a pair as
`lastAlignJob.modelMissing`, which is what lets the Pairing page offer a
download button instead of a red error.

## Jobs & settings

| Method  | Path                              | Notes                                                                                 |
| ------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| GET     | `/api/jobs`                       | recent background jobs, with `subject` (pair/book/model) and live `progress`/`detail` |
| POST    | `/api/jobs/:id/cancel` \| `retry` | curator                                                                               |
| GET/PUT | `/api/settings`                   | admin to write; env-pinned keys are read-only                                         |

`GET /api/settings` returns more than the settings, because the settings page
is also the dashboard: `settings`, `envPinned` (the keys an environment
variable has taken over), `stats` (library, pairing and queue counts in one
round trip), `paths` (`dataDir`, `cacheDir`, `modelsDir` and the folder lists),
the `alignments` summary described above, and a one-line `precedence` string
saying which layer wins.

There are seven settings: `defaultLanguage`, `ebookDirs`, `audiobookDirs`,
`alignmentDirs`, `alignPrecision` (`standard` or `exact`), `autoAlign` and
`alignSpeedRatio`. The first four can be pinned by environment variables and
then appear in `envPinned`; the rest exist only here. One is readable but not
settable: `alignSpeedRatio` is written by the worker from real runs, so a
client that sends it is overwriting a measurement with a guess.

`PUT` persists only the keys the request actually contained. This is not
politeness: `settingsSchema.partial()` still fills in every `.default()`, so a
request that changes one checkbox arrives at the handler carrying a full
settings object, and writing all of it would silently reset the library
folders. Send a patch, and expect `{settings, envPinned}` back.

## Sharing

A share link is one person handing one book to someone, inside the house or
outside it. `/s/<token>` is the one place ReadPort answers a stranger with
something about a book - the teaser a link preview shows, and the page the
person lands on - and the way in for whoever follows it: sign in, or ask to
join and wait for an admin.

| Method | Path                             | Notes                                                                                        |
| ------ | -------------------------------- | -------------------------------------------------------------------------------------------- |
| POST   | `/api/books/:id/share`           | the caller's live share for this book, made on first ask → exactly `{url, token}`            |
| DELETE | `/api/share/:token`              | revoke; the creator or an admin. A miss is 404, never 403                                    |
| POST   | `/api/share/:token/add`          | the shared book onto the caller's reading list, credited to the sharer → `{added, bookId}`   |
| GET    | `/api/share/:token`              | public, rate limited; `{valid: true, book, sharedBy: {displayName}}` or `{valid: false}`     |
| POST   | `/api/share/:token/join`         | public, rate limited; `{email, name?, message?}` → 201 `{status: 'pending'}` (200 if it was) |
| GET    | `/api/share/:token/join?email=`  | public, rate limited; `{status: none \| pending \| approved \| declined, inviteToken?}`      |
| GET    | `/s/:token`                      | public; the app shell with the book's Open Graph tags in the head                            |
| GET    | `/s/:token/image.png`            | public; the 1200×630 link preview, cached an hour                                            |
| GET    | `/s/:token/cover`                | public; the cover on its own, for the share page's teaser                                    |
| GET    | `/api/join-requests`             | admin; pending requests first, then what was decided in the last 30 days                     |
| POST   | `/api/join-requests/:id/approve` | admin; mints a reader invitation (7 days, named after the request) → `{request}`             |
| POST   | `/api/join-requests/:id/decline` | admin → `{request}`; a decided request answers 409 `already-decided`                         |

The token is 24 random bytes as base64url and the whole credential; the
routes accept 22 to 64 URL-safe characters. `url` is built from the
`publicUrl` setting, or from the origin the request arrived on when that is
empty. Sharing a book twice gives the same link back until it is revoked;
revoking keeps the row, so the token stays dead rather than free for reuse.
A link stops answering when the book goes `missing` or the sharer's account
is disabled. `book` is `{id, title, author, kind, hasCover}` and `sharedBy`
carries a display name and nothing else - never the sharer's id or address.

`/s/:token` exists for the crawlers. WhatsApp, Telegram, Slack and iMessage
fetch a link with no cookies and no JavaScript, so the preview has to be in
the HTML: the built shell is served with `og:type` book, `og:title`,
`og:description` (`<author> · Shared with you on ReadPort`), `og:url`,
`og:image` (the absolute address of `image.png`, 1200×630) and a
`summary_large_image` Twitter card spliced in before `</head>`, every value
escaped, and the app's own static tags taken out. A dead token gets the shell
unchanged and the app says the link is no longer valid. The image is
composed as SVG and rasterised on the server with bundled fonts (Literata
for the title, Inter for the rest); a title in a script those cannot shape -
Hebrew, Arabic, CJK - is left off the picture rather than drawn as boxes,
since the cover and `og:title` carry it. The HTML answers `public,
max-age=300`, the image and the cover `public, max-age=3600` - the two
deliberate exceptions to the API's `private, no-store`.

Asking to join leaves an address, a name and a line to the admin. One open
request per address: asking again while one waits is the same `pending`
answer, and the address is normalised (trimmed, lower-cased) so a differently
cased second ask is the same ask. The status route answers only for a
request left through the link it is asked on, and `inviteToken` is present
only while the request is approved and its invitation still open - the code
the same link then accepts through `POST /api/invites/:token/accept`. The
invitation's code is derived from the request id under the session secret
and never stored in the clear; the admin routes never return it. A declined
request answers `declined`; asking again after that is allowed. Ask-to-join
is limited to 10 per address and 5 per email address in ten minutes, status
checks to 60 per address, and the page, picture and cover to 120 per address
a minute.

`/api/auth/me` for an admin carries `joinRequests`, the pending count, so
the shell can mark Settings → People. A book that lands on a reading list
through a share link or a friend's recommendation carries `recommendedBy:
{userId, displayName, at}` on `GET /api/reading-list`; `PUT
/api/reading-list/:bookId` takes an optional `recommendedBy` user id, which
must be another existing account, and a book already on the list keeps
whatever provenance it had.
