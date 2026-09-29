import {
  DEFAULT_READER_PREFS,
  EMPTY_SYNCED_READER_PREFS,
  type DeviceClass,
  type ReaderFont,
  type ReaderPrefs,
  type ReaderTheme,
  type SyncedReaderPrefs,
  applyReaderPrefsPatch,
  combineReaderPrefsPatches,
  mergeReaderPrefs,
  readerPrefsPatch,
  reconcileReaderPrefs,
  readerPrefsSchema,
  splitReaderPrefs,
  syncedReaderPrefsSchema,
} from '@readport/shared';
import { api } from '../api/client';
import { type MessageKey } from '../i18n/messages/en';

export {
  DEFAULT_READER_PREFS as DEFAULT_PREFS,
  SIZE_MAX,
  SIZE_MIN,
  WASH_MAX,
  WASH_MIN,
  type ReaderFont,
  type ReaderPrefs,
  type ReaderTheme,
} from '@readport/shared';

/**
 * Reader appearance on this device.
 *
 * The contract - what a preference is, and which of them belong to the screen
 * rather than to the person - lives in @readport/shared so the server can
 * validate what it is handed. This module is the browser half: which device
 * class this is, where the local copy lives, and how the two are kept in step.
 *
 * localStorage stays the source the reader actually sees. It answers instantly,
 * it works with no server, and a reader changing the type size must never wait
 * for a round trip to see it. The server copy is the sync layer underneath.
 */

const KEY = 'rp-reader-prefs';
/** Changes made here and not yet taken by the server, kept for the next load if need be. */
const PENDING_KEY = 'rp-reader-prefs-pending';

/**
 * Which kind of screen this is.
 *
 * Width alone would call a laptop in a narrow window a phone and hand it that
 * phone's type size, so the pointer is consulted too: a coarse pointer at
 * tablet width is a tablet, a fine pointer at any width is a desktop. Read
 * once per load - a reader does not change device mid-session, and re-deciding
 * on every resize would swap their settings while they drag a window.
 */
export function deviceClass(): DeviceClass {
  if (typeof window === 'undefined') return 'desktop';
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const width = Math.min(window.screen?.width || window.innerWidth, window.innerWidth || 9999);
  if (!coarse) return 'desktop';
  return width < 600 ? 'phone' : 'tablet';
}

/** The synced document as this browser last knew it. */
function loadSynced(): SyncedReaderPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY_SYNCED_READER_PREFS;
    const parsed = JSON.parse(raw);
    // Before 0.9 this key held a flat ReaderPrefs object. Fold it into the
    // shared bucket rather than discarding what the reader had chosen.
    if (parsed && typeof parsed === 'object' && !('shared' in parsed)) {
      // The pre-0.2 'serif' choice became a named face.
      if (parsed.font === 'serif') parsed.font = 'iowan';
      // Validated key by key rather than trusted: this is a value that has sat
      // in a browser across many versions, and one setting this build no
      // longer understands must not take the rest of them down with it.
      const kept = readerPrefsSchema.partial().safeParse(parsed);
      const legacy = { ...DEFAULT_READER_PREFS, ...(kept.success ? kept.data : {}) };
      return splitReaderPrefs(legacy, deviceClass(), null, new Date(0).toISOString());
    }
    const ok = syncedReaderPrefsSchema.safeParse(parsed);
    return ok.success ? ok.data : EMPTY_SYNCED_READER_PREFS;
  } catch {
    return EMPTY_SYNCED_READER_PREFS;
  }
}

function storeSynced(next: SyncedReaderPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: the reader still gets their settings for this session */
  }
}

export function loadPrefs(): ReaderPrefs {
  return mergeReaderPrefs(loadSynced(), deviceClass());
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
/** This device's changes that the server has not taken yet, as one patch. */
let pending: SyncedReaderPrefs | null = null;
/** Sends, one after another: two in flight could land in the wrong order. */
let sending: Promise<void> = Promise.resolve();

function keepPending(next: SyncedReaderPrefs | null): void {
  pending = next;
  try {
    if (next) localStorage.setItem(PENDING_KEY, JSON.stringify(next));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* private mode: kept in memory for this session */
  }
}

/** A change an app closed too soon never sent, taken up on the next load. */
function adoptStoredPending(): void {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    const stored = raw ? syncedReaderPrefsSchema.safeParse(JSON.parse(raw)) : null;
    if (stored?.success) {
      pending = pending ? combineReaderPrefsPatches(stored.data, pending) : stored.data;
    }
  } catch {
    /* nothing kept, or nothing readable: nothing to send */
  }
}

