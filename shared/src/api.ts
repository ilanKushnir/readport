import { z } from 'zod';
import { handoffStatusSchema } from './alignment.js';
import { locatorSchema } from './locator.js';

/** DTOs shared between the API and the web client. */

export const bookKindSchema = z.enum(['ebook', 'audio']);
export type BookKind = z.infer<typeof bookKindSchema>;

export const scanStateSchema = z.enum(['discovered', 'indexing', 'ready', 'error', 'missing']);
export type ScanState = z.infer<typeof scanStateSchema>;

export const pairStatusSchema = z.enum(['candidate', 'auto', 'confirmed', 'rejected']);
export type PairStatus = z.infer<typeof pairStatusSchema>;

/** The catalogues a cover can be looked up in, in the order they are offered to an admin. */
export const COVER_SOURCES = ['apple', 'audible', 'google', 'openlibrary'] as const;

export const bookSummarySchema = z.object({
  id: z.string(),
  kind: bookKindSchema,
  title: z.string(),
  author: z.string().nullable(),
  series: z.string().nullable(),
  seriesIdx: z.number().nullable(),
  language: z.string().nullable(),
  /** Where `language` came from; null when nothing is known. See languages.ts. */
  languageSource: z.enum(['manual', 'metadata', 'pair', 'detected']).nullable().optional(),
  format: z.string(),
  scanState: scanStateSchema,
  scanError: z.string().nullable(),
  durationMs: z.number().nullable(),
  sizeBytes: z.number(),
  hasCover: z.boolean(),
  /** Which version of the cover to ask for; changes when the cover does. */
  coverV: z.string().optional(),
  addedAt: z.string(),
  /**
   * Hidden from everyone but the admins: when, and by whom (their name as
   * it is now; null once that account is gone). Only an admin is ever sent a
   * hidden book, so for anybody else this is always null. Optional so a
   * summary cached by an older build still parses.
   */
  hidden: z.object({ at: z.string(), by: z.string().nullable() }).nullable().optional(),
  /**
   * The cover shown is one a curator picked for a book whose file had none,
   * not the book's own - and where it came from: the book's other format,
   * or a catalogue. Absent for a book's own cover.
   */
  coverFound: z.enum(['edition', ...COVER_SOURCES]).optional(),
  pair: z
    .object({
      pairId: z.string(),
      otherBookId: z.string(),
      /**
       * The other half's kind and format, so a collapsed card can say EPUB
       * *and* M4B without fetching the counterpart. A book owned twice is one
       * book; the library shows it once and names both formats on it.
       */
      otherKind: bookKindSchema,
      otherFormat: z.string(),
      /**
       * Where THIS person stands in the counterpart, when they have opened
       * it at all. Progress is per book id, so the two editions genuinely
       * carry separate positions; a card that stands for both of them has to
       * be able to say "finished the ebook, half way through the audiobook".
       * Without this, collapsing a pair to one row would be the thing that
       * hides one of the two - which is why the progress shelves used not to
       * collapse at all.
       *
       * Optional so a summary cached by an older build still parses; null
       * means the counterpart has never been opened.
       */
      otherProgress: z
        .object({ pct: z.number(), updatedAt: z.string(), finished: z.boolean() })
        .nullable()
        .optional(),
      status: pairStatusSchema,
      /** Handoff is available (does NOT claim sentence exactness - see handoff). */
      switchable: z.boolean(),
      handoff: handoffStatusSchema.nullable(),
    })
    .nullable(),
  progress: z
    .object({
      pct: z.number(),
      locator: locatorSchema,
      updatedAt: z.string(),
      finished: z.boolean(),
    })
    .nullable(),
});
export type BookSummary = z.infer<typeof bookSummarySchema>;

export const chapterInfoSchema = z.object({
  idx: z.number().int(),
  title: z.string(),
  spineIdx: z.number().int().nullable(),
  href: z.string().nullable(),
  startMs: z.number().int().nullable(),
  endMs: z.number().int().nullable(),
});
export type ChapterInfo = z.infer<typeof chapterInfoSchema>;

export const trackInfoSchema = z.object({
  idx: z.number().int(),
  durationMs: z.number().int(),
  startMsAbsolute: z.number().int(),
  sizeBytes: z.number().int(),
  format: z.string(),
  title: z.string().nullable(),
});
export type TrackInfo = z.infer<typeof trackInfoSchema>;

export const annotationKindSchema = z.enum(['bookmark', 'highlight', 'note']);
export type AnnotationKind = z.infer<typeof annotationKindSchema>;

export const annotationSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  kind: annotationKindSchema,
  locator: locatorSchema,
  endLocator: locatorSchema.nullable(),
  color: z.string().nullable(),
  selectedText: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type Annotation = z.infer<typeof annotationSchema>;

