/**
 * Ordered schema migrations. Each entry runs once inside a transaction;
 * applied versions are recorded in schema_migrations. Never edit an entry
 * after release - append a new one.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hmac TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE books (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ebook','audio')),
  root_dir TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  format TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  series TEXT,
  series_idx REAL,
  language TEXT,
  identifiers_json TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  scan_state TEXT NOT NULL DEFAULT 'discovered',
  scan_error TEXT,
  scanned_at TEXT,
  cover_path TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  added_at TEXT NOT NULL,
  UNIQUE (kind, root_dir, rel_path)
);

CREATE TABLE audio_tracks (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  format TEXT NOT NULL,
  title TEXT,
  start_ms_absolute INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, idx)
);

CREATE TABLE chapters (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  spine_idx INTEGER,
  href TEXT,
  start_ms INTEGER,
  end_ms INTEGER,
  PRIMARY KEY (book_id, idx)
);

CREATE TABLE pairs (
  id TEXT PRIMARY KEY,
  ebook_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  audio_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('candidate','auto','confirmed','rejected')),
  score REAL NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  compat_json TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  UNIQUE (ebook_id, audio_id)
);

CREATE TABLE alignments (
  id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  language TEXT NOT NULL,
  model TEXT NOT NULL,
  coverage REAL NOT NULL,
  mean_confidence REAL NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  gaps_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (pair_id, version)
);

CREATE TABLE alignment_segments (
  alignment_id TEXT NOT NULL REFERENCES alignments(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  sentence_id TEXT NOT NULL,
  spine_idx INTEGER NOT NULL,
  sentence_ord INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (alignment_id, ord)
);
CREATE INDEX idx_alignseg_sentence ON alignment_segments(alignment_id, sentence_id);
CREATE INDEX idx_alignseg_time ON alignment_segments(alignment_id, start_ms);

CREATE TABLE progress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  session_uuid TEXT NOT NULL,
  seq INTEGER NOT NULL,
  intent TEXT NOT NULL,
  medium TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  reject_reason TEXT,
  UNIQUE (user_id, event_id)
);
CREATE INDEX idx_progress_events_book ON progress_events(user_id, book_id, received_at);

CREATE TABLE progress_state (
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  locator_json TEXT NOT NULL,
  intent TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  session_uuid TEXT NOT NULL,
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bookmark','highlight','note')),
  locator_json TEXT NOT NULL,
  end_locator_json TEXT,
  color TEXT,
  selected_text TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_annotations_book ON annotations(user_id, book_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  detail TEXT,
  checkpoint_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  heartbeat_at TEXT
);
CREATE INDEX idx_jobs_state ON jobs(state, priority DESC, created_at);
CREATE UNIQUE INDEX idx_jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');

`,
  },
  {
    version: 2,
    sql: `
-- Renewable job leases: writes to a running job are conditional on holding
-- the current lease token, so a reclaimed job's old worker cannot corrupt it.
ALTER TABLE jobs ADD COLUMN lease_token TEXT;
ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT;

-- Progress hardening: server-clamped effective time + the client's declared
-- base revision (causal ordering). occurred_at stays as raw client metadata.
ALTER TABLE progress_events ADD COLUMN effective_at TEXT;
ALTER TABLE progress_events ADD COLUMN base_revision INTEGER;

-- Durable login throttling (per account and per trusted IP), shared across
-- processes and restarts.
CREATE TABLE login_throttle (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
`,
  },
  {
    version: 3,
    sql: `
-- Crash-safe re-indexing: derived reading indexes are immutable versioned
-- directories (derived/<bookId>/v-<jobId>); this pointer names the active
-- one and is switched in a single atomic UPDATE. NULL = legacy unversioned
-- layout directly under derived/<bookId>.
ALTER TABLE books ADD COLUMN derived_rev TEXT;
`,
  },
  {
    version: 4,
    sql: `
-- Per-pair narration language override (user-set) and the language that was
-- actually used/detected by the last alignment, so the speech model can be
-- chosen per language and "model missing" errors name the right one.
ALTER TABLE pairs ADD COLUMN language TEXT;
ALTER TABLE pairs ADD COLUMN detected_language TEXT;
`,
  },
  {
    version: 5,
    sql: `
-- People: display names, disable-without-delete, who added them, last sign-in.
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN created_by TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
-- Roles are now admin / curator / reader; the old catch-all 'user' reads only.
UPDATE users SET role = 'reader' WHERE role NOT IN ('admin', 'curator', 'reader');

-- Invitations: a one-time link creates an account with a preset role. Only
-- a hash of the token is stored, so a leaked database cannot mint accounts.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  display_name TEXT,
  username TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT
);
`,
  },
  {
    version: 6,
    sql: `
-- How far a segment's start may be wrong, in milliseconds, as the aligner
-- itself judged it. Sparse alignment interpolates between acoustic anchors,
-- so a timing is only as good as its distance to the nearest one, and the
-- read-to-listen handoff subtracts this so it lands on narration already
-- read instead of ahead of the reader. 0 = the engine offered no estimate.
ALTER TABLE alignment_segments ADD COLUMN uncertainty_ms INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 7,
    sql: `
-- Speech recognition is gone: one model aligns every book, so the settings
-- that chose between engines, providers and per-language models have nothing
-- left to choose. Fold the survivors forward rather than silently resetting an
-- existing server to the defaults.
INSERT OR REPLACE INTO settings (key, value_json, updated_at)
  SELECT 'autoAlign', CASE WHEN value_json = '"manual"' THEN 'false' ELSE 'true' END,
         updated_at FROM settings WHERE key = 'processingMode';
UPDATE settings SET value_json = '"exact"'
  WHERE key = 'alignPrecision' AND value_json = '"thorough"';
UPDATE settings SET value_json = '"standard"'
  WHERE key = 'alignPrecision' AND value_json IN ('"fast"', '"careful"');
DELETE FROM settings WHERE key IN (
  'processingMode', 'transcribeProvider', 'whisperBin', 'whisperModel',
  'languageModels', 'autoDownloadDefaultModel', 'alignEngine', 'storageBudgetMb',
  'autoPairThreshold',
  -- Measured against a different method; the next alignment measures again.
  'transcribeSpeedRatio'
);
DROP TABLE IF EXISTS transcripts;

-- Portable alignments. A book's identity has to survive a rebuild, a move to
-- another host and a retagging pass, so it is derived from content rather than
-- from a path: the ebook from its own sentence ids (which are already content
-- hashes), the audiobook from the shape of its timeline. Both are filled in by
-- the indexing jobs; NULL means the book has not been re-indexed yet.
ALTER TABLE books ADD COLUMN text_fingerprint TEXT;
ALTER TABLE books ADD COLUMN audio_timeline_fingerprint TEXT;
`,
  },
  {
    version: 8,
    sql: `
-- Shelves are personal furniture, not library metadata: two people on one
-- server share every book and no shelf at all. The owner is on the row and
-- the foreign key carries the deletion rule, because the older per-user
-- tables (progress, annotations) are cleaned up by a hand-written list of
-- table names in the users route, and a list like that is one forgotten line
-- away from leaving a deleted account's shelves behind.
CREATE TABLE shelves (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- A fractional rank, not a position integer. Dropping a shelf between two
  -- others writes ONE row; a position column would rewrite every row below
  -- it, a transaction that grows with the list and can half-apply if the
  -- process dies mid-drag. See server/src/util/rank.ts.
  sort_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- "Summer" and "summer" side by side is a typo the user will blame on us.
CREATE UNIQUE INDEX idx_shelves_user_name ON shelves(user_id, name COLLATE NOCASE);
CREATE INDEX idx_shelves_user_order ON shelves(user_id, sort_key);

-- Membership. The composite primary key is what makes "add to shelf"
-- idempotent: tapping an already-shelved book a second time is a no-op
-- instead of a duplicate the user then has to hunt down. Books are never
-- deleted by the scanner, only marked 'missing' when a drive is unmounted,
-- so a shelf survives an unplugged disk; the cascade is a safety net rather
-- than the normal path.
CREATE TABLE shelf_items (
  shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (shelf_id, book_id)
);
-- sort_key is compared byte for byte. The rank alphabet is 0-9A-Za-z and
-- case is significant, so this index must never acquire COLLATE NOCASE.
CREATE INDEX idx_shelf_items_order ON shelf_items(shelf_id, sort_key);

-- The reading list is not a shelf that happens to be ordered. There is
-- exactly one per person, it cannot be renamed or deleted, and its order IS
-- its content. Folding it into shelves would mean every shelf route growing
-- an "unless this is the reading list" branch, and one missing branch
-- deletes somebody's queue. The composite primary key states the rule in the
-- schema instead: one row per user per book, no duplicates, no second queue.
CREATE TABLE reading_list (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL,
  note TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, book_id)
);
CREATE INDEX idx_reading_list_order ON reading_list(user_id, sort_key);
`,
  },
  {
    version: 9,
    sql: `
-- What the library already says about itself: Calibre's tags, an audiobook's
-- genre and narrator, a publisher, a year, a rating. Read from the files, not
-- invented here, and never written back to them.
--
-- A table rather than more columns on books, because these are many-to-one
-- (a book has several tags) and because the sidebar's question - "which
-- values exist, and how many books each" - is a GROUP BY, which wants an
-- index it can walk rather than a JSON column it has to parse per row.
--
-- Only the facets that are NOT already columns on books live here. Author,
-- series and language stay where they are: duplicating them would give the
-- sidebar a second source of truth that can silently disagree with the
-- library list about the same book.
CREATE TABLE book_facets (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- As written in the file, so a value can be shown back to its owner in
  -- their own capitalisation.
  value TEXT NOT NULL,
  -- Folded for grouping and matching. Two files spelling one genre
  -- "Science Fiction" and "science fiction" are one shelf, not two.
  fold TEXT NOT NULL,
  PRIMARY KEY (book_id, kind, fold)
);
CREATE INDEX idx_book_facets_kind ON book_facets(kind, fold);

-- Per-person interface state. Which sidebar groups someone wants is theirs,
-- not the server's: two people sharing a library browse it differently, and
-- one of them turning off Narrators must not take it from the other.
-- A key/value table rather than columns, so the next preference is a write
-- rather than a migration.
CREATE TABLE user_prefs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`,
  },
  {
    version: 10,
    sql: `
-- Which generation of facet extraction a book was last indexed under.
--
-- Books indexed before facets existed carry no tags, so an upgraded library
-- would show an empty Browse section until every book happened to change on
-- disk. A marker column lets the scanner re-index each of them exactly once,
-- and bumping the constant in the scanner does the same again if a later
-- version learns to read a field this one ignores.
--
-- Deliberately NOT done by resetting scan_state: 'discovered' is not a
-- readable state, so that would make every ebook 404 from the reader until
-- its re-index finished, and pairing skips anything that is not 'ready'.
ALTER TABLE books ADD COLUMN facets_rev INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 11,
    sql: `
-- Walking an alignment in reading order.
--
-- Resolving a switch asks for the nearest segment before or after a position,
-- which without this is a scan and a sort of every segment in the book -
-- fifteen thousand rows for one aligned title, and an offline package asks
-- thousands of times.
CREATE INDEX idx_alignseg_ord ON alignment_segments(alignment_id, spine_idx, sentence_ord);

-- Every book summary asks which pair a book belongs to, from both sides.
CREATE INDEX idx_pairs_ebook ON pairs(ebook_id);
CREATE INDEX idx_pairs_audio ON pairs(audio_id);
`,
  },
  {
    version: 12,
    sql: `
-- May this person take a copy of the file off the server?
--
-- Not a role. Reading and exporting are different questions: a household
-- reader may be trusted with the books without being handed the files, and a
-- curator who confirms pairings has no more claim to a copy than anyone else.
-- So it is a capability granted to a person, set when they are invited and
-- changed later, rather than a rung on the role ladder.
--
-- Off by default, including for people invited before this existed: a server
-- that starts handing out files because it was upgraded is the wrong
-- surprise. Admins always may, and are not stored as an exception.
ALTER TABLE users ADD COLUMN can_export INTEGER NOT NULL DEFAULT 0;

-- The invitation carries the answer, so accepting one does not need a second
-- visit to the People page to grant it.
ALTER TABLE invites ADD COLUMN can_export INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 13,
    sql: `
-- Read-only keys, for agents.
--
-- A person's assistant should be able to see what they are reading without
-- being able to change it, and without being handed the password to an
-- account that can. So: a key belongs to one user, carries that user's view
-- of the library, and can only ever perform a GET.
--
-- The secret is never stored. 'prefix' is the public half of the key, kept
-- so a lookup is an indexed hit rather than a scan of every hash, and so the
-- key can be shown as rp_a1b2c3d4... in a list without revealing anything.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
`,
  },
  {
    version: 14,
    sql: `
-- Reset barriers contain no locator/history. Old offline events cannot undo a reset.
CREATE TABLE progress_resets (
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id)
);
`,
  },
  {
    version: 15,
    sql: `
-- SQLite cannot add a foreign key to an existing table. Rebuild without
-- changing surviving users' reset generations; discard already-deleted users.
CREATE TABLE progress_resets_owned (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id)
);
INSERT INTO progress_resets_owned (user_id, book_id, generation)
SELECT r.user_id, r.book_id, r.generation FROM progress_resets r
JOIN users u ON u.id = r.user_id;
DROP TABLE progress_resets;
ALTER TABLE progress_resets_owned RENAME TO progress_resets;
`,
  },
  {
    version: 16,
    sql: `
-- A book's language, with where it came from. \`language\` stays the one the
-- app uses; the three beside it are its evidence, most trusted first:
--   language_manual    set by a curator, and never overwritten by a rescan
--   language_metadata  what the EPUB (dc:language) or the audio tags declare
--   language_detected  what reading the ebook's own prose suggested
-- and language_source names which of them - or the verified paired edition
-- ('pair') - the current answer was taken from.
ALTER TABLE books ADD COLUMN language_manual TEXT;
ALTER TABLE books ADD COLUMN language_metadata TEXT;
ALTER TABLE books ADD COLUMN language_detected TEXT;
ALTER TABLE books ADD COLUMN language_source TEXT;
UPDATE books SET language_metadata = language, language_source = 'metadata'
 WHERE language IS NOT NULL AND TRIM(language) != '';
`,
  },
  {
    version: 17,
    sql: `
-- Reading sessions: the durable record behind the stats page.
--
-- progress_events cannot be that record. Applied heartbeats are compacted
-- away after thirty days (see compactProgressHistory), and rightly so - they
-- exist to carry a position, not to be a diary. So every ACCEPTED event also
-- folds into a session row here at ingest: an event within a short gap of
-- the last one for the same book and medium extends that session, anything
-- later starts a new one. A session is one sitting with one book on one
-- device.
--
-- Time is wall-clock inside the sitting; distance is the sum of FORWARD
-- movement in pct, so re-reading a page counts as time spent and not as
-- ground covered. Timestamps are the client's occurred_at, in UTC; the hour
-- of the day a reader actually reads at is worked out where the timezone is
-- known, in their browser. No foreign key on book_id on purpose: a book that
-- leaves the library takes nothing from the history of having read it.
CREATE TABLE reading_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  medium TEXT NOT NULL CHECK (medium IN ('ebook','audio')),
  device_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  pct_start REAL NOT NULL,
  pct_end REAL NOT NULL,
  pct_advanced REAL NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_reading_sessions_user_time ON reading_sessions(user_id, started_at);
CREATE INDEX idx_reading_sessions_user_book ON reading_sessions(user_id, book_id);
`,
  },
  {
    version: 18,
    sql: `
-- Friends. Everyone on a ReadPort server already shares one library, so a
-- friendship here is not about access to books - it is consent to see each
-- other's place in them. A request is a row with status 'pending' from the
-- person who asked; accepting flips it, declining deletes it, so a declined
-- request can simply be asked again. Removing a friend deletes the row.
-- Which colour a friend wears, and whether one shows on your progress bar,
-- is the VIEWER's business and lives in user_prefs, not here.
CREATE TABLE friendships (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  created_at TEXT NOT NULL,
  responded_at TEXT,
  CHECK (requester_id != addressee_id),
  UNIQUE (requester_id, addressee_id)
);
CREATE INDEX idx_friendships_addressee ON friendships(addressee_id, status);
CREATE INDEX idx_friendships_requester ON friendships(requester_id, status);

-- A recommendation is one friend putting one book in front of another, with
-- a line of their own if they like. It is read, or dismissed; it is never
-- edited. No foreign key on book_id, as everywhere else that remembers a
-- book: the note "you'd love this" survives the file being moved.
CREATE TABLE recommendations (
  id TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  seen_at TEXT,
  dismissed_at TEXT
);
CREATE INDEX idx_recommendations_to ON recommendations(to_user_id, dismissed_at, created_at);
`,
  },
  {
    version: 19,
    sql: `
-- Idle time. A sitting's clock ran from its first event to its last, so a
-- page left open for nine minutes and picked up again counted as nine
-- minutes of reading. The fold now keeps active_ms: every step between two
-- events counts up to what a page, or a stretch of narration, can plausibly
-- hold (stats/sessions.ts). A sitting from before the column keeps its
-- wall-clock time - null here means "measure by the clock" - except the
-- recent ones, whose events the progress history still holds in full: they
-- are cleared here and derived again at start, with the new rule.
ALTER TABLE reading_sessions ADD COLUMN active_ms INTEGER;
DELETE FROM reading_sessions
 WHERE started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-29 days');
`,
  },
  {
    version: 20,
    sql: `
-- Sharing. A share link is one person handing one book to someone, inside
-- the house or outside it: an unguessable token that resolves to the book's
-- public preview and, for whoever follows it, the way in. Revoking keeps
-- the row so the token stays dead rather than free for reuse.
CREATE TABLE book_shares (
  token TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  opens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_book_shares_book ON book_shares(book_id, created_by);

-- Asking to join. Someone who followed a share link and has no account
-- leaves an address; an admin approves or declines; approval mints an
-- invite bound to that address, which the same link then honours. One
-- open request per address, however many links it arrived through.
CREATE TABLE join_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  message TEXT,
  share_token TEXT REFERENCES book_shares(token) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','declined')),
  invite_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_join_requests_open ON join_requests(email) WHERE status = 'pending';
CREATE INDEX idx_join_requests_status ON join_requests(status, created_at);

-- Where a reading-list entry came from, when somebody else put it there:
-- a friend's recommendation or a share link. Null for one's own.
ALTER TABLE reading_list ADD COLUMN recommended_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE reading_list ADD COLUMN recommended_at TEXT;
`,
  },
  {
    version: 21,
    sql: `
-- Focus. A step back inside a sitting - a page or two, not a chapter - is
-- a re-read: the eye lost the thread and went back for it. Counted per
-- sitting, with the ground covered again, so the stats page can tell the
-- hours a reader holds the thread from the hours they do not. A long way
-- back is navigation and is not this. The recent sittings are cleared and
-- derived again at start so they carry the count too (see version 19).
ALTER TABLE reading_sessions ADD COLUMN rereads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reading_sessions ADD COLUMN reread_pct REAL NOT NULL DEFAULT 0;
DELETE FROM reading_sessions
 WHERE started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-29 days');
`,
  },
  {
    version: 22,
    sql: `
-- Hidden books. An admin can take a book off everyone else's shelves without
-- taking it off the server: hidden, it is on no list, in no count and behind
-- no link for anybody but an admin (see library/visibility.ts). Nothing a
-- reader attached to it - progress, notes, shelves, the reading list - is
-- touched, so all of it is there again the day the book is shown again.
--
-- Null is shown. The time is when it was hidden, and the admin who did it,
-- so a household with two admins can tell whose decision it was.
ALTER TABLE books ADD COLUMN hidden_at TEXT;
ALTER TABLE books ADD COLUMN hidden_by TEXT REFERENCES users(id) ON DELETE SET NULL;
`,
  },
  {
    version: 23,
    sql: `
-- The per-chunk hashes an offline download checks each piece of audio
-- against, kept once worked out. They were computed on every request for a
-- book's offline manifest - the whole file read and hashed again, a
-- gigabyte over a network share, before the first byte of the answer, and
-- all of it again for the retry. Keyed by the file's source version (size,
-- mtime and path, see audio/integrity.ts), so a replaced file is never
-- vouched for by its predecessor's hashes; the path is kept so the rows of
-- a file's older versions can be let go.
CREATE TABLE track_hashes (
  source_version TEXT NOT NULL,
  chunk_size INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  hashes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_version, chunk_size)
);
CREATE INDEX idx_track_hashes_path ON track_hashes(rel_path);
`,
  },
];
