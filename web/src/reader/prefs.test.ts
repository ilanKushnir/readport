import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import {
  computePageLayout,
  DEFAULT_PREFS,
  effectiveTheme,
  loadPrefs,
  pageCountFor,
  savePrefs,
  syncPrefs,
  TWO_COLUMN_MIN_WIDTH,
} from './prefs';

vi.mock('../api/client', () => ({ api: vi.fn(async () => ({ reader: null })) }));
const apiMock = vi.mocked(api);

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

beforeEach(() => store.clear());

describe('reader prefs', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('round-trips and merges with defaults (forward compatible)', () => {
    savePrefs({ ...DEFAULT_PREFS, theme: 'night', size: 22 }, DEFAULT_PREFS);
    expect(loadPrefs().theme).toBe('night');
    expect(loadPrefs().size).toBe(22);
    // A pref added in a future version falls back to its default.
    store.set('rp-reader-prefs', JSON.stringify({ theme: 'sepia' }));
    const p = loadPrefs();
    expect(p.theme).toBe('sepia');
    expect(p.lineHeight).toBe(DEFAULT_PREFS.lineHeight);
  });

  it('survives corrupt storage', () => {
    store.set('rp-reader-prefs', '{not json');
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });
});

describe('a change to a setting', () => {
  beforeEach(async () => {
    // Whatever an earlier test left to send goes now, not in the middle of this one.
    await syncPrefs();
    store.clear();
    apiMock.mockClear();
  });

  it('is sent alone, over what another device chose since this reader opened', () => {
    // The phone chose the wash this morning; this reader has been open since yesterday.
    store.set(
      'rp-reader-prefs',
      JSON.stringify({
        shared: { voiceMark: 'wash' },
        byDevice: {},
        updatedAt: '2026-09-01T08:00:00.000Z',
      }),
    );
    const yesterday = { ...DEFAULT_PREFS };
    savePrefs({ ...yesterday, theme: 'night' }, yesterday);
    expect(loadPrefs().voiceMark).toBe('wash');
    expect(loadPrefs().theme).toBe('night');
    expect(JSON.parse(store.get('rp-reader-prefs-pending')!).shared).toEqual({ theme: 'night' });
  });

  it('is nothing to send when nothing changed', () => {
    savePrefs({ ...DEFAULT_PREFS }, { ...DEFAULT_PREFS });
    expect(store.has('rp-reader-prefs-pending')).toBe(false);
  });

  it('is sent on the next load when the app closed first, and the answer kept', async () => {
    store.set(
      'rp-reader-prefs-pending',
      JSON.stringify({
        shared: { voiceMark: 'wash' },
        byDevice: {},
        updatedAt: '2026-09-01T08:00:00.000Z',
      }),
    );
    apiMock.mockResolvedValueOnce({
      reader: {
        shared: { voiceMark: 'wash', theme: 'sepia' },
        byDevice: {},
        updatedAt: '2026-09-01T08:00:00.000Z',
      },
    });
    const prefs = await syncPrefs();
    expect(apiMock).toHaveBeenCalledWith(
      '/api/prefs/reader',
      expect.objectContaining({ method: 'PATCH' }),
    );
    expect(prefs.voiceMark).toBe('wash');
    expect(prefs.theme).toBe('sepia');
    expect(store.has('rp-reader-prefs-pending')).toBe(false);
  });

  it('is kept when the server cannot take it', async () => {
    const before = { ...DEFAULT_PREFS };
    savePrefs({ ...before, washOpacity: 0.3 }, before);
    apiMock.mockRejectedValueOnce(new Error('offline'));
    const prefs = await syncPrefs();
    expect(prefs.washOpacity).toBe(0.3);
    expect(JSON.parse(store.get('rp-reader-prefs-pending')!).shared).toEqual({
      washOpacity: 0.3,
    });
  });
});

