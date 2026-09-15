# Loss-resistant progress

Progress is local-first and uses exact locators. IndexedDB is the durable queue;
network availability is not a prerequisite for making a checkpoint. Browser
storage eviction, disabled storage and an OS kill without lifecycle delivery
remain platform limits, not guarantees of zero loss.

## Exact locators and capture

- Ebooks carry `spineIdx`, `sentenceId` (when the sentence index covers the text),
  and exact `charOffset`. Percentage is a display/index value, not a substitute
  for the text locator. Resume retains a supplied character offset inside a
  sentence; sentence start is only a fallback when no character offset exists.
- Audio carries `trackIdx`, `positionMs` and absolute `bookMs`.
- Reader page turns record checkpoints. User scrolling has a 600 ms checkpoint
  debounce; lifecycle capture bypasses that debounce and measures live geometry.
- During read-along, while following a playing narration, a 500 ms poll saves a
  changed ebook locator every three seconds. Both periodic and lifecycle capture
  read the live media-element clock and map it through the current cues, rather
  than depending on the last React `timeupdate` render. Detached reading follows
  the text position, not narration playing elsewhere.
- `visibilitychange` to hidden and `pagehide` capture the active surface
  synchronously. The exact event is put in the existing bounded emergency
  localStorage stash immediately, then enqueued in IndexedDB. A terminating tab
  cannot synchronously await an IndexedDB commit; on the next launch the stash is
  drained into the same idempotent queue. This is a last-gasp fallback, not a
  replacement of IndexedDB with localStorage.
- The standalone audio player retains its existing 15-second heartbeat and
  pause/exit checkpoints. The three-second exact text cadence is read-along.

## Offline queue and cross-device reconciliation

Each checkpoint has a UUID `eventId`, device and per-load session IDs, increasing
session `seq`, timestamp, explicit intent, canonical locator, `baseRevision`,
server-issued reset `generation`, and the `ownerId` it was captured for.
Events are written locally before network I/O. Sync runs when online, on its
timer, and on lifecycle events. The unload path is single-flight:
`visibilitychange` and `pagehide` together produce one keepalive single (the
live position) and one keepalive batch trimmed to 48 KiB, inside the browser's
64 KiB per-origin keepalive budget - a second capture within 1.5 s of the
first, at the same position, does nothing. Failed/offline sends leave queued
events.

The server transaction acknowledges every valid event independently, including
idempotent duplicates. Malformed events do not block the rest of a batch. The
response includes states and reset generations for every book touched, including
books whose state is null after reset. Acknowledged events leave the queue.

`resolveResume` combines cached server state and pending local events using the
same reconciliation policy as the server. A fresh device fetches server state;
a same-browser offline reopen uses IndexedDB and its unsent events. Both use the
same exact locator and landing path, including moves within one chapter.

Within a reset generation, the existing `decideApply` policy remains:

- Explicit open/seek/switch/finish claims the reading session. Observed server
  revisions provide causal ordering; client times and session sequence resolve
  otherwise concurrent intents. An explicit rewind is allowed.
- Heartbeats from a session that lost the claim cannot overwrite an explicit
  move from another device. Merely backgrounding or following narration is not
  permission to take another session's claim. `pause` IS explicit - the player
  pausing, or leaving the player, states a position deliberately.
- A visible surface whose heartbeats come back `recorded` with
  `unclaimed-session` - another device opened the book and took the claim -
  re-states its position once as an explicit `seek`, based on the revision the
  acknowledgement just told it about, and holds the claim again. A hidden tab
  stays a stale tab. Without this an hour of page turns after a phone glanced
  at the book was recorded and never applied.
- History records rejected ordinary events and reasons. Heartbeats older than
  30 days can be compacted; explicit intents remain until an explicit reset.

Queue ownership is account-bound, and enforced at three points rather than
assumed from one. Every event is stamped with the account it was captured
for, and the batch envelope names the owner it is delivered for; the server
answers `403 owner-mismatch` for a foreign envelope and `rejected` /
`owner-mismatch` for a stray event, and files nothing. The client delivers
only while a page has confirmed who is signed in: a tab left on the login
screen keeps its old owner's backlog but sends nothing, so a different person
signing in from another tab - the cookie being shared by the whole browser -
cannot have it filed under their name. Sign-out seals the queue until the next
sign-in, so a surface unmounting on the way to the login screen writes nothing
for the next person. Session revocation retains unsent work for the same
user's reauthentication; explicit sign-out or account replacement clears the
queue, emergency stash, cached progress and reset metadata. Content/download
caches have their separate ownership policy.

The envelope also carries the client's wall clock (`clientNow`). The server
measures the difference from its own and moves every event's effective time by
it (bounded to a day), so a device an hour slow does not lose every explicit
move it made offline to a device whose clock is right. Forward skew was
already clamped to two minutes; this closes the other side.

When IndexedDB itself is unavailable - some private windows, "block all site
data" - checkpoints live in memory for the page and the newest twenty are
mirrored into the localStorage stash, rather than the book refusing to open.
The reader is told once. Flushes back off exponentially (to five minutes) after
failures, and a 413 halves the batch until it goes through.

## Reading Now and reset contract

`filter=reading-now` (legacy alias `in-progress`) includes only the authenticated
user's unfinished progress with `0 < pct < 1`. Zero, absent, finished, 100% and
reset state is excluded. The automatic-shelf count uses the same predicate.

Each book/edition is independent. An ebook and its paired audiobook can both be
active, or only one. Resetting the selected ebook DOES NOT reset its audiobook,
and vice versa. The compact Reading Now rows provide resume and an explicit
confirmation explaining this contract.

