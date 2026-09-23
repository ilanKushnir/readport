# Reader and player: features and honest limitations

## Ebook reader (EPUB)

ReadPort renders its own **derived index** of each EPUB: the server parses
the container/OPF/spine/TOC, sanitizes every chapter, and extracts a stable
sentence index (content-derived sentence IDs + character offsets) that
anchors progress, annotations, search, and alignment. The source file is
never modified.

Derived indexes are immutable versioned directories: each (re-)index
attempt extracts into its own directory and a single atomic database
pointer switch makes it active, so the book stays readable throughout a
re-index. Old versions are garbage-collected lazily - retired at the
switch and deleted only after a conservative grace period - so a request
that resolved the previous version just before the switch still reads it
successfully.

Implemented:

- Paginated (CSS multi-column with swipe/tap/keyboard page turns) and
  continuous-scroll modes. Pages are centred in a capped page box; on wide
  screens the paginated mode shows a **two-page spread** (Auto / One page /
  Two pages), and the scroll mode ends every chapter with a "Next chapter"
  control.
- Table of contents (EPUB 3 nav with NCX fallback, including sub-chapter
  fragment entries), footnote and internal fragment links, in-book search
  that opens as a launcher's does - one field near the top of the page,
  the matches filling in as you type, Enter opening the first - a
  book-position slider, "N pages left in chapter".
- The bars. Above: back, contents (chapters and bookmarks as two tabs in
  the head of one sheet, opened on the chapter being read), type, and at
  the end of the bar, search drawn as the small field it opens. Below, one row in one order on every screen: a people
  button for the friends in the book, the progress bar with their beads,
  the percentage, and round buttons for Read along and Listen. The bar
  comes in three flavours (Reading settings → Progress bar): **Full**
  (slider, with the pages left under it), **Compact** (one thin line), or
  **Hidden**. It tracks live in scroll mode as well as page mode.
- Themes: Auto (follows the system appearance), Paper, Sepia, Night, High
  contrast - independent of the app theme; the iPhone status bar follows the
  reader theme in standalone mode. A page-dimming slider (screen brightness
  without leaving the app) sits next to the text-size stepper.
- Typography: Literata (bundled, OFL), Iowan Old Style, Charter, Palatino,
  Georgia, Baskerville (system faces with fallbacks), system sans; size
  stepper, variable weight, line height, margins, ragged/justified,
  hyphenation toggle. The chapter is tagged with the book's language so
  hyphenation and RTL fallback are language-aware.
- Every chapter closes with a printer's flower above the button to the
  next, drawn in the reading theme's own soft ink.
- In page mode a figure taller than the page is scaled to fit it, so a
  chapter with a full-page picture still pages. A chapter with something
  the columns cannot break at all scrolls instead, and says so in the
  footer.
- Bookmarks, highlights in five colours, and notes on text selections,
  anchored to sentence IDs/character offsets (rendered with the CSS Custom
  Highlight API; on browsers without it the annotations still save and list,
  they just are not painted in the text). How a mark is made, recoloured and
  found again has a section of its own below.
- A selection can run past the page. Turn the page with one held and a
  _Continue selection_ pill waits at the top corner the reading is heading
  for; tap it and the next tap ends the selection, across as many pages as
  it takes. A settled selection is framed by one outline in the theme's
  accent (Escape, or a tap elsewhere, drops it), and its menu is a pill of
  four icons, each with its name under it: highlight (the colours sit
  behind it), note, bookmark, and share - "Look
  what I read in {title}", the quotation whole on its own lines, and the
  book's share link, through the phone's share tray where there is one and
  to the clipboard where there is not. A tapped highlight offers its colour,
  a note, sharing and removal the same way. On a phone the platform's own
  edit menu is taken down once a selection settles; a tap on the selected
  words brings it back and ours steps aside, so one menu shows at a time.
  Only the text is selectable: a drag cannot run into the chrome.
- Progress with revision-checked sync, percent, page-within-chapter.
- RTL books (`page-progression-direction`, or inferred from a Hebrew /
  Arabic / Persian / Urdu language tag when the OPF declares no direction),
  tested with the bundled Hebrew sample: mirrored pagination, RTL columns,
  direction-aware arrow keys.
- Turning past the last page marks the book finished; a page turn after
  the tab regains focus re-claims progress for this device, and if another
  device has since read further a toast offers to jump there. The offer
  stays until it is taken or closed: the moment to decide is the end of the
  paragraph, not eight seconds from now.