describe('page layout', () => {
  it('single column: text lands at the same inset on every page', () => {
    // A 375px phone with 24px margins: one column of 327px, and the stride
    // between page origins must equal the column pitch the browser lays out
    // (column width + column gap) - that pitch is what the transform steps by.
    const l = computePageLayout(375, 24, 'auto');
    expect(l.columns).toBe(1);
    expect(l.width).toBe(375);
    const columnWidth = l.width - 2 * l.pad;
    expect(l.stride).toBe(columnWidth + l.columnGap);
    // Page n's first column starts n·stride after page 0's; translating by
    // -n·stride therefore puts it exactly at the 24px inset.
    expect((l.pad + 2 * l.stride) % l.stride).toBe(l.pad);
  });

  it('two columns on wide viewports, capped and centred', () => {
    const l = computePageLayout(1440, 24, 'auto');
    expect(l.columns).toBe(2);
    expect(l.width).toBeLessThanOrEqual(1180);
    expect(l.inset).toBe(Math.floor((1440 - l.width) / 2));
    const columnWidth = (l.width - 2 * l.pad - l.columnGap) / 2;
    expect(l.stride).toBeCloseTo(2 * (columnWidth + l.columnGap), 6);
  });

  it('respects an explicit column preference', () => {
    expect(computePageLayout(1440, 24, 'one').columns).toBe(1);
    expect(computePageLayout(700, 24, 'two').columns).toBe(2);
  });

  it("'auto' crosses the two-column threshold when a tablet is rotated", () => {
    // The sizes a rotation actually moves between. Portrait is one column and
    // landscape is two on every tablet ReadPort ships to; the layout has
    // always known this, and what was missing was anyone asking it again
    // after the rotation. Both are asserted so a change to the threshold has
    // to be a deliberate one.
    for (const [portrait, landscape] of [
      [744, 1133], // iPad mini
      [820, 1180], // iPad
      [834, 1194], // iPad Pro 11"
      [768, 1024], // the classic 4:3 tablet
    ]) {
      expect(computePageLayout(portrait!, 24, 'auto').columns).toBe(1);
      expect(computePageLayout(landscape!, 24, 'auto').columns).toBe(2);
    }
    // The 13" iPad is 1024pt wide standing up, so it is a spread in both
    // orientations and a rotation changes the page width but not the count.
    expect(computePageLayout(1024, 24, 'auto').columns).toBe(2);
    expect(computePageLayout(1366, 24, 'auto').columns).toBe(2);
    // A phone stays one column in both orientations: landscape is far short
    // of the threshold, and two columns of 20 characters is not a spread.
    expect(computePageLayout(390, 24, 'auto').columns).toBe(1);
    expect(computePageLayout(844, 24, 'auto').columns).toBe(1);
    // Exactly at the threshold, and one pixel under it.
    expect(computePageLayout(TWO_COLUMN_MIN_WIDTH, 24, 'auto').columns).toBe(2);
    expect(computePageLayout(TWO_COLUMN_MIN_WIDTH - 1, 24, 'auto').columns).toBe(1);
  });

  it('a page index is only meaningful against the layout it was measured in', () => {
    // Which page a character is on is `x / stride`, and the stride is the
    // page box's width - so measuring against the layout the reader has
    // ROTATED AWAY FROM names a different page. Not a factor of two: the
    // single-page gap already carries the travel between pages, so one and
    // two columns at the same width have almost the same stride. What moves
    // the answer is the width, which is exactly what a rotation changes.
    const portrait = computePageLayout(834, 24, 'auto');
    const landscape = computePageLayout(1194, 24, 'auto');
    expect(portrait.columns).toBe(1);
    expect(landscape.columns).toBe(2);
    const x = 5 * landscape.stride + 10;
    expect(Math.floor(x / landscape.stride)).toBe(5);
    expect(Math.floor(x / portrait.stride)).not.toBe(5);
    // And the page COUNT moves with it, which is what a stale clamp truncates
    // against: the same chapter is fewer, wider pages once it is landscape.
    const scrollWidth = 20 * portrait.stride;
    expect(pageCountFor(scrollWidth, landscape)).toBeLessThan(pageCountFor(scrollWidth, portrait));
  });

  it('derives the page count from the content scrollWidth', () => {
    const l = computePageLayout(375, 24, 'one');
    // Three columns: last right edge = pad + 3·(cw+gap) − gap, plus end padding.
    const cw = l.width - 2 * l.pad;
    const scrollWidth = l.pad + 3 * (cw + l.columnGap) - l.columnGap + l.pad;
    expect(pageCountFor(scrollWidth, l)).toBe(3);
    expect(pageCountFor(0, l)).toBe(1);
  });

  it('auto theme follows the system appearance', () => {
    expect(effectiveTheme('auto', true)).toBe('night');
    expect(effectiveTheme('auto', false)).toBe('paper');
    expect(effectiveTheme('sepia', true)).toBe('sepia');
  });

  it('migrates the retired serif font choice', () => {
    store.set('rp-reader-prefs', JSON.stringify({ font: 'serif' }));
    expect(loadPrefs().font).toBe('iowan');
    store.set('rp-reader-prefs', JSON.stringify({ font: 'comic' }));
    expect(loadPrefs().font).toBe(DEFAULT_PREFS.font);
  });
});
