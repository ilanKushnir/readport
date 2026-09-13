# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org);
while ReadPort is pre-1.0 a minor bump may still change a contract, and
anything that does is called out under **Upgrading**.

## 0.9.4 — 2026-09-13

### Fixed

- **The reader could hide the end of a chapter.** Pagination was measured the
  instant the chapter was injected — before its images had any height — so a
  chapter with figures measured as a single page, paging switched off, and
  the text that arrived with the images was trapped in a box that cannot
  scroll. It is measured again once images and fonts settle; and if a chapter
  still will not divide into pages, it scrolls and says so rather than hiding
  its own text.
- **The wrong book was suggested as a match.** Sharing an author was worth a
  quarter of the pairing score — worthless as evidence when you own a dozen
  books by one writer — and a length ratio of 0.56 passed a band that ran to
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

## 0.9.3 — 2026-09-13

### Added

- **"Link all" on the Pairing page.** A library owned mostly in both formats
  produces dozens of suggestions, and each one was a separate tap on the very
  page whose purpose is to get them linked. Confirming in bulk makes exactly
  the same decision as confirming one at a time — alignment queued included —
  and leaves anything already settled untouched.

## 0.9.2 — 2026-09-13

### Fixed — mobile

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
- **A setup token typed on a phone was rejected** — iOS capitalised its
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

## 0.9.1 — 2026-09-13

### Fixed

- **Alignments could not be saved into a mounted alignment folder.** The
  entrypoint took ownership of the data, cache and model volumes but not of
  the folders named by `RP_ALIGNMENT_DIRS`, so a folder created with `mkdir`
  on the host stayed root-owned and every save failed. Setup's preflight
  reported it, but there was nothing to do about it short of a manual
  `chown`. Read-only alignment mounts are still left alone.

## 0.9.0 — 2026-09-13

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
- A sidebar of shelves — automatic ones (Reading now, Finished, Both formats,
  Recently added, On this device) alongside shelves you make yourself — and a
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
- `standard` precision puts about 7% of the audio through the model — roughly
  six minutes for a six-hour audiobook on a 6-CPU host. `exact` decodes
  everything and takes some fifteen times as long.
- Every finished alignment is written to a mounted **alignment folder** as one
  gzipped JSON document per pair (`.rpalign`). Files are matched back to books
  by a fingerprint of the ebook's sentences and the audiobook's track lengths
  — never by path — so a from-scratch reinstall imports whatever it
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