- Hideable chrome, iPhone safe areas, reduced-motion support.
- Internal links navigate inside the book; external links open in a new tab
  with `rel=noopener`; images load from authenticated asset routes.

Known limitations (deliberate for V1, documented rather than half-built):

- **Publisher CSS is not applied.** Semantic structure (headings, emphasis,
  block quotes, tables, figures) is preserved and restyled by the reader's
  own typography. Heavily designed/fixed-layout EPUBs will look simplified.
- PDF, MOBI/AZW3, and comics are detected during scans but reported as
  unsupported instead of rendered badly.
- No dictionary popover yet; no reading ruler.
- Sentence-range highlights spanning chapter boundaries are not supported.
- The Notes & marks page returns the 500 most recent marks and does not page
  past them. A reader who has passed that will still find everything in the
  book it belongs to; only the cross-book view is truncated.

## Audiobook player

- Formats: m4b, m4a, mp3, flac, ogg, opus are **detected**; playability is
  browser-specific and checked honestly per title (`canPlayType`). When a
  browser cannot decode a format (Safari/iOS lacks Ogg/Opus containers;
  some open-source Firefox/Chromium builds lack AAC for m4b/m4a), Listen is
  disabled with an explanation instead of failing after the player opens.
  Playback uses the browser's native decoder with HTTP Range streaming.
- Multi-file books play as one continuous timeline (absolute position across
  tracks), with automatic track advance.
- Chapters from embedded m4b/mp3 metadata, or one chapter per file for
  multi-file books; chapter sheet with jump.
- Scrubber with chapter tick marks, elapsed/remaining, time left in the
  current chapter and a chapter progress line; previous/next chapter,
  configurable skip amounts (10, 15, 30, 45 or 60 s, set independently for
  each direction), play/pause, keyboard controls (space/j/k/l/arrows). The
  page takes an ambient tint from the cover.
- The skip buttons are drawn around their number rather than beside it: a ring
  with a gap at the top, an arrowhead on the end the arc travels towards so
  back and forward are exact mirrors, and the digits centred in the ring with
  no stroke crossing them. That last constraint is the reason for the shape.
  The transport draws these at 36 px, and a number sharing its space with the
  arrow's tail is simply not readable at that size; only a three-digit label
  shrinks to fit.
- Speed 0.5×–3× (fine slider plus presets) with pitch preserved
  (`preservesPitch`), remembered per book.
- Sleep timer: 15/30/45/60 minutes or end of chapter, extendable.
- Bookmarks: the ribbon button toggles a bookmark at the current instant
  (filled when the playhead is within 20 s of one); bookmarks appear as dots
  on the scrubber and in a sheet with jump and delete. Any jump of more than
  90 s (bookmark, chapter list, scrubber drag) leaves a **Back to m:ss** pill
  so the previous place is one tap away.
- The player is a fixed scene: it never scrolls, on iPad or anywhere else;
  the cover is the only element that gives way on short viewports.
- Media Session integration (lock-screen metadata, artwork, play/pause,
  seek, previous/next chapter, live position state) where the platform
  supports it.
- Durable checkpoints: every heartbeat/pause/seek is written to IndexedDB
  before sync; a killed tab loses at most a few seconds and never regresses
  another device's explicit position (see docs/progress.md).

## Marks: bookmarks, highlights, notes

In the reader the ribbon button bookmarks the first sentence on the current
page (or the passage at the top of the viewport in scroll mode), keeping a
short excerpt; the button fills and a ribbon hangs from the top edge while a
bookmarked page is shown, and tapping again removes it. A caret is joined to
the ribbon as one pill, because the two jobs are adjacent but not the same:
the ribbon marks this page, the caret opens everything already marked in this
book. It leads to Contents on its **Bookmarks & notes** tab, which lists
bookmarks, highlights and notes in book order with chapter, position and
excerpt, each with jump and delete. The caret exists only once there is
something behind it, so an unmarked book shows the ribbon on its own.

Selecting text offers five highlight colours - amber, rose, plum, sky and
sand - as five swatches, and picking one _is_ the act of highlighting: there
is no Highlight button to press first, so highlighting in a chosen colour is
one tap, the same as highlighting at all. They are muted tints of the app's own
warm palette rather than the saturated yellows most readers reach for, on the
grounds that a highlight has to leave the text under it legible; the night and
dark reader themes carry their own values for the three that would otherwise
glow. The colour is stored on the annotation, so it is the same colour on
every device.

