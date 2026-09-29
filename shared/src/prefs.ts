import { z } from 'zod';

/**
 * Personal preferences, and which of them belong to the person rather than to
 * the screen in front of them.
 *
 * Everything here follows a reader between their devices - that is the point.
 * But not everything *should*. A type size chosen on a phone held at arm's
 * length is the wrong size on a 27-inch monitor, and two-page spreads are
 * meaningless on either. Pushing one number to both places is worse than not
 * syncing at all, because the reader has to keep undoing it.
 *
 * So preferences are stored in two buckets: the ones that describe taste,
 * which are shared, and the ones that describe a screen, which are kept per
 * device class. `PER_DEVICE_READER_KEYS` is the whole of that judgement, in
 * one place, and only the functions in this module read it.
 */

export const DEVICE_CLASSES = ['phone', 'tablet', 'desktop'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export const READER_THEMES = ['paper', 'sepia', 'night', 'contrast'] as const;
export const READER_FONTS = [
  'literata',
  'iowan',
  'charter',
  'palatino',
  'georgia',
  'baskerville',
  'sans',
] as const;

export const SIZE_MIN = 14;
export const SIZE_MAX = 32;

/** How strongly the sentence being read aloud is washed, as the share of the text colour. */
export const WASH_MIN = 0.06;
export const WASH_MAX = 0.4;

/**
 * No field here has a default of its own, and none may: every stored bucket
 * is this schema made partial, and zod fills a default into a partial object
 * too. A default here was written into every bucket each time a document
 * was read, and a device's bucket outranks the shared one - so a voice mark
 * chosen once, for every device, came back as the default on each of them.
 * The defaults are DEFAULT_READER_PREFS, applied once, by mergeReaderPrefs.
 */
export const readerPrefsSchema = z.object({
  /** 'auto' follows the system appearance: paper by day, night in the dark. */
  theme: z.enum([...READER_THEMES, 'auto']),
  font: z.enum(READER_FONTS),
  /** px */
  size: z.number().min(SIZE_MIN).max(SIZE_MAX),
  weight: z.number().min(300).max(700),
  lineHeight: z.number().min(1.1).max(2.4),
  margin: z.enum(['compact', 'normal', 'wide']),
  align: z.enum(['start', 'justify']),
  hyphens: z.boolean(),
  mode: z.enum(['paginated', 'scroll']),
  /** Paginated columns: 'auto' shows two pages side by side on wide screens. */
  columns: z.enum(['auto', 'one', 'two']),
  /**
   * How a page turn looks.
   *
   * 'slide' moves the page across, 'fade' crosses it over without travel for
   * anyone the movement bothers, and 'instant' does neither - which is also
   * what everyone gets when the system asks for reduced motion.
   */
  pageTurn: z.enum(['slide', 'fade', 'instant']),
  /** 0.35–1: page dimming for night reading (1 = no dimming). */
  brightness: z.number().min(0.35).max(1),
  /** Bottom progress indicator: full, one thin line, or nothing. */
  progressBar: z.enum(['full', 'compact', 'hidden']),
  /**
   * Read-along in scroll mode: keep the marker still and move the page
   * under it. Remembered, so "Back to the voice" brings it back too - it
   * used to switch itself off every time the reader so much as scrolled.
   */
  autoScroll: z.boolean(),
  /**
   * How the voice is shown while reading along: a mark in the margin beside
   * the line being spoken, or a wash on the sentence itself. The margin is
   * the default - it is the honest one, roughly here and moving - and the
   * wash is there for whoever wants the words themselves lit.
   */
  voiceMark: z.enum(['margin', 'wash']),
  /**
   * The wash's strength, WASH_MIN–WASH_MAX. Taste rather than a screen's: a
   * reader who wants the spoken words lit wants them lit everywhere.
   */
  washOpacity: z.number().min(WASH_MIN).max(WASH_MAX),
});

export type ReaderPrefs = z.infer<typeof readerPrefsSchema>;
export type ReaderTheme = (typeof READER_THEMES)[number];
export type ReaderFont = (typeof READER_FONTS)[number];

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  theme: 'paper',
  font: 'literata',
  size: 19,
  weight: 420,
  lineHeight: 1.62,
  margin: 'normal',
  align: 'start',
  hyphens: true,
  mode: 'paginated',
  columns: 'auto',
  pageTurn: 'slide',
  brightness: 1,
  progressBar: 'full',
  autoScroll: false,
  voiceMark: 'margin',
  washOpacity: 0.18,
};

