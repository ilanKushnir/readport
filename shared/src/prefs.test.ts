import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAYBACK_PREFS,
  DEFAULT_READER_PREFS,
  EMPTY_SYNCED_READER_PREFS,
  PER_BOOK_SPEED_LIMIT,
  type SyncedReaderPrefs,
  applyReaderPrefsPatch,
  combineReaderPrefsPatches,
  mergeReaderPrefs,
  prunePerBookSpeeds,
  readerPrefsPatch,
  reconcileReaderPrefs,
  splitReaderPrefs,
  syncedReaderPrefsSchema,
} from './prefs.js';

/**
 * The judgement this module encodes is which preferences follow the reader and
 * which stay with the screen. Getting it wrong is not a crash - it is a phone
 * quietly resizing the type on a desktop - so it is worth pinning down.
 */

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-06-01T00:00:00.000Z';

describe('splitReaderPrefs', () => {
  it('files taste as shared and screen settings under the device', () => {
    const next = { ...DEFAULT_READER_PREFS, theme: 'night' as const, size: 24 };
    const out = splitReaderPrefs(next, 'phone', null, T1);
    expect(out.shared).toEqual({ theme: 'night' });
    expect(out.byDevice.phone).toEqual({ size: 24 });
  });

  it('stores only what differs from the defaults', () => {
    // A reader who never touched the margins must not pin them, or a later
    // change to the default would never reach them.
    const out = splitReaderPrefs({ ...DEFAULT_READER_PREFS }, 'desktop', null, T1);
    expect(out.shared).toEqual({});
    expect(out.byDevice.desktop).toEqual({});
  });

  it('leaves the other devices alone', () => {
    const previous: SyncedReaderPrefs = {
      shared: {},
      byDevice: { desktop: { size: 17, columns: 'two' } },
      updatedAt: T1,
    };
    const out = splitReaderPrefs({ ...DEFAULT_READER_PREFS, size: 26 }, 'phone', previous, T2);
    expect(out.byDevice.desktop).toEqual({ size: 17, columns: 'two' });
    expect(out.byDevice.phone).toEqual({ size: 26 });
  });

  it('replaces this device’s bucket rather than merging into it', () => {
    // Going back to the default size must clear it, not leave the old number
    // sitting underneath where nothing can reach it.
    const previous: SyncedReaderPrefs = {
      shared: {},
      byDevice: { phone: { size: 26, mode: 'scroll' } },
      updatedAt: T1,
    };
    const out = splitReaderPrefs(
      { ...DEFAULT_READER_PREFS, mode: 'scroll' },
      'phone',
      previous,
      T2,
    );
    expect(out.byDevice.phone).toEqual({ mode: 'scroll' });
  });
});

describe('mergeReaderPrefs', () => {
  const synced: SyncedReaderPrefs = {
    shared: { theme: 'night', font: 'georgia' },
    byDevice: { phone: { size: 26 }, desktop: { size: 17, columns: 'two' } },
    updatedAt: T1,
  };

  it('gives each screen its own answer and the reader their own taste', () => {
    expect(mergeReaderPrefs(synced, 'phone').size).toBe(26);
    expect(mergeReaderPrefs(synced, 'desktop').size).toBe(17);
    expect(mergeReaderPrefs(synced, 'phone').theme).toBe('night');
    expect(mergeReaderPrefs(synced, 'desktop').theme).toBe('night');
  });

  it('falls back to the defaults for a device it has never seen', () => {
    const tablet = mergeReaderPrefs(synced, 'tablet');
    expect(tablet.size).toBe(DEFAULT_READER_PREFS.size);
    expect(tablet.font).toBe('georgia');
  });

  it('is the plain defaults when nothing has ever been stored', () => {
    expect(mergeReaderPrefs(null, 'phone')).toEqual(DEFAULT_READER_PREFS);
    expect(mergeReaderPrefs(EMPTY_SYNCED_READER_PREFS, 'phone')).toEqual(DEFAULT_READER_PREFS);
  });

  it('round-trips through split without drift', () => {
    const chosen = {
      ...DEFAULT_READER_PREFS,
      theme: 'sepia' as const,
      size: 21,
      mode: 'scroll' as const,
    };
    const stored = splitReaderPrefs(chosen, 'tablet', null, T1);
    expect(mergeReaderPrefs(stored, 'tablet')).toEqual(chosen);
  });
});