A note is drawn differently on purpose - a dashed underline in the accent
colour rather than a wash - because a note marks a place to come back to and
a highlight marks a passage worth re-reading, and the two have to be tellable
apart without being read.

Tapping a mark opens it, which is less trivial than it sounds. Marks are
painted with the CSS Custom Highlight API rather than by wrapping the text in
elements: the chapter's DOM comes from the book and must not be rewritten, and
a wrapper would shift the character offsets that everything else in the reader
is addressed by. The cost of that choice is that a highlight is paint, with
nothing under the finger to receive a click, so the hit test runs the other
way round - the point becomes a character offset and the reader asks which
mark covers it (`web/src/reader/marks.ts`). Where marks overlap the shortest
wins: a note written inside a long highlight is both the more specific target
and the one that cannot be reached any other way. A tap that lands on a mark
opens it instead of toggling the chrome, or a highlight would be unreachable
on a phone. The popover shows the quoted passage and the note, and offers the
swatches again so a highlight can be recoloured after the fact, Edit for a
note, and Remove for either; it closes on a page turn or a chapter change,
since it belongs to the mark and not to the page.

The **Notes & marks** page at `/notes` is the other half of the same problem.
The reader shows a book's own marks while you are inside it, which is no help
for the note you wrote six weeks ago in a book you have since finished. So
this page collects every mark from every book, grouped by book with the most
recently marked book first, filterable by kind and by highlight colour, and
searchable across the note, the quoted passage, the title and the author at
once; every entry opens its book at exactly the place it came from. The
filtering happens in the browser rather than on the server, because the whole
set is a few hundred rows at most and typing that filters instantly is the
entire point of a page like this.

Any deliberate jump (bookmark, chapter, search result, slider) that moves more
than a page away shows a **Back to where you were** pill naming the chapter you
left; it stays until used or dismissed.

## Read-along

Switching moves you between two surfaces; **read-along** puts both on one.
Press **Read along** in the reader of an aligned pair and the narration starts
at the sentence in front of you, a mark in the margin (or a wash, your
choice) keeps to the sentence being read, and the page turns itself to keep
up. The player is untouched by this - this is the reader, with a voice.

How the voice is shown is a choice (Reading settings → Following the
voice, two small drawings of a page): a **mark in the margin**, the
default, a small tick beside the line being spoken that moves at the
narrator's pace; or the **sentence highlighted**. Either is drawn inside
the box the text moves in, so it scrolls with the text rather than chasing
it. The mark where you last stopped reading fades as the voice leaves it
behind, the way it fades when you scroll past it. The wash sits on the line boxes of the words
themselves, measured from the text at draw time and again after every
relayout, so a font, a size or a rotation cannot leave it on a line the text
has left; it is firmer at the edge the sentence starts on, dimmer while the
aligner is unsure or the voice is paused, and distinct from a highlight,
which stays flat and in its own colour.
A sentence the page ends in the middle of turns the page the moment the voice
crosses onto the next one - judged by where the voice is within the sentence,
not by where the sentence starts - so the words being spoken are the words on
screen. In scroll mode the page glides to the voice with a short ease in and
out that a wheel or a finger cancels, and reduced motion makes the move
instant. Tapping an earlier passage to move the voice back blinks the sentence
it picks up from: full at its first word, gone by its last, twice over a
second and a half.

The transport is deliberately four controls: play/pause, back (the same skip
length the player uses), speed, and stop. Everything else a listener wants -
sleep timer, chapter list, bookmarks - already lives in the player, one tap
away. It is a card above the bar, grown out of the Read along button with a
beak pointing back at it, and the bottom chrome refuses to hide while it is
there: you should never need two taps to stop a book that is talking.

**Tap any line to move the voice to it.** A tap on a timed sentence seeks the
narration; a tap on the margin, or on text the aligner never timed, falls
through to the reader's own behaviour, so no existing gesture is lost.

**Looking ahead is free.** Turning a page, scrolling, or jumping from the
contents hands the wheel back to you, and the page stops following. It starts
following again on its own the moment the voice reaches whatever page you went
to - there is nothing to press, and the _Back to the voice_ button in the
transport is there for when you would rather not wait.

Where the alignment says nothing, read-along says so rather than guessing:

- between two sentences, the wash is held for up to 2.5 s, so an ordinary
  pause does not make it blink;
- past that, in a stretch with no timings, the wash is dropped and the
  transport reads _the narration is ahead of the timed text_;
- a chapter with no timings at all - front matter, or one the aligner skipped
  - is walked past rather than dead-ending the feature;
- a sentence the aligner never timed is never given an interpolated cue. An
  invented cue would put the wash on a line with exactly the same confidence
  as a measured one.

Listening this way records heartbeats against the **audiobook's** position as
well as the ebook's, so opening the player afterwards resumes where the reading
got to rather than where listening last stopped.

The arithmetic - joining sentences to timings, deciding what is a pause and
what is a hole, and turning a book-absolute position into a file and an offset

- is in `web/src/reader/readalong.ts`, pure and unit-tested.

## Two-way switching

When a pair is aligned, the reader shows **Listen from here**, the player
shows **Read from here**, and the book page and library hero offer
**Listen/Read instead** - every one of them resolves your saved position
through the alignment graph, so opening the other edition lands at the
same place rather than at that edition's own last position.

The book page of a paired book offers all three ways to take it, in the
same order whichever edition the page is: the edition you are on, then
**Read along** - the page with the voice on it - then the other edition.
Read along is the bridge between the two, so it sits between them. From an
ebook it opens that ebook at its own position and starts the narration
there; from an audiobook it resolves the position exactly as a switch does
and starts the voice once the page has landed (`?along=1`). It needs the
alignment, so until the pair has one the button is disabled and says so
rather than opening a page the voice cannot follow. Once there is a
position to carry it reads _Read along from here_. The precision
is reported honestly instead of a blanket "exact" claim:

- `sentence` granularity with `source: exact` only when the current sentence
  itself is verified at high confidence;
- `paragraph`/`approximate` when a nearby aligned sentence (within a bounded
  distance) is used instead;
- **refusal with surrounding anchors** when the position lies in an explicit
  alignment gap, past the drift bound, or too far from any verified
  sentence - the response then carries the nearest aligned points before and
  after, and the UI names them rather than silently jumping to an unrelated
  sentence.

Refusals are not rare edge cases and are not a defect. The default forced
aligner deliberately produces no timing where the narration and the text do
not both exist - a title page, a copyright notice, a spoken chapter
announcement, an index - so those regions are explicit gaps and the switch
says so instead of landing somewhere plausible but wrong. On the audiobook
the engine was validated against, about 94% of sentences had timings
(docs/alignment.md).

Pair status shows the honest numbers: handoff availability plus the
percentage of sentences with sentence-exact coverage (the remainder is
approximate or unavailable). A temporary handoff marker is left after a
switch: a fading sentence highlight in the reader, a position tick on the
player scrubber. The switch is recorded as an explicit `switch` intent in
progress history.

## Offline packages

Offline copies start from **Save offline** on the book page (a cloud, with a
tick once saved), which first explains what will be stored (size, offline
behaviour, removal on sign-out) and asks for confirmation; the same button
shows progress and later manages removal. It is not **Download file** beside
it, which hands the book's own file to the device to keep or open elsewhere.
Per-title downloads verify every entry (byte size + SHA-256 from the
server's offline manifest) before caching, include every referenced derived
asset (illustrations), and only mark the package complete after everything
verified. Every request is tried again after a failure - up to six times,
further apart each time, once the connection is back and the app is in
front - and a response that goes quiet for 30 seconds is abandoned and asked
for again, so a gigabyte on a phone survives the dropped request that used to
end it. A big audiobook is prepared by the server first (its chunk hashes,
worked out once and kept), and the download says so while it waits. A pill
above the tab bar shows what is being saved, and how far it has got, anywhere
in the app; a download the app was closed during is reported as stopped and
picked up again the next time the app opens. With the server unreachable the
library shows a **Downloaded**
shelf built entirely from local storage, so airplane mode starts from
something useful; the book detail JSON is served network-first so pairing
and progress state never freeze at download time. Audio tracks download and store in bounded 8 MB chunks (no
whole-book buffering on iPhone) and are served offline with correct HTTP
Range (206/Content-Range) behavior. **Annotations are online-only in V1**:
creating bookmarks/highlights/notes needs the server, as does recolouring a
highlight or editing a note, and each fails with an honest message offline;
existing annotations are not part of the offline package. Logout removes
offline copies (see docs/security.md).