`DELETE /api/progress/:bookId` transactionally deletes only that authenticated
user's selected-book event history and current progress/claim state. It advances
`progress_resets.generation` and returns that server-issued integer. It does not
accept a user ID or client timestamp for the reset, and it answers 404 for a
book the library has never had (a book that is merely missing from disk can
still be reset).

A live surface that is still writing under the generation it opened with is
told, once, that its progress was reset elsewhere - through the engine's
notice channel, shown as a toast with **Keep reading from here**, which resumes
under the new generation and records an explicit `open`. Every checkpoint it
made before pressing that is refused, as the barrier requires.

It never deletes the book, file, pair, alignment records, annotations (including
bookmarks/highlights/notes), shelf membership, reading-list membership, downloads,
or anyone else's progress. Downloads are browser-owned, not a server table.
The row is removed only after the server acknowledges the reset and the local
reset transaction succeeds; list and shelf counts refresh then. Failure/offline
keeps the row and reports that the reset could not be confirmed. A lost response
can mean the server reset succeeded; retry is safe and may advance generation
again.

### Reset ordering invariant

An event is eligible only if its captured generation equals the current
server-issued generation for `(authenticated user, book)`. Missing generations
on legacy events mean zero. Client timestamps, even arbitrarily far in the
future, CANNOT bypass this check. Old generations are rejected as `progress-reset`
before history insertion: replay cannot recreate deleted history or state.
Generation is monotonic for the lifetime of that user/book and is not removed
with ordinary progress. This replaces the unpublished client-clock reset barrier.

IndexedDB version 3 adds `progress-meta`. Reset metadata, cached state and stale
pending-event removal share one transaction. Event enqueue checks the generation
in a transaction sharing these stores. In either race order, an old event is
removed or refused. An old acknowledgement cannot overwrite a newer generation;
a repeated reset acknowledgement cannot delete new-generation work.

A live surface retains the generation it opened with. An acknowledgement or
background refresh does NOT silently upgrade it. A stale tab therefore cannot
recreate reset progress, even by generating new events after the reset. Explicit
reopening/resuming adopts the newly fetched/cached generation, and reading can
start again. A device that is offline and has never learned the reset can show its
old local progress until reconnect; its queued old-generation events will still
be refused. Old app builds must reload after a reset to send the new protocol.

## Resume marker

A temporary, accessible marker points at the exact resumed text range in both
paginated and scroll modes, whether the locator came from offline storage or the
server. It is separate from persistent annotations/highlights and uses reader
theme colors. Layout/resize/idle ticks do not fade it. Meaningful reading movement
progressively lowers opacity (after 80 characters, gone by 680 characters) or
removes it on chapter change. Reduced motion disables the transition. Dismissed
markers leave no DOM residue and are never persisted.

## Return affordance: complete caller policy

Return points are ephemeral React state. Each qualifying explicit jump replaces
rather than stacks the previous origin. Small/nonqualifying jumps clear stale
origins. Returning and manual close dismiss without creating another chip.

Reader callers:

| Caller                                                          | Classification | Return chip                |
| --------------------------------------------------------------- | -------------- | -------------------------- |
| Initial URL handoff, open, local/server resume                  | resume/open    | No                         |
| Background-device “Jump there”                                  | resume         | No; marks the resumed text |
| Next/previous page, chapter boundary, scroll “Next chapter”     | progression    | No                         |
| Narration cue follow, resume-follow, narration chapter crossing | narration      | No                         |
| Contents/TOC entry including fragment                           | toc            | If disorienting            |
| Search hit                                                      | search         | If disorienting            |
| Bookmark/highlight/note entry, mouse or keyboard                | bookmark       | If disorienting            |
| Reading-position slider                                         | slider         | If disorienting            |
| Internal link/footnote, same or another chapter                 | link           | If disorienting            |
| Return button                                                   | return         | No                         |

A reader jump is disorienting when it changes spine item or moves at least
1,000 characters within it, with a valid origin. Its label names the origin
chapter. Continuing at least 400 characters from the destination or leaving that
chapter dismisses it. Ordinary page/scroll progress drives this, not rendering.

Player callers use the same reason vocabulary: initial URL/open/resume, next/prev
chapter, keyboard/transport skip and Media Session next/prev/skip do not create
chips. Chapter-list selection and bookmarks are explicit TOC/bookmark jumps;
scrubber pointer/keyboard input and Media Session absolute seek are slider jumps.
Explicit moves over 90 seconds create a “Back to <time>” chip. Listening 30 seconds
away from the destination, returning, or manual dismissal clears it. Dismiss is
a separate keyboard-accessible button, not a nested clickable span.

## Focused verification

Server suites cover shelf filtering/counts, selected-edition reset, non-empty
retention fixtures, other-user isolation, future-clock replay, concurrent resets,
reopening and exact locator reconciliation. Web suites cover engine ownership,
reset generations, pending-event filtering, exact landing, checkpoint cadence,
marker lifecycle and reader/player return policies.

Browser scripts (pass the local Vite URL as argument):

- `scripts/qa-reading-now.mjs`: phone/iPad rows, confirm/cancel, offline failure,
  acknowledged removal.
- `scripts/qa-reading-continuity.mjs`: phone/iPad paginated/scroll exact marker and
  return behavior, reduced motion, real lifecycle capture, offline IndexedDB
  reload/replay and live-clock periodic/immediate read-along capture.
- `scripts/qa-progress-reset.mjs`: real two-tab IndexedDB races, stale live seek,
  delayed ack, offline reopen and both transaction orderings.
- `scripts/qa-player-continuity.mjs`: phone/iPad player caller policies and dismissal.

Browser API/media fixtures make these deterministic. They do not substitute for
physical Safari/iPad testing or a multi-host production deployment test.