/**
 * The settings that describe a screen, not a taste.
 *
 * Size, leading and margins are how big the text has to be to read at this
 * distance; mode and columns are what the shape of the screen allows;
 * brightness is the room; the progress bar is how much chrome fits. Everything
 * NOT listed here - theme, typeface, weight, justification, hyphenation - is
 * what the reader likes, and follows them everywhere.
 */
export const PER_DEVICE_READER_KEYS = [
  'size',
  'lineHeight',
  'margin',
  'mode',
  'columns',
  // Sits with `mode` and `columns`: a page turn on a phone and a page turn
  // on a desktop are different gestures, and a reader may well want them to
  // behave differently.
  'pageTurn',
  'brightness',
  'progressBar',
  // Belongs with `mode`: it only means anything where the page scrolls.
  'autoScroll',
] as const satisfies readonly (keyof ReaderPrefs)[];

const perDevice = new Set<string>(PER_DEVICE_READER_KEYS);

type Bucket = Partial<ReaderPrefs>;

/**
 * The keys of a bucket that belong in it: taste in the shared bucket, the
 * screen's settings in a device's. A key in the wrong bucket is no choice
 * anybody made - it is how a default read into every bucket (see
 * readerPrefsSchema) looks once stored - so it is dropped, and documents
 * stored that way read back as the reader left them.
 */
function own(bucket: Bucket | undefined, device: boolean): Bucket {
  const out: Bucket = {};
  for (const [key, value] of Object.entries(bucket ?? {})) {
    if (value !== undefined && perDevice.has(key) === device) Object.assign(out, { [key]: value });
  }
  return out;
}

/** The later of two ISO times; a time that does not parse loses. */
function later(a: string, b: string): string {
  return (Date.parse(b) || 0) > (Date.parse(a) || 0) ? b : a;
}

/** What is stored per account: one shared bucket, one bucket per device class. */
export const syncedReaderPrefsSchema = z.object({
  shared: readerPrefsSchema.partial(),
  // An explicit object rather than a record keyed by the enum: a record over
  // an enum requires every key, and a reader who has only ever used a phone
  // has no desktop bucket to store.
  byDevice: z
    .object({
      phone: readerPrefsSchema.partial(),
      tablet: readerPrefsSchema.partial(),
      desktop: readerPrefsSchema.partial(),
    })
    .partial(),
  /** Last write, ISO. Ties are broken in favour of the server's copy. */
  updatedAt: z.string(),
});

export type SyncedReaderPrefs = z.infer<typeof syncedReaderPrefsSchema>;

export const EMPTY_SYNCED_READER_PREFS: SyncedReaderPrefs = {
  shared: {},
  byDevice: {},
  updatedAt: '1970-01-01T00:00:00.000Z',
};

/**
 * The preferences to actually use on this device: defaults, overlaid with
 * what the reader likes anywhere, overlaid with what they chose on a screen
 * like this one.
 */
export function mergeReaderPrefs(
  synced: SyncedReaderPrefs | null | undefined,
  device: DeviceClass,
): ReaderPrefs {
  if (!synced) return { ...DEFAULT_READER_PREFS };
  return {
    ...DEFAULT_READER_PREFS,
    ...own(synced.shared, false),
    ...own(synced.byDevice[device], true),
  };
}

/**
 * Fold a complete set of preferences back into the two buckets.
 *
 * Only the keys that differ from the defaults are stored, so a reader who
 * never touched the margins does not pin them - and a later change to a
 * default reaches them instead of being silently overridden by a copy of the
 * old one.
 */
export function splitReaderPrefs(
  next: ReaderPrefs,
  device: DeviceClass,
  previous: SyncedReaderPrefs | null | undefined,
  now: string,
): SyncedReaderPrefs {
  const shared: Bucket = {};
  const mine: Bucket = {};
  for (const key of Object.keys(DEFAULT_READER_PREFS) as (keyof ReaderPrefs)[]) {
    const value = next[key];
    if (value === DEFAULT_READER_PREFS[key]) continue;
    if (perDevice.has(key)) Object.assign(mine, { [key]: value });
    else Object.assign(shared, { [key]: value });
  }
  // Other device classes are carried through untouched: choosing a bigger
  // type on a phone must not reach across and change the desktop.
  const byDevice: SyncedReaderPrefs['byDevice'] = {};
  for (const other of DEVICE_CLASSES) {
    const kept = previous?.byDevice[other];
    if (other !== device && kept) byDevice[other] = own(kept, true);
  }
  byDevice[device] = mine;
  return { shared, byDevice, updatedAt: now };
}

/**
 * A change, as a document of the same shape holding only what changed.
 *
 * A setting changed on one device is sent as that one setting, never as a
 * copy of everything the device believes. Whole documents were how a
 * choice went missing: a reader left open on the tablet since yesterday
 * still held yesterday's settings, and changing its type size sent all of
 * them back, over the voice mark chosen on the phone this morning.
 */