export const createAnnotationSchema = z.object({
  kind: annotationKindSchema,
  locator: locatorSchema,
  endLocator: locatorSchema.nullable().optional(),
  color: z
    .string()
    .regex(/^[a-z]{1,20}$/)
    .nullable()
    .optional(),
  selectedText: z.string().max(2000).nullable().optional(),
  note: z.string().max(10000).nullable().optional(),
});

export const pairEvidenceSchema = z.object({
  titleScore: z.number(),
  authorScore: z.number(),
  identifierMatch: z.boolean(),
  languageMatch: z.boolean().nullable(),
  seriesMatch: z.boolean().nullable(),
  durationPagesRatio: z.number().nullable(),
  contentScore: z.number().nullable(),
  notes: z.array(z.string()),
});
export type PairEvidence = z.infer<typeof pairEvidenceSchema>;

export const jobStateSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type JobState = z.infer<typeof jobStateSchema>;

export const jobSchema = z.object({
  id: z.string(),
  type: z.string(),
  state: jobStateSchema,
  progress: z.number().min(0).max(1),
  detail: z.string().nullable(),
  error: z.string().nullable(),
  attempts: z.number().int(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** What the job is about (pair/book/model), for queue displays. */
  subject: z
    .object({
      title: z.string(),
      sub: z.string().nullable(),
      pairId: z.string().nullable(),
      bookId: z.string().nullable(),
    })
    .nullable()
    .optional(),
});
export type Job = z.infer<typeof jobSchema>;

/**
 * Counts of every job by type and state.
 *
 * `/api/jobs` returns only the newest 100 rows, which is fine for a queue
 * display and useless for "is the first scan finished?": one book makes one
 * index job, so a library of a couple of hundred books pushes the `scan` job - the oldest of the
 * lot - straight out of the window. Anything reasoning about overall progress
 * has to read these totals instead of counting rows.
 */
export const jobCountSchema = z.object({
  type: z.string(),
  state: jobStateSchema,
  count: z.number().int().nonnegative(),
});
export type JobCount = z.infer<typeof jobCountSchema>;

export const jobsResponseSchema = z.object({
  jobs: z.array(jobSchema),
  totals: z.array(jobCountSchema),
});
export type JobsResponse = z.infer<typeof jobsResponseSchema>;

/**
 * Roles. `admin` runs the server and its people; `curator` shepherds pairs
 * (confirm / dismiss / re-align, watch the queue); `reader` reads and listens.
 * Every role keeps its own progress, bookmarks and offline copies.
 */
export const roleSchema = z.enum(['admin', 'curator', 'reader']);
export type Role = z.infer<typeof roleSchema>;
export const ROLE_LABELS: Record<Role, { label: string; blurb: string }> = {
  admin: { label: 'Admin', blurb: 'Everything: users, libraries, models, server settings.' },
  curator: {
    label: 'Curator',
    blurb: 'Confirms and dismisses pairs, starts alignments, watches the queue.',
  },
  reader: { label: 'Reader', blurb: 'Reads and listens; own progress, bookmarks and downloads.' },
};

const usernameSchema = z
  .string()
  .min(3, 'At least 3 characters')
  .max(32, 'At most 32 characters')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, dots, dashes and underscores only');
const passwordSchema = z.string().min(10, 'At least 10 characters').max(1024);
const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name, or leave it blank')
  .max(80, 'At most 80 characters');

/**
 * May this person take a copy of a book off the server?
 *
 * Deliberately not a role. Reading and exporting are different questions - a
 * household reader may be trusted with the books without being handed the
 * files - so it is granted to a person rather than earned by rank. Admins
 * always may.
 */
export const canExportSchema = z.boolean();

export const userDtoSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  role: roleSchema,
  /** May download the original file, not just read it in the app. */
  canExport: canExportSchema,
  status: z.enum(['active', 'disabled']),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  /** When they last used ReadPort at all: any signed-in request, not only a login. */
  lastSeenAt: z.string().nullable().optional(),
  /** Signs in through the reverse proxy (no local password). */
  proxyManaged: z.boolean(),
  sessions: z.number().int(),
  booksInProgress: z.number().int(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema.default('reader'),
  canExport: canExportSchema.default(false),
  displayName: displayNameSchema.optional(),
});
export const updateUserSchema = z.object({
  role: roleSchema.optional(),
  canExport: canExportSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  displayName: displayNameSchema.nullable().optional(),
  /** Admin-set new password; signs the user out everywhere. */
  password: passwordSchema.optional(),
});
export const createInviteSchema = z.object({
  role: roleSchema.default('reader'),
  /** Carried by the invitation, so accepting one grants it immediately. */
  canExport: canExportSchema.default(false),
  displayName: displayNameSchema.optional(),
  /** Suggested username, editable by the invitee. */
  username: usernameSchema.optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});