async function send(): Promise<void> {
  const patch = pending;
  if (!patch) return;
  keepPending(null);
  try {
    const res = await api<{ reader: unknown }>('/api/prefs/reader', {
      method: 'PATCH',
      body: patch,
    });
    const doc = syncedReaderPrefsSchema.safeParse(res.reader);
    // The server's copy is every device's changes together; anything
    // changed here while this was on its way still goes on top.
    if (doc.success) storeSynced(pending ? applyReaderPrefsPatch(doc.data, pending) : doc.data);
  } catch {
    // Back in line, under anything changed since, for the next change or
    // the next book opened to carry. The local copy already has it.
    keepPending(pending ? combineReaderPrefsPatches(patch, pending) : patch);
  }
}

function push(): Promise<void> {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
  sending = sending.then(send);
  return sending;
}

/**
 * Save locally at once, and to the server shortly afterwards - only the
 * settings that changed from `previous`, which is what this reader was
 * showing. The rest are not this device's to send: another device may have
 * changed them since this one last looked.
 *
 * The push is debounced because the size stepper fires on every press, and
 * a reader adjusting it is making one decision, not eight. A push that fails
 * is kept, here and in storage, for the next change or the next book opened
 * to carry.
 */
export function savePrefs(next: ReaderPrefs, previous: ReaderPrefs): void {
  const changed: Partial<ReaderPrefs> = {};
  for (const key of Object.keys(next) as (keyof ReaderPrefs)[]) {
    if (next[key] !== previous[key]) Object.assign(changed, { [key]: next[key] });
  }
  if (Object.keys(changed).length === 0) return;
  const patch = readerPrefsPatch(changed, deviceClass(), new Date().toISOString());
  storeSynced(applyReaderPrefsPatch(loadSynced(), patch));
  keepPending(pending ? combineReaderPrefsPatches(pending, patch) : patch);
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void push(), 900);
}

/**
 * Take whatever the server has and reconcile it with this browser's copy.
 *
 * Returns the preferences to use now. Called when the reader opens a book and
 * when it comes back to the screen, so a size chosen on the laptop this
 * morning is in place on the phone tonight without either device having to
 * be told about the other.
 */
export async function syncPrefs(): Promise<ReaderPrefs> {
  adoptStoredPending();
  try {
    if (pending) {
      // Sending what this device has not sent brings back everything the
      // other devices changed, in the same answer.
      await push();
    } else {
      const res = await api<{ reader: SyncedReaderPrefs | null }>('/api/prefs/reader');
      // Read after the answer, not before: a change made while it was on its
      // way is in this copy, waiting to be sent, and must not be replaced.
      const local = loadSynced();
      if (!pending) {
        const winner = reconcileReaderPrefs(local, res.reader);
        if (winner !== local) storeSynced(winner);
        // A copy only this browser has - written before changes were sent
        // one at a time, or for a server that has never been told.
        else if (Date.parse(local.updatedAt) > Date.parse(res.reader?.updatedAt ?? '1970-01-01')) {
          void api('/api/prefs/reader', { method: 'PUT', body: local }).catch(() => {});
        }
      }
    }
  } catch {
    /* offline: this browser's copy is what there is */
  }
  return mergeReaderPrefs(loadSynced(), deviceClass());
}

/** Resolve 'auto' against the system appearance. */
export function effectiveTheme(theme: ReaderPrefs['theme'], systemDark: boolean): ReaderTheme {
  if (theme !== 'auto') return theme;
  return systemDark ? 'night' : 'paper';
}

/** Each face's name and note are catalog keys: translated where they are shown. */
export const FONTS: Record<ReaderFont, { label: MessageKey; stack: string; note: MessageKey }> = {
  literata: {
    label: 'reader.font.literata',
    stack: "'Literata', 'Iowan Old Style', Georgia, serif",
    note: 'reader.fontNote.literata',
  },
  iowan: {
    label: 'reader.font.iowan',
    stack: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
    note: 'reader.fontNote.iowan',
  },
  charter: {
    label: 'reader.font.charter',
    stack: "'Charter', 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif",
    note: 'reader.fontNote.charter',
  },
  palatino: {
    label: 'reader.font.palatino',
    stack: "'Palatino', 'Palatino Linotype', 'Book Antiqua', 'URW Palladio L', Georgia, serif",
    note: 'reader.fontNote.palatino',
  },
  georgia: {
    label: 'reader.font.georgia',
    stack: "Georgia, 'Times New Roman', serif",
    note: 'reader.fontNote.georgia',
  },
  baskerville: {
    label: 'reader.font.baskerville',
    stack: "'Baskerville', 'Libre Baskerville', 'Baskerville Old Face', Georgia, serif",
    note: 'reader.fontNote.baskerville',
  },
  sans: {
    label: 'reader.font.sans',
    stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
    note: 'reader.fontNote.sans',
  },
};