describe('a stored document', () => {
  it('reads back with nothing added to it', () => {
    // zod fills a default into a partial object too; a default on any field
    // was written into every bucket each time a document was read.
    const doc = {
      shared: { voiceMark: 'wash' },
      byDevice: { phone: { size: 20 } },
      updatedAt: T1,
    };
    expect(syncedReaderPrefsSchema.parse(doc)).toEqual(doc);
  });

  it('keeps a shared choice that a device’s bucket also names', () => {
    // What documents stored that way look like: the default voice mark filed
    // under each device, where it outranked the reader's own choice.
    const polluted: SyncedReaderPrefs = {
      shared: { voiceMark: 'wash', autoScroll: false },
      byDevice: {
        phone: { size: 18, voiceMark: 'margin', autoScroll: true },
        tablet: { margin: 'wide', voiceMark: 'margin' },
      },
      updatedAt: T1,
    };
    const phone = mergeReaderPrefs(polluted, 'phone');
    expect(phone.voiceMark).toBe('wash');
    expect(phone.size).toBe(18);
    expect(phone.autoScroll).toBe(true);
    expect(mergeReaderPrefs(polluted, 'tablet').voiceMark).toBe('wash');
    expect(mergeReaderPrefs(polluted, 'tablet').autoScroll).toBe(false);
  });

  it('is tidied when another device saves', () => {
    const polluted: SyncedReaderPrefs = {
      shared: {},
      byDevice: { tablet: { margin: 'wide', voiceMark: 'margin' } },
      updatedAt: T1,
    };
    const out = splitReaderPrefs({ ...DEFAULT_READER_PREFS, size: 22 }, 'phone', polluted, T2);
    expect(out.byDevice.tablet).toEqual({ margin: 'wide' });
  });
});

describe('a change sent as a patch', () => {
  it('files each setting where it belongs', () => {
    const patch = readerPrefsPatch({ voiceMark: 'wash', size: 23 }, 'phone', T2);
    expect(patch).toEqual({
      shared: { voiceMark: 'wash' },
      byDevice: { phone: { size: 23 } },
      updatedAt: T2,
    });
    expect(readerPrefsPatch({ theme: 'night' }, 'phone', T2).byDevice).toEqual({});
  });

  it('changes only what it names', () => {
    // The tablet was open since yesterday; the phone chose the wash this
    // morning. The tablet's new type size must not take the wash away.
    const stored: SyncedReaderPrefs = {
      shared: { voiceMark: 'wash', theme: 'night' },
      byDevice: { phone: { size: 18 }, tablet: { size: 21 } },
      updatedAt: T1,
    };
    const out = applyReaderPrefsPatch(stored, readerPrefsPatch({ size: 24 }, 'tablet', T2));
    expect(out).toEqual({
      shared: { voiceMark: 'wash', theme: 'night' },
      byDevice: { phone: { size: 18 }, tablet: { size: 24 } },
      updatedAt: T2,
    });
  });

  it('removes a setting put back to its default', () => {
    const stored: SyncedReaderPrefs = {
      shared: { voiceMark: 'wash', washOpacity: 0.3 },
      byDevice: {},
      updatedAt: T1,
    };
    const out = applyReaderPrefsPatch(
      stored,
      readerPrefsPatch(
        { voiceMark: 'margin', washOpacity: DEFAULT_READER_PREFS.washOpacity },
        'phone',
        T2,
      ),
    );
    expect(out.shared).toEqual({});
  });

  it('drops a default an older version stored', () => {
    const stored: SyncedReaderPrefs = {
      shared: {},
      byDevice: { phone: { mode: 'paginated', autoScroll: false, size: 20 } },
      updatedAt: T1,
    };
    const out = applyReaderPrefsPatch(stored, readerPrefsPatch({ theme: 'night' }, 'phone', T2));
    expect(out.byDevice.phone).toEqual({ size: 20 });
  });

  it('starts a document that did not exist, and never goes back in time', () => {
    const first = applyReaderPrefsPatch(null, readerPrefsPatch({ theme: 'sepia' }, 'desktop', T1));
    expect(mergeReaderPrefs(first, 'phone').theme).toBe('sepia');
    const stored: SyncedReaderPrefs = { shared: {}, byDevice: {}, updatedAt: T2 };
    // A device whose clock runs behind still has its change applied.
    const out = applyReaderPrefsPatch(stored, readerPrefsPatch({ theme: 'night' }, 'phone', T1));
    expect(out.shared.theme).toBe('night');
    expect(out.updatedAt).toBe(T2);
  });

  it('combines with a later one, the later winning', () => {
    const a = readerPrefsPatch({ theme: 'sepia', size: 20 }, 'phone', T1);
    const b = readerPrefsPatch({ theme: 'night' }, 'phone', T2);
    expect(combineReaderPrefsPatches(a, b)).toEqual({
      shared: { theme: 'night' },
      byDevice: { phone: { size: 20 } },
      updatedAt: T2,
    });
  });
});