export function readerPrefsPatch(
  changed: Bucket,
  device: DeviceClass,
  now: string,
): SyncedReaderPrefs {
  const mine = own(changed, true);
  return {
    shared: own(changed, false),
    byDevice: Object.keys(mine).length ? { [device]: mine } : {},
    updatedAt: now,
  };
}

/**
 * Apply a change to a stored document, setting by setting. A setting that
 * is its default is not stored - changed back to it, or written that way by
 * an older version - as splitReaderPrefs would not store it, so a later
 * change of default still reaches it.
 */
export function applyReaderPrefsPatch(
  doc: SyncedReaderPrefs | null | undefined,
  patch: SyncedReaderPrefs,
): SyncedReaderPrefs {
  const base = doc ?? EMPTY_SYNCED_READER_PREFS;
  const apply = (bucket: Bucket | undefined, change: Bucket | undefined, device: boolean) => {
    const out: Bucket = { ...own(bucket, device), ...own(change, device) };
    for (const key of Object.keys(out) as (keyof ReaderPrefs)[]) {
      if (out[key] === DEFAULT_READER_PREFS[key]) delete out[key];
    }
    return out;
  };
  const byDevice: SyncedReaderPrefs['byDevice'] = {};
  for (const device of DEVICE_CLASSES) {
    const had = base.byDevice[device];
    const change = patch.byDevice[device];
    if (had || change) byDevice[device] = apply(had, change, true);
  }
  return {
    shared: apply(base.shared, patch.shared, false),
    byDevice,
    updatedAt: later(base.updatedAt, patch.updatedAt),
  };
}

/** Two changes as one, the second winning wherever both set a setting. */
export function combineReaderPrefsPatches(
  first: SyncedReaderPrefs,
  second: SyncedReaderPrefs,
): SyncedReaderPrefs {
  const byDevice: SyncedReaderPrefs['byDevice'] = {};
  for (const device of DEVICE_CLASSES) {
    const a = first.byDevice[device];
    const b = second.byDevice[device];
    if (a || b) byDevice[device] = { ...a, ...b };
  }
  return {
    shared: { ...first.shared, ...second.shared },
    byDevice,
    updatedAt: later(first.updatedAt, second.updatedAt),
  };
}

/**
 * Reconcile a local copy with the server's.
 *
 * Changes travel as patches (readerPrefsPatch), each setting on its own, so
 * the server's copy is every device's changes together, and a local copy is
 * a cache of it. This only decides which copy is the more recent: the newer
 * wins as a whole.
 */
export function reconcileReaderPrefs(
  local: SyncedReaderPrefs | null | undefined,
  remote: SyncedReaderPrefs | null | undefined,
): SyncedReaderPrefs {
  if (!local) return remote ?? EMPTY_SYNCED_READER_PREFS;
  if (!remote) return local;
  return Date.parse(remote.updatedAt) >= Date.parse(local.updatedAt) ? remote : local;
}

/* ------------------------------------------------------------- playback */

/**
 * How a book sounds, which is about the narrator and not about the phone -
 * so all of it is shared. Per-book speed is capped: it is a convenience, not
 * a record worth growing without limit.
 */
export const PER_BOOK_SPEED_LIMIT = 100;

export const playbackPrefsSchema = z.object({
  /** Default rate for a book with no setting of its own. */
  speed: z.number().min(0.5).max(3),
  skipBack: z.number().int().min(5).max(120),
  skipForward: z.number().int().min(5).max(120),
  /** bookId → { rate, when it was set } so the oldest can be pruned. */
  perBook: z.record(z.string(), z.object({ rate: z.number().min(0.5).max(3), at: z.string() })),
  updatedAt: z.string(),
});

export type PlaybackPrefs = z.infer<typeof playbackPrefsSchema>;

export const DEFAULT_PLAYBACK_PREFS: PlaybackPrefs = {
  speed: 1,
  skipBack: 15,
  skipForward: 30,
  perBook: {},
  updatedAt: '1970-01-01T00:00:00.000Z',
};

/** Keep the most recently set per-book speeds and drop the rest. */
export function prunePerBookSpeeds(prefs: PlaybackPrefs): PlaybackPrefs {
  const entries = Object.entries(prefs.perBook);
  if (entries.length <= PER_BOOK_SPEED_LIMIT) return prefs;
  entries.sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
  return { ...prefs, perBook: Object.fromEntries(entries.slice(0, PER_BOOK_SPEED_LIMIT)) };
}