export const inviteDtoSchema = z.object({
  id: z.string(),
  role: roleSchema,
  canExport: canExportSchema,
  displayName: z.string().nullable(),
  username: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  usedAt: z.string().nullable(),
});
export type InviteDto = z.infer<typeof inviteDtoSchema>;
export const acceptInviteSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
});
/**
 * `currentPassword` is optional because an account provisioned by a reverse
 * proxy has no password to prove: it is omitted when FIRST setting one, and
 * required in every other case. The server decides which case it is - the
 * client cannot skip the check by leaving the field out.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024).optional(),
  newPassword: passwordSchema,
});

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});

const dirListSchema = z.array(z.string().trim().min(1).max(1024)).max(16);

export const setupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
  /** One-time bootstrap token proving control of the server (env/secret file/log). */
  setupToken: z.string().min(8).max(512).optional(),
  /** Library roots chosen in the wizard (ignored when pinned by env). */
  ebookDirs: dirListSchema.optional(),
  audiobookDirs: dirListSchema.optional(),
  defaultLanguage: z.string().min(2).max(16).optional(),
  /** Folder where alignments are saved as files, chosen in the wizard. */
  alignmentDirs: dirListSchema.optional(),
  /** Align new matches without being asked; see settingsSchema. */
  autoAlign: z.boolean().optional(),
  /** Take alignments already in the folder; see settingsSchema. */
  importSavedAlignments: z.boolean().optional(),
  /**
   * How this server is reached from outside. Asked during setup because it
   * is what makes an invitation link work for the person receiving it, and
   * the moment someone is setting up a library to share is the moment they
   * know the answer.
   */
  publicUrl: z.string().trim().max(300).optional(),
});
export const alignManySchema = z.object({
  pairIds: z.array(z.string().min(1).max(64)).min(1).max(500),
});

/**
 * What a folder is for. Not `bookKindSchema`: that one also types `books.kind`,
 * and an alignment folder holds no books.
 */
export const folderKindSchema = z.enum(['ebook', 'audio', 'alignment']);
export type FolderKind = z.infer<typeof folderKindSchema>;

export const testPathsSchema = z.object({
  paths: dirListSchema,
  /** What the folder is expected to hold; drives the file-count hint. */
  kind: folderKindSchema.optional(),
});
export const pathCheckSchema = z.object({
  path: z.string(),
  ok: z.boolean(),
  exists: z.boolean(),
  isDirectory: z.boolean(),
  readable: z.boolean(),
  /**
   * Whether the server can create a file here. Only asked of an alignment
   * folder, and asked by writing rather than by permission bits - a bind mount
   * can report the bits and still refuse.
   */
  writable: z.boolean().nullable().default(null),
  /** Matching files found in a shallow, capped walk (null when unreadable). */
  matches: z.number().int().nullable(),
  sampled: z.boolean(),
  problem: z.string().nullable(),
});
export type PathCheck = z.infer<typeof pathCheckSchema>;

/**
 * The apps that live beside this library - Calibre-Web Automated, an
 * Audiobookshelf, a Shelfmark - so a reader can get to them from here. Only
 * the address is kept for now: the "smart" integration that would use each
 * app's own API is deliberately not here yet, and the settings page says so.
 */
export const APP_KINDS = ['cwa', 'abs', 'shelfmark', 'readmeabook', 'kavita', 'custom'] as const;
export type AppKind = (typeof APP_KINDS)[number];

export const appLinkSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(APP_KINDS),
  /** Shown on the tile; presets fill it in, custom apps need it typed. */
  name: z.string().trim().min(1).max(40),
  url: z
    .string()
    .trim()
    .max(500)
    .refine((u) => /^https?:\/\/[^\s]+$/i.test(u), 'must be an http(s) address'),
});
export type AppLink = z.infer<typeof appLinkSchema>;