describe('reconcileReaderPrefs', () => {
  const older: SyncedReaderPrefs = { shared: { theme: 'sepia' }, byDevice: {}, updatedAt: T1 };
  const newer: SyncedReaderPrefs = { shared: { theme: 'night' }, byDevice: {}, updatedAt: T2 };

  it('takes the newer write whole', () => {
    expect(reconcileReaderPrefs(older, newer)).toBe(newer);
    expect(reconcileReaderPrefs(newer, older)).toBe(newer);
  });

  it('prefers the server on a tie, so two devices settle on one answer', () => {
    const a: SyncedReaderPrefs = { shared: { theme: 'sepia' }, byDevice: {}, updatedAt: T1 };
    const b: SyncedReaderPrefs = { shared: { theme: 'night' }, byDevice: {}, updatedAt: T1 };
    expect(reconcileReaderPrefs(a, b)).toBe(b);
  });

  it('copes with either side being absent', () => {
    expect(reconcileReaderPrefs(null, newer)).toBe(newer);
    expect(reconcileReaderPrefs(older, null)).toBe(older);
    expect(reconcileReaderPrefs(null, null)).toEqual(EMPTY_SYNCED_READER_PREFS);
  });
});

describe('prunePerBookSpeeds', () => {
  it('leaves a small collection alone', () => {
    const prefs = {
      ...DEFAULT_PLAYBACK_PREFS,
      perBook: { a: { rate: 1.5, at: T1 }, b: { rate: 2, at: T2 } },
    };
    expect(prunePerBookSpeeds(prefs)).toBe(prefs);
  });

  it('keeps the most recently set and drops the rest', () => {
    const perBook: Record<string, { rate: number; at: string }> = {};
    for (let i = 0; i < PER_BOOK_SPEED_LIMIT + 25; i++) {
      perBook[`book${i}`] = { rate: 1.5, at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() };
    }
    const out = prunePerBookSpeeds({ ...DEFAULT_PLAYBACK_PREFS, perBook });
    const kept = Object.keys(out.perBook);
    expect(kept).toHaveLength(PER_BOOK_SPEED_LIMIT);
    // The newest survives, the oldest does not.
    expect(kept).toContain(`book${PER_BOOK_SPEED_LIMIT + 24}`);
    expect(kept).not.toContain('book0');
  });
});