/** @deprecated kept for callers that only need the stack */
export const FONT_STACKS: Record<ReaderFont, string> = Object.fromEntries(
  Object.entries(FONTS).map(([k, v]) => [k, v.stack]),
) as Record<ReaderFont, string>;

export const MARGINS: Record<ReaderPrefs['margin'], { padding: number; measure: string }> = {
  compact: { padding: 16, measure: '44em' },
  normal: { padding: 24, measure: '38em' },
  wide: { padding: 40, measure: '32em' },
};

/**
 * The page's type as the custom properties the reader's stylesheet reads.
 * The page and the preview in its settings set these same ones, so the
 * preview cannot drift into showing something the page does not.
 */
export function readerTypeVars(prefs: ReaderPrefs): Record<`--rd-${string}`, string | number> {
  const margins = MARGINS[prefs.margin];
  return {
    '--rd-font': FONTS[prefs.font].stack,
    '--rd-size': `${prefs.size}px`,
    '--rd-weight': prefs.weight,
    '--rd-leading': prefs.lineHeight,
    '--rd-margin': `${margins.padding}px`,
    '--rd-measure': margins.measure,
    '--rd-align': prefs.align,
    '--rd-hyphens': prefs.hyphens ? 'auto' : 'manual',
    '--rd-wash': `${Math.round(prefs.washOpacity * 100)}%`,
  };
}

/* ------------------------------------------------------------ pagination */

export const MAX_PAGE_WIDTH = 1180;
export const TWO_COLUMN_MIN_WIDTH = 900;
/** Horizontal gap between the two columns of a spread. */
export const SPREAD_GUTTER = 72;
/** Extra travel between consecutive single pages during the turn animation. */
export const PAGE_TRAVEL = 48;

export interface PageLayout {
  /** Rendered page-box width (viewport width capped at MAX_PAGE_WIDTH). */
  width: number;
  /** Inset from the viewport edge to the page box (centred). */
  inset: number;
  columns: 1 | 2;
  /** CSS column-gap to set on the content element. */
  columnGap: number;
  /**
   * Horizontal distance between consecutive page origins. With `columns`
   * columns of equal width filling `width - 2·pad` and `columnGap` between
   * them, the first column of page n starts exactly `n · stride` after page
   * 0's, so translating by `-n · stride` lands text at the same inset.
   */
  stride: number;
  pad: number;
  /**
   * The width of one column, declared on the content as well as the count.
   * WebKit lays out `column-count: 1` as no columns at all - one tall
   * column running off the page - and forms them, with the overflow columns
   * that are the pages, only when a width is given.
   */
  columnWidth: number;
}

export function computePageLayout(
  viewportWidth: number,
  pad: number,
  columnsPref: ReaderPrefs['columns'],
): PageLayout {
  const width = Math.max(1, Math.min(viewportWidth, MAX_PAGE_WIDTH));
  const inset = Math.max(0, Math.floor((viewportWidth - width) / 2));
  const columns: 1 | 2 =
    columnsPref === 'two' || (columnsPref === 'auto' && width >= TWO_COLUMN_MIN_WIDTH) ? 2 : 1;
  const columnGap = columns === 2 ? SPREAD_GUTTER : 2 * pad + PAGE_TRAVEL;
  // n equal columns of width c: n·c + (n−1)·gap = width − 2·pad, so
  // stride = n·(c + gap) = width − 2·pad + gap for every n.
  const stride = width - 2 * pad + columnGap;
  const columnWidth = (width - 2 * pad - (columns - 1) * columnGap) / columns;
  return { width, inset, columns, columnGap, stride, pad, columnWidth };
}

/** Number of pages given the content element's scrollWidth. */
export function pageCountFor(scrollWidth: number, layout: PageLayout): number {
  // Last column's right edge + end padding: scrollWidth ≈ pages·stride − gap + 2·pad.
  return Math.max(1, Math.round((scrollWidth + layout.columnGap - 2 * layout.pad) / layout.stride));
}