export const settingsSchema = z.object({
  /** Used when a book's own metadata does not say what language it is in. */
  defaultLanguage: z.string().min(2).max(16),
  /** Folders scanned for books. Read-only; pinned by RP_EBOOK_DIRS / RP_AUDIOBOOK_DIRS. */
  ebookDirs: dirListSchema.default([]),
  audiobookDirs: dirListSchema.default([]),
  /**
   * Where finished alignments are saved as files, so they outlive the
   * container. The only folders this app writes to. Empty means the app's own
   * data directory, which a rebuild can take with it.
   */
  alignmentDirs: dirListSchema.default([]),
  /**
   * How this server is reached from outside, e.g. `https://readport.example`.
   *
   * Invitation links were built from whatever address the ADMIN happened to
   * be using, so a link made from `http://server.lan:7323` is useless to the
   * friend it was made for. Optional: a library nobody reaches from outside
   * does not need one, and when it is empty the link falls back to the
   * current origin, which is right for exactly that case.
   */
  publicUrl: z.string().trim().max(300).default(''),
  /** The apps beside this library, in the order they are shown. */
  apps: z.array(appLinkSchema).max(12).default([]),
  /**
   * How much of the narration is listened to.
   *  - `standard` samples it and interpolates between the matches: minutes per
   *    book, and switching lands on the right paragraph.
   *  - `exact` listens to every second for sentence-perfect timings, at
   *    roughly fifteen times the cost.
   */
  alignPrecision: z.enum(['standard', 'exact']).default('standard'),
  /** Align a book as soon as its two halves are matched, without being asked. */
  autoAlign: z.boolean().default(true),
  /**
   * Adopt alignments already sitting in the alignment folder.
   *
   * On by default, because the usual reason a folder has files in it is that
   * this library computed them and the container was rebuilt - hours of work
   * that should not be repeated. Turned off, the folder is left untouched and
   * every pair is timed again from the audio, which is what someone wants
   * when they suspect the saved files are wrong or belong to other editions.
   */
  importSavedAlignments: z.boolean().default(true),
  /**
   * Look for a cover for every book without one, when a curator opens its
   * page: its ISBN, title and author are asked of the sources below. Off,
   * nothing is asked until a curator presses Find a cover - which is why it
   * is off until an admin turns it on.
   */
  coverSuggestions: z.boolean().default(false),
  /**
   * Where covers are looked for. None at all: a book is offered only its
   * other format's cover, and nothing is ever asked of anyone.
   */
  coverSources: z
    .array(z.enum(COVER_SOURCES))
    .max(COVER_SOURCES.length)
    .default([...COVER_SOURCES]),
  /**
   * Measured throughput: seconds of audio aligned per second of wall clock.
   * Written by the worker from real runs, never guessed; 0 = not yet known.
   */
  alignSpeedRatio: z.number().min(0).max(500).default(0),
});
export type Settings = z.infer<typeof settingsSchema>;
export type CoverSourceName = (typeof COVER_SOURCES)[number];

/**
 * A book's description as something to lay out rather than a string to
 * print: what the file wrote as HTML or Markdown, kept to the few shapes a
 * description has - paragraphs, emphasis, lists, quotes, links - and
 * nothing that could run. The server turns the file's text into this; the
 * page renders it as elements, never as markup.
 */
export type RichMark = 'b' | 'i' | 'u' | 's' | 'code' | 'sup' | 'sub';
export type RichInline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: RichMark; c: RichInline[] }
  | { t: 'a'; href: string; c: RichInline[] };
export type RichBlock =
  | { t: 'p'; c: RichInline[] }
  | { t: 'h'; c: RichInline[] }
  | { t: 'ul' | 'ol'; items: RichBlock[][] }
  | { t: 'quote'; c: RichBlock[] }
  | { t: 'hr' };

/**
 * Everything ReadPort knows about one book, for an admin: where its file is,
 * what the file says about itself, and what ReadPort made of it. Paths are
 * as the server sees them - inside its container, when it runs in one.
 */
export interface BookMetadata {
  file: {
    /** The file's name - or, for an audiobook, its folder's. */
    name: string;
    /** The folder it is in, within its library; '' at the library's top. */
    folder: string;
    /** The library folder it was found in. */
    library: string;
    /** The whole path, library and all. */
    path: string;
    isFolder: boolean;
    format: string;
    sizeBytes: number;
    /** When the file last changed on disk; null when it is not there now. */
    modifiedAt: string | null;
    present: boolean;
    /** A fingerprint of the content, as ReadPort took it at its last index. */
    contentHash: string | null;
  };
  /** An audiobook's files, in play order, named within its folder. */
  tracks: {
    name: string;
    format: string;
    sizeBytes: number;
    durationMs: number;
    title: string | null;
  }[];
  /** What the file says about itself. */
  embedded: {
    title: string;
    author: string | null;
    series: string | null;
    seriesIdx: number | null;
    language: string | null;
    publisher: string | null;
    identifiers: Record<string, string>;
    /** The library's own groupings read from the file: genre, narrator, year, rating. */
    tags: { kind: string; value: string }[];
    description: boolean;
  };
  /** What ReadPort made of it. */
  readport: {
    id: string;
    addedAt: string;
    indexedAt: string | null;
    state: string;
    error: string | null;
    language: {
      value: string | null;
      source: string | null;
      manual: string | null;
      detected: string | null;
    };
    cover: 'own' | 'picked' | 'none';
    coverSource: string | null;
    chapters: number;
    characters: number | null;
    durationMs: number | null;
    pair: { title: string; kind: 'ebook' | 'audio'; status: string } | null;
    hidden: { at: string; by: string | null } | null;
  };
}
