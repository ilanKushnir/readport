import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { type AudioLocator, type EbookLocator } from '@readport/shared';
import { api, isOffline, notifyUnauthorized } from '../api/client';
import { cachedSwitch } from '../offline/downloads';
import {
  type Annotation,
  type BookDetail,
  type ReaderManifest,
  type ResolveResponse,
  type SentenceIndexEntry,
} from '../lib/types';
import { recordCheckpoint, resumeLocator, setActiveLocatorProvider } from '../progress/engine';
import { Sheet, useToast } from '../components/ui';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { FriendMarkers, FriendsButton, useFriendsOnBook } from '../friends/FriendsOnBar';
import { type MessageKey } from '../i18n/messages/en';
import { useProgressNotices } from '../progress/notices';
import {
  IconBack,
  IconBookmark,
  IconChevronLeft,
  IconCheck,
  IconClose,
  IconHighlighter,
  IconHighlighterOff,
  IconNotes,
  IconTrash,
  IconHeadphones,
  IconReadAlong,
  IconSearch,
  IconShare,
  IconSun,
  IconToc,
  IconType,
} from '../components/icons';
import {
  buildTextMap,
  domToOffset,
  firstVisibleOffset,
  hintForOffset,
  nearestOccurrence,
  rangeForSpan,
  wordEdge,
  type TextMap,
} from './textmap';
import {
  COLOR_LABELS,
  DEFAULT_HIGHLIGHT,
  HIGHLIGHT_COLORS,
  colorOf,
  markAtPoint,
  offsetAtPoint,
  paintFound,
  paintMarks,
  type HighlightColor,
} from './marks';
import { NarrationBar, useNarration } from './Narration';
import { cueForOffset, isConfident, nearestCue, paceOffset, type Cue } from './readalong';
import {
  autoScrollDelta,
  markerPosition,
  canResumeAt,
  GLIDE_MS,
  ScrollGlide,
  ScrollOwnership,
} from './motion';
import { LineOverlay, pageTurning } from './LineOverlay';
import { hostOrigin, outlinePath, outlineRuns } from './overlay';
import { lineBoxes, relativeTo, sameBoxes, type LineBox } from './overlay';
import { trimQuote } from './share';
import { liveCheckpointOffset } from './liveOffset';
import {
  checkpointDue,
  continuedAtDestination,
  landingOffset,
  markerOpacity,
  returnAfterJump,
  type JumpReason,
  type ReadingPoint,
  type ReturnPoint,
} from './continuity';
import { ResumeMarker } from './ResumeMarker';
import {
  clipRects,
  placeSelectionToolbar,
  selectionGeometry,
  type SelectionGeometry,
  type PlacementMode,
} from './selectionPlacement';
import {
  computePageLayout,
  effectiveTheme,
  FONTS,
  loadPrefs,
  syncPrefs,
  MARGINS,
  pageCountFor,
  savePrefs,
  SIZE_MAX,
  SIZE_MIN,
  type PageLayout,
  type ReaderPrefs,
} from './prefs';
import { formatDuration } from '../lib/format';
import { applyAppThemeColor, setThemeColor } from '../lib/themeColor';

type SheetKind = 'none' | 'toc' | 'settings' | 'search' | 'note';

const DARK_MQ = '(prefers-color-scheme: dark)';

/** Reader page backgrounds, mirrored from tokens.css for the status bar. */
const THEME_BG: Record<ReturnType<typeof effectiveTheme>, string> = {
  paper: '#f6f1e8',
  sepia: '#f1e5cf',
  night: '#16120f',
  contrast: '#000000',
};

/**
 * How long the blink at a relocated voice lasts: two gentle pulses, then
 * gone, so the page is never left marked. A little over the animation, so
 * the last frame has been painted before the boxes go.
 */
const BLINK_MS = 1800;

/** What a selection keeps for sharing: more than a note quotes, less than a chapter. */
const SELECTION_TEXT_MAX = 4000;

/**
 * How long a collapsed selection can still be carried over a page turn.
 *
 * Every pointer route to a turn - the edge of the page, the tap zones, a
 * swipe - lands on the page first, and the platform clears the selection on
 * that press, before the turn it was making. Long enough for the turn to
 * follow the press; short enough that a selection dismissed on purpose a
 * while ago is not resurrected by the next turn.
 */
const CARRY_GRACE_MS = 800;

/**
 * Where the narrated line sits in the viewport, as a fraction of the height:
 * where the marker is pinned while auto-scrolling, and where every
 * relocation - a follow jump, "Back to the voice" - puts the line.
 *
 * Slightly above the middle: what you are about to read matters more than
 * what you have read, so the page keeps more text below the line than above.
 * One number, because two used to exist - the jump landed the line at 34%
 * and the marker was drawn at 42% - and after every relocation the marker
 * pointed a hand's width below the words being read.
 */
const AUTO_SCROLL_ANCHOR = 0.4;

/** A finger that moves this far is scrolling; less is a tap with jitter. */
const TOUCH_SLOP_PX = 8;

/** How far under the top chrome a landed line sits, in pixels. */
const LAND_BELOW_CHROME = 28;

/**
 * Where a mark's words are now.
 *
 * A bookmark stores a character offset into the text the reader extracted
 * from the book. Re-extract the book - a different sanitiser, a replaced
 * file - and the offset points at other words with the same confidence. The
 * mark also stores the sentence it was made in, so the words are looked for
 * near the offset: found there, the offset is fine; found elsewhere, the
 * mark moved and the reader is taken to the words; found nowhere, the
 * offset is all there is.
 */
function recoverOffset(
  map: TextMap,
  charOffset: number,
  excerpt: string | null | undefined,
): { charOffset: number; moved: boolean } {
  const probe = (excerpt ?? '').trim().slice(0, 48);
  if (probe.length < 12) return { charOffset, moved: false };
  const found = nearestOccurrence(map, probe, charOffset);
  if (found === null) return { charOffset, moved: false };
  // The stored offset is the first visible character, which sits somewhere
  // inside the sentence the excerpt begins.
  if (charOffset >= found - 2 && charOffset <= found + Math.max(240, (excerpt ?? '').length) + 8)
    return { charOffset, moved: false };
  return { charOffset: found, moved: true };
}

export function ReaderPage() {
  const { id = '' } = useParams();
  const friendsHere = useFriendsOnBook(id || null);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT();
  const f = useFormat();

  const [manifest, setManifest] = useState<ReaderManifest | null>(null);
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [spineIdx, setSpineIdx] = useState<number>(-1);
  const [html, setHtml] = useState<string>('');
  /**
   * Bumped once per completed chapter load.
   *
   * The layout effect used to key off `html`, which fails silently when two
   * consecutive chapters sanitize to the same string - React bails out of the
   * identical setState, the effect never runs, and `chapterLoadingRef` stays
   * true forever, blocking every page turn from then on. A counter always
   * changes.
   */
  const [loadSeq, setLoadSeq] = useState(0);
  const [sentences, setSentences] = useState<SentenceIndexEntry[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs);
  const [chrome, setChrome] = useState(true);
  const [sheet, setSheet] = useState<SheetKind>('none');
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  /**
   * Bumped whenever the chapter is re-laid out for a new size or a settle
   * pass: everything drawn over the text from remembered rectangles has to
   * measure again, and nothing else says the text moved.
   */
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  /**
   * Where the voice starts again after the reader tapped a passage: the
   * sentence to blink, and a nonce so tapping the same one blinks again.
   */
  const [blink, setBlink] = useState<{ start: number; end: number; nonce: number } | null>(null);
  /** The active column's margin and narrated line, in viewport pixels. */
  const [pace, setPace] = useState<{ left: number; top: number; nailed?: boolean } | null>(null);
  /** Keep the pace marker still and scroll the page under it. */
  const [autoScroll, setAutoScroll] = useState(false);
  /**
   * Whether the reader wants auto-scroll back when following resumes. A
   * manual scroll pauses it; it should not have to be switched on again
   * every time "Back to the voice" is pressed.
   */
  const wantAutoScrollRef = useRef(false);
  /** The marker changed column: move it without gliding through the text. */
  const [paceJump, setPaceJump] = useState(false);
  const paceLeftRef = useRef<number | null>(null);
  /** Whether the cue has been off screen since the reader took the wheel. */
  const cueLeftSinceTakeoverRef = useRef(true);
  /** Where a finger landed, so a touch that barely moves is not a scroll. */
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  /** The last time the reader was told a return could not be made. */
  const resumeRefusedAtRef = useRef(0);
  /** Where the scroller should be so the marker sits on the anchor line. */
  const autoScrollTargetRef = useRef<number | null>(null);
  /** Pixels per millisecond the narration is working down the page. */
  const autoScrollSpeedRef = useRef(0);
  /** When the target was last computed, for measuring that speed. */
  const autoScrollAtRef = useRef<number | null>(null);

  /**
   * This chapter would not divide into pages, so it scrolls instead.
   * Per-chapter, not a preference: the next chapter gets a fresh chance.
   */
  const [paginationFailed, setPaginationFailed] = useState(false);
  const [loadError, setLoadError] = useState<MessageKey | null>(null);
  const [selection, setSelection] = useState<{
    start: number;
    end: number;
    /** What a mark stores: the first few hundred characters. */
    text: string;
    /** What is shared or copied: the selection, up to a long paragraph. */
    fullText: string;
    geometry: SelectionGeometry;
  } | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /** The last settled selection, kept a moment past its collapse (see CARRY_GRACE_MS). */
  const recentSelRef = useRef<{ start: number; end: number; collapsedAt: number | null } | null>(
    null,
  );
  /** The frame drawn over a settled selection, in viewport pixels, and where it ends. */
  const [selFrame, setSelFrame] = useState<{
    boxes: LineBox[];
    end: { x: number; y: number };
  } | null>(null);
  /**
   * A selection carried across a page turn.
   *
   * A drag stops at the edge of the page, so a passage that runs on to the
   * next one cannot be selected in one gesture. What survives the turn is
   * not a range - the text it was in has left the screen - but an offset in
   * the chapter, the way a mark is stored, so it outlives any relayout in
   * between. `armed` is the reader having said, on the new page, that their
   * next tap or drag is where the selection ends.
   */
  const [pendingSel, setPendingSel] = useState<{ anchor: number; armed: boolean } | null>(null);
  const pendingSelRef = useRef(pendingSel);
  pendingSelRef.current = pendingSel;
  const [noteDraft, setNoteDraft] = useState('');
  /** Set while the note sheet is editing an existing note rather than making one. */
  const [editingNote, setEditingNote] = useState<string | null>(null);
  /** Mirror of currentOffsetRef for rendering: page turns set it, scroll updates it live. */
  const [liveOffset, setLiveOffset] = useState(0);
  /** Where the reader was before a jump (bookmark, contents, search, slider). */
  const [returnPoint, setReturnPoint] = useState<ReturnPoint | null>(null);
  const [resumeMark, setResumeMark] = useState<(ReadingPoint & { opacity: number }) | null>(null);
  const narrationOffsetRef = useRef<() => number | null>(() => null);
  const readingMoved = useCallback((current: ReadingPoint) => {
    setReturnPoint((point) => (point && continuedAtDestination(point, current) ? null : point));
    setResumeMark((mark) => {
      if (!mark) return null;
      const opacity = Math.min(mark.opacity, markerOpacity(mark, current));
      return opacity <= 0 ? null : opacity === mark.opacity ? mark : { ...mark, opacity };
    });
  }, []);
  const [contentsTab, setContentsTab] = useState<'toc' | 'marks'>('toc');
  /** Read-along: the narration playing over the page the reader is on. */
  const [readAlong, setReadAlong] = useState(false);
  /**
   * The two chrome bars, measured rather than guessed at.
   *
   * The page reserves room for them in its own padding, and the numbers used
   * to be constants - 72 at the top, 64 at the bottom. The bottom bar is 96px
   * with the shipped defaults and 165px once the read-along transport is in
   * it, so the last line of every page sat behind an opaque bar, and with
   * read-along on it was three lines. A constant cannot track a bar whose
   * contents change with a preference.
   */
  const topChromeRef = useRef<HTMLDivElement>(null);
  const bottomChromeRef = useRef<HTMLDivElement>(null);
  const [chromeInset, setChromeInset] = useState({ top: 72, bottom: 64 });
  /**
   * Everything that can move the text without a scroll event saying so.
   * Anything drawn from the text's rectangles measures again when it changes.
   */
  const layoutKey = [
    loadSeq,
    page,
    prefs.mode,
    prefs.size,
    prefs.font,
    prefs.weight,
    prefs.lineHeight,
    prefs.margin,
    prefs.columns,
    prefs.align,
    prefs.hyphens,
    chromeInset.top,
    chromeInset.bottom,
    paginationFailed,
    layoutEpoch,
  ].join(':');

  /** Whether the page still moves itself to keep up with the voice. */
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(following);
  const scrollOwnership = useRef(new ScrollOwnership());
  /** The eased relocation in flight, if any; a manual scroll cancels it. */
  const glideRef = useRef(new ScrollGlide(scrollOwnership.current));
  const manualScrollEpoch = useRef(0);
  followingRef.current = following;
  const [reduceMotion, setReduceMotion] = useState(
    () =>
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  /** Cancel the driver synchronously, before React commits the gesture. */
  const detachFollowing = useCallback(() => {
    manualScrollEpoch.current++;
    glideRef.current.cancel();
    followingRef.current = false;
    cueLeftSinceTakeoverRef.current = false;
    setFollowing(false);
    setAutoScroll((on) => {
      if (on) wantAutoScrollRef.current = true;
      return false;
    });
    autoScrollTargetRef.current = null;
    autoScrollSpeedRef.current = 0;
    autoScrollAtRef.current = null;
  }, []);
  /**
   * Move a scrolling box so a line comes into view: eased, so the eye can
   * follow the text to where it lands, unless the reader asked the system
   * for less motion, in which case the line is simply there.
   */
  const glideTo = useCallback(
    (box: HTMLElement, top: number) => {
      if (reduceMotion) {
        glideRef.current.cancel();
        scrollOwnership.current.write(box, Math.max(0, top));
      } else glideRef.current.start(box, top, GLIDE_MS);
    },
    [reduceMotion],
  );
  /**
   * A page turn made with text selected keeps where the selection began.
   *
   * The range itself cannot stay - its text is leaving the screen, and the
   * platform would go on drawing handles for it - so the DOM selection is
   * let go and its edge kept as a chapter offset, for the pill on the next
   * page to pick up. Turning forward keeps the start and extends onward;
   * turning back keeps the end, so what was selected stays selected.
   */
  const carrySelection = useCallback((dir: 'next' | 'prev') => {
    const recent = recentSelRef.current;
    const sel =
      selectionRef.current ??
      (recent &&
      recent.collapsedAt !== null &&
      performance.now() - recent.collapsedAt < CARRY_GRACE_MS
        ? recent
        : null);
    if (!sel) return;
    recentSelRef.current = null;
    setPendingSel({ anchor: dir === 'next' ? sel.start : sel.end, armed: false });
    setSelection(null);
    document.getSelection()?.removeAllRanges();
  }, []);
  /**
   * Let the selection go, on the page and in the state that follows it, and
   * forget it: a selection the reader dismissed, or has just made a mark
   * from, is not one to carry over the next page turn.
   */
  const clearSelection = useCallback(() => {
    recentSelRef.current = null;
    document.getSelection()?.removeAllRanges();
    setSelection(null);
  }, []);
  /**
   * Finish a carried selection at an offset: the DOM range runs from the
   * anchor to there, whichever way round they are, and the toolbar follows
   * as it would for any selection. The text in between is selected without
   * being seen, which is the point. The end is moved to the edge of its
   * word: a tap lands inside one, and a quotation cut mid-word is nobody's.
   */
  const completeSelection = useCallback((anchor: number, at: number): boolean => {
    const map = textMapRef.current;
    const sel = document.getSelection();
    if (!map || !sel) return false;
    const forward = at >= anchor;
    const edge = wordEdge(map, at, forward ? 'end' : 'start');
    const start = Math.min(anchor, edge);
    const end = Math.max(anchor, edge);
    if (end <= start) return false;
    const range = rangeForSpan(map, start, end);
    if (!range) return false;
    pendingSelRef.current = null;
    setPendingSel(null);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }, []);
  /** An armed tap on the page: the selection ends at the word under it. */
  const extendSelectionTo = useCallback(
    (x: number, y: number): boolean => {
      const pending = pendingSelRef.current;
      if (!pending?.armed) return false;
      const at = offsetAtPoint(textMapRef.current, x, y);
      if (at === null) return false;
      return completeSelection(pending.anchor, at);
    },
    [completeSelection],
  );
  /** The passage a search jumped to: landed on, marked, and then let go. */
  const [found, setFound] = useState<{
    spineIdx: number;
    charOffset: number;
    text: string;
  } | null>(null);

  const [systemDark, setSystemDark] = useState(
    () => typeof matchMedia === 'function' && matchMedia(DARK_MQ).matches,
  );

  const viewportRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const textMapRef = useRef<TextMap | null>(null);
  const layoutRef = useRef<PageLayout | null>(null);
  const currentOffsetRef = useRef(0);
  /** The viewport size the current pagination was measured against. */
  const measuredSizeRef = useRef<{ w: number; h: number } | null>(null);
  /** Trailing re-measures, replaced rather than stacked as events arrive. */
  const relayoutRafRef = useRef(0);
  const relayoutTimersRef = useRef<number[]>([]);
  /** A resize that arrived while the page was hidden, owed on return. */
  const relayoutPendingRef = useRef(false);
  const pendingTargetRef = useRef<{
    charOffset?: number;
    sentenceId?: string;
    initialIntent?: 'open' | 'switch';
    resume?: boolean;
    /** Element id inside the chapter (TOC sub-entries, footnotes). */
    fragment?: string;
    handoff?: boolean;
    granularity?: string;
    /** The words at the mark, for finding it again if the text has moved. */
    excerpt?: string | null;
    /** Point at the landing, the way a resume does. */
    mark?: boolean;
  } | null>(null);
  const handoffCleanupRef = useRef<(() => void) | null>(null);
  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  /** The next deliberate page turn re-claims progress for this session. */
  const needsClaimRef = useRef(true);
  /**
   * True from asking for a chapter until it has rendered and been paginated.
   * `page` and `pageCount` describe the OLD chapter in that window, so a
   * second page turn arriving inside it would be answered with stale numbers
   * - which, at the end of the last-but-one chapter, reads as "past the last
   * page of the last chapter" and marks the book finished.
   */
  const chapterLoadingRef = useRef(false);

  const language = manifest?.language ?? null;
  // Direction from the OPF when declared; otherwise infer from the language
  // so a Hebrew/Arabic book without page-progression-direction still reads
  // right-to-left.
  const rtl =
    manifest?.direction === 'rtl' || (!manifest?.directionDeclared && isRtlLanguage(language));
  const dirFactor = rtl ? 1 : -1;

  /* ------------------------------------------------------------- loading */

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [m, d, anns] = await Promise.all([
          api<ReaderManifest>(`/api/books/${id}/manifest`),
          api<BookDetail>(`/api/books/${id}`),
          api<{ annotations: Annotation[] }>(`/api/books/${id}/annotations`).catch(() => ({
            annotations: [] as Annotation[],
          })),
        ]);
        if (!alive) return;
        setManifest(m);
        setDetail(d);
        setAnnotations(anns.annotations);

        // Initial position: URL params > saved progress > beginning.
        const resume = await resumeLocator(id);
        if (!alive) return;
        const spineParam = searchParams.get('spine');
        const charParam = searchParams.get('char');
        const sentenceParam = searchParams.get('sentence');
        const handoff = searchParams.get('handoff') === '1';
        if (spineParam !== null) {
          const s = Math.min(Math.max(0, Number(spineParam) || 0), m.chapters.length - 1);
          const charOffset = charParam === null ? undefined : Number(charParam) || 0;
          pendingTargetRef.current = {
            charOffset,
            sentenceId: sentenceParam ?? undefined,
            initialIntent: handoff ? 'switch' : 'open',
            handoff,
            granularity: searchParams.get('granularity') ?? undefined,
            mark: !handoff,
          };
          // Arriving at a mark from the Notes or book page moves the reading
          // position, as opening anywhere does. It used to do so silently: a
          // glance at a six-week-old highlight relocated "Continue reading"
          // with no way back. The place they were is known, so offer it.
          if (!handoff && resume?.locator.medium === 'ebook') {
            const from = resume.locator;
            setReturnPoint(
              returnAfterJump(
                {
                  spineIdx: from.spineIdx,
                  charOffset: from.charOffset ?? 0,
                  // Unnamed spine items are called by number where the chip renders.
                  label: m.chapters[from.spineIdx]?.title ?? '',
                },
                { spineIdx: s, charOffset: charOffset ?? 0 },
                'bookmark',
              ),
            );
          }
          setSpineIdx(s);
        } else {
          if (resume && resume.locator.medium === 'ebook') {
            const l = resume.locator;
            pendingTargetRef.current = {
              charOffset: l.charOffset,
              sentenceId: l.sentenceId,
              resume: true,
              initialIntent: 'open',
            };
            setSpineIdx(Math.min(l.spineIdx, m.chapters.length - 1));
          } else {
            pendingTargetRef.current = { charOffset: 0, initialIntent: 'open' };
            setSpineIdx(0);
          }
        }
      } catch {
        if (alive) setLoadError('reader.error.openFailed');
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  // Load chapter content when spineIdx changes.
  useEffect(() => {
    if (spineIdx < 0 || !manifest) return;
    chapterLoadingRef.current = true;
    let alive = true;
    (async () => {
      try {
        const [res, sen] = await Promise.all([
          fetch(`/api/books/${id}/chapter/${spineIdx}`, {
            credentials: 'same-origin',
            headers: { 'x-rp-csrf': '1' },
          }),
          api<{ sentences: SentenceIndexEntry[] }>(`/api/books/${id}/sentences/${spineIdx}`).catch(
            () => ({ sentences: [] as SentenceIndexEntry[] }),
          ),
        ]);
        // This one request cannot go through api() (the body is HTML), so
        // it reports its own 401 - otherwise a revoked session keeps the
        // reader open and blames the network for it.
        if (res.status === 401) await notifyUnauthorized(`/api/books/${id}/chapter/${spineIdx}`);
        if (!res.ok) throw new Error(`chapter ${res.status}`);
        const text = await res.text();
        if (!alive) return;
        setSentences(sen.sentences);
        setHtml(text);
        setLoadSeq((n) => n + 1);
        setLoadError(null);
      } catch {
        if (alive) setLoadError('reader.error.chapterFailed');
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, spineIdx, manifest]);

  /* -------------------------------------------------- layout + position */

  /**
   * Size the centred page box and the multi-column content for the current
   * viewport and prefs. Must run before any geometry is read: changing the
   * column count reflows the chapter.
   */
  const measureLayout = useCallback((): PageLayout | null => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const pages = pagesRef.current;
    if (!viewport || !content || !pages) return null;
    // In landscape on a notched phone the cutout is on one side, so the page
    // box has to start inside it - otherwise a column of text runs underneath
    // the notch and the first characters of every line are hidden.
    const root = getComputedStyle(document.documentElement);
    const safeL = parseFloat(root.getPropertyValue('--rp-safe-left')) || 0;
    const safeR = parseFloat(root.getPropertyValue('--rp-safe-right')) || 0;
    const layout = computePageLayout(
      viewport.clientWidth - safeL - safeR,
      MARGINS[prefs.margin].padding,
      prefs.columns,
    );
    layoutRef.current = layout;
    pages.style.width = `${layout.width}px`;
    // The stride arithmetic stays symmetric because the box itself moved.
    pages.style.left = `${layout.inset + safeL}px`;
    content.style.setProperty('--rd-cols', String(layout.columns));
    content.style.setProperty('--rd-colgap', `${layout.columnGap}px`);
    return layout;
  }, [prefs.margin, prefs.columns]);

  /** Re-measure and return the page count (also pushed to state). */
  const applyPagination = useCallback((): number => {
    const content = contentRef.current;
    if (!content) return 1;
    if (prefs.mode === 'paginated') {
      const layout = measureLayout();
      if (!layout) return 1;
      const count = pageCountFor(content.scrollWidth, layout);
      setPageCount(count);
      return count;
    }
    setPageCount(1);
    return 1;
  }, [prefs.mode, measureLayout]);

  /** Current rendered translateX of the paginated content (mid-transition safe). */
  const currentTx = (content: HTMLElement): number => {
    const t = getComputedStyle(content).transform;
    if (!t || t === 'none') return 0;
    const m = /matrix\(([^)]+)\)/.exec(t);
    return m ? parseFloat(m[1]!.split(',')[4] ?? '0') : 0;
  };

  /**
   * Page index containing a char offset. Measures against the content's
   * ACTUAL rendered transform, so it is correct even while a page-turn
   * transition is running (rects mid-animation would otherwise lie).
   *
   * Null when there is nothing to measure against - no map yet, no layout, an
   * offset the map cannot place. It used to answer zero, which is also a real
   * page, so a failed measurement was indistinguishable from "page one" and
   * every caller obediently sent the reader to the top of the chapter. Each
   * caller now says what it wants to do about a measurement it cannot make.
   */
  const pageForOffset = useCallback(
    (charOffset: number): number | null => {
      const pages = pagesRef.current;
      const content = contentRef.current;
      const map = textMapRef.current;
      const layout = layoutRef.current;
      if (!pages || !content || !map || !layout) return null;
      const range = rangeForSpan(map, charOffset, charOffset + 1);
      if (!range) return null;
      const tx = currentTx(content);
      const r = range.getBoundingClientRect();
      const base = pages.getBoundingClientRect();
      const delta = rtl ? base.right - (r.right - tx) : r.left - tx - base.left;
      return Math.max(0, Math.floor((delta + 2) / layout.stride));
    },
    [rtl],
  );

  const goToPage = useCallback(
    (n: number, intent: 'heartbeat' | 'seek' = 'heartbeat', record = true) => {
      const pages = pagesRef.current;
      const content = contentRef.current;
      const layout = layoutRef.current;
      if (!pages || !content || !manifest || !layout) return;
      // Clamped against the chapter as it is NOW, not against the count the
      // last render happened to see. `pageCount` is state: a lander that has
      // just re-measured is holding a fresher number than this closure can
      // see, and a target past the stale end was silently truncated to it -
      // which is a jump to a mark near the end of a chapter landing on the
      // page before it, exactly as reported.
      const count = pageCountFor(content.scrollWidth, layout);
      if (count !== pageCount) setPageCount(count);
      const clamped = Math.max(0, Math.min(n, count - 1));
      const targetTx = dirFactor * clamped * layout.stride;
      content.style.transform = `translateX(${targetTx}px)`;
      setPage(clamped);
      if (!record) return;
      const map = textMapRef.current;
      if (map) {
        const rect = pages.getBoundingClientRect();
        // Measure the target page's first visible offset against whatever is
        // ACTUALLY rendered, by shifting the page box by the difference
        // between that and the target.
        //
        // Read after the transform is assigned, not before. Before is the
        // page being left, which is right only while a slide is starting and
        // the rendered transform has not moved yet - and wrong by exactly one
        // page when the turn is instant, which it is whenever the reader has
        // chosen instant turns OR asked the system for reduced motion. Those
        // readers had every page turn record the page AFTER the one they were
        // looking at, and every later relayout - an image, a rotation, coming
        // back to the tab - dutifully moved them there.
        const shift = currentTx(content) - targetTx;
        const off = firstVisibleOffset(
          map,
          {
            left: rect.left + shift,
            right: rect.right + shift,
            top: rect.top,
            bottom: rect.bottom,
          },
          hintForOffset(map, currentOffsetRef.current),
        );
        if (off !== null) {
          currentOffsetRef.current = off;
          setLiveOffset(off);
          readingMoved({ spineIdx, charOffset: off });
          // A page turn is a deliberate act: the first one after this surface
          // (re)gained focus is recorded as an explicit intent so this
          // session holds the progress claim again (heartbeats from a
          // session that lost the claim to another device are ignored).
          const effective = needsClaimRef.current && intent === 'heartbeat' ? 'seek' : intent;
          needsClaimRef.current = false;
          void recordCheckpoint(id, effective, locatorAt(manifest, sentences, spineIdx, off));
        }
      }
    },
    [manifest, sentences, spineIdx, pageCount, dirFactor, id],
  );

  // Coming back to a backgrounded tab: re-claim on the next turn, and offer
  // to jump if another device moved further since.
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== 'visible' || !manifest) return;
      needsClaimRef.current = true;
      try {
        const resume = await resumeLocator(id, { activate: false });
        const l = resume?.locator;
        if (!l || l.medium !== 'ebook') return;
        const here = pctFor(manifest, spineIdx, currentOffsetRef.current);
        if (
          Math.abs(l.pct - here) > 0.005 &&
          (l.spineIdx !== spineIdx || l.charOffset !== currentOffsetRef.current)
        ) {
          // An offer, not a report: it stays until the reader takes it or
          // closes it, because the moment to decide is the end of the
          // paragraph they are in, not eight seconds from now.
          toast.show(
            t('reader.toast.otherDeviceAt', { pct: f.percent(l.pct) }),
            {
              label: t('reader.toast.jumpThere'),
              onClick: () => {
                void resumeLocator(id).then(() => {
                  gotoChapterRef.current(l.spineIdx, l.charOffset, 'open', undefined, 'resume', {
                    sentenceId: l.sentenceId,
                    mark: true,
                  });
                });
              },
            },
            { sticky: true },
          );
        }
      } catch {
        /* offline: nothing to reconcile */
      }
    };
    const handler = () => void onVisible();
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [manifest, id, spineIdx, toast, t, f]);
  // Leaving the book takes its offer with it.
  useEffect(() => () => toast.dismiss(), [toast]);

  // After chapter HTML renders: fix asset URLs, build text map, paginate,
  // jump to pending target, paint highlights.
  useLayoutEffect(() => {
    // Cleared before anything can bail out. A chapter that sanitizes to
    // nothing used to return above this line and leave the flag set, which
    // blocks every page turn from then on - the reader simply stops.
    chapterLoadingRef.current = false;
    const content = contentRef.current;
    if (!content || !html || !manifest) return;
    for (const img of Array.from(content.querySelectorAll('img[src^="asset/"]'))) {
      img.setAttribute('src', `/api/books/${id}/${img.getAttribute('src')}`);
    }
    textMapRef.current = buildTextMap(content);
    const count = applyPagination();

    const target = pendingTargetRef.current;
    pendingTargetRef.current = null;
    const map = textMapRef.current;
    let charOffset = target ? landingOffset(target, sentences) : currentOffsetRef.current;
    if (target?.fragment && map) {
      const off = offsetForFragment(content, map, target.fragment);
      if (off !== null) charOffset = off;
    }
    if (target?.excerpt && map) {
      const recovered = recoverOffset(map, charOffset, target.excerpt);
      if (recovered.moved) {
        charOffset = recovered.charOffset;
        toast.show(t('reader.toast.markMoved'));
      }
    }
    currentOffsetRef.current = charOffset;
    setLiveOffset(charOffset);
    // A cross-chapter jump to a fragment or a mark could only name its
    // chapter until now; the chip that offers the way back measures
    // "have they read on from here" against this landing, not the start.
    if (target && (target.fragment || target.sentenceId || target.excerpt))
      setReturnPoint((point) =>
        point && point.destination.spineIdx === spineIdx
          ? { ...point, destination: { spineIdx, charOffset } }
          : point,
      );

    // Resolve legacy sentence-only locators before publishing either the
    // marker or the initial durable checkpoint. Zero is an explicit offset.
    if (target?.resume || target?.handoff || target?.mark)
      setResumeMark({ spineIdx, charOffset, opacity: 1 });
    if (target?.initialIntent && manifest)
      void recordCheckpoint(
        id,
        target.initialIntent,
        locatorAt(manifest, sentences, spineIdx, charOffset),
      );

    if (prefs.mode === 'paginated' && layoutRef.current) {
      // Find the page containing charOffset (transition-safe measurement).
      // A chapter arriving is the one moment where an unmeasurable offset
      // does mean the beginning: the transform still holds the PREVIOUS
      // chapter's page, and leaving it there shows this one from the middle.
      const clamped = Math.min(pageForOffset(charOffset) ?? 0, count - 1);
      content.style.transform = `translateX(${dirFactor * clamped * layoutRef.current.stride}px)`;
      setPage(clamped);
    } else if (map && scrollerRef.current) {
      scrollLineTo(scrollerRef.current, map, charOffset);
    }

    paintMarks(map, annotations, spineIdx);
    if (target?.handoff && target.sentenceId && map) {
      const s = sentences.find((x) => x.id === target.sentenceId);
      if (s) {
        handoffCleanupRef.current?.();
        handoffCleanupRef.current = paintHandoff(map, s.start, s.end);
        toast.show(
          target.granularity && target.granularity !== 'sentence'
            ? t('reader.handoff.near')
            : t('reader.handoff.from'),
        );
      }
    }
  }, [
    loadSeq,
    prefs.mode,
    prefs.size,
    prefs.lineHeight,
    prefs.font,
    prefs.weight,
    prefs.margin,
    prefs.columns,
    prefs.align,
    prefs.hyphens,
  ]);

  /**
   * Pick up preferences changed on another device.
   *
   * Once, when the reader opens a book - not on a timer. Preferences are
   * changed rarely and read constantly, so polling would be all cost; and
   * re-reading them mid-chapter would reflow the page under someone who is
   * reading it. The local copy is what the first paint used, so this can only
   * ever be an improvement on it.
   */
  useEffect(() => {
    let alive = true;
    void syncPrefs().then((p) => {
      if (alive) setPrefs(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Re-paint highlights when annotations change.
  useEffect(() => {
    paintMarks(textMapRef.current, annotations, spineIdx);
  }, [annotations, spineIdx]);

  /**
   * Put a character's line just under the top chrome, in whichever box is
   * scrolling: the scroll-mode scroller, or the page box of a chapter that
   * refused to paginate and scrolls instead.
   *
   * The chrome is measured, not assumed. It is about 60px on a laptop and
   * 110px on a phone with a notch, and a fixed 96px used to land the line
   * behind the bar on exactly the phones where the bar is tallest.
   */
  const scrollLineTo = useCallback(
    (box: HTMLElement, map: TextMap, charOffset: number) => {
      if (charOffset <= 0) {
        // Opening a chapter at its start. Say so absolutely: a relative
        // nudge starts from wherever the PREVIOUS chapter was scrolled to.
        scrollOwnership.current.write(box, 0);
        return;
      }
      const range = rangeForSpan(map, charOffset, charOffset + 1);
      if (!range) return;
      const r = range.getBoundingClientRect();
      const base = box.getBoundingClientRect();
      scrollOwnership.current.write(
        box,
        box.scrollTop + r.top - base.top - (chromeInset.top + LAND_BELOW_CHROME),
      );
    },
    [chromeInset.top],
  );
  /** The latest measurement, for callers that must not re-run when it changes. */
  const scrollLineToRef = useRef(scrollLineTo);
  scrollLineToRef.current = scrollLineTo;
  /** The page box a selection's rectangles are clipped to, when pages turn. */
  const pageClipBox = useCallback(
    (): DOMRect | null =>
      prefs.mode === 'paginated' && !paginationFailed
        ? (pagesRef.current?.getBoundingClientRect() ?? null)
        : null,
    [prefs.mode, paginationFailed],
  );
  /** The element that scrolls right now, or null when pages turn. */
  const scrollBox = useCallback(
    (): HTMLElement | null =>
      prefs.mode === 'scroll' ? scrollerRef.current : paginationFailed ? pagesRef.current : null,
    [prefs.mode, paginationFailed],
  );

  // Restore the current stable text anchor after a layout change, WITHOUT
  // recording progress: automatic reflow is not the reader moving.
  const restoreOffset = useCallback(
    (charOffset: number) => {
      const content = contentRef.current;
      const map = textMapRef.current;
      if (!content || !map) return;
      // Whatever is drawn over the text from remembered rectangles is about
      // to be wrong: say so.
      setLayoutEpoch((n) => n + 1);
      if (prefs.mode === 'paginated' && !paginationFailed) {
        const count = applyPagination();
        const layout = layoutRef.current;
        if (!layout) return;
        const target = pageForOffset(charOffset);
        // Nothing to measure against: leave the reader where they are rather
        // than announcing page one at them.
        if (target === null) return;
        const clamped = Math.min(target, count - 1);
        content.style.transform = `translateX(${dirFactor * clamped * layout.stride}px)`;
        setPage(clamped);
      } else {
        const box = scrollBox();
        if (box) scrollLineTo(box, map, charOffset);
      }
    },
    [
      prefs.mode,
      paginationFailed,
      dirFactor,
      pageForOffset,
      applyPagination,
      scrollBox,
      scrollLineTo,
    ],
  );
  const restoreOffsetRef = useRef(restoreOffset);
  restoreOffsetRef.current = restoreOffset;

  /**
   * Re-measure the page for the size the viewport is NOW.
   *
   * A no-op unless the reader viewport has actually changed size, so it can
   * be called from anything that might have resized it without any of them
   * having to know whether the others already did.
   */
  const relayout = useCallback((force = false) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Nothing can be measured off a page that is not being rendered: a
    // backgrounded tab reports the geometry it had when it went away, or
    // zero. Remember that a measurement is owed and take it on return.
    if (document.hidden) {
      relayoutPendingRef.current = true;
      return;
    }
    const size = { w: viewport.clientWidth, h: viewport.clientHeight };
    const last = measuredSizeRef.current;
    measuredSizeRef.current = size;
    // The first observation only records: the chapter's own landing has
    // just run, and re-landing on top of it would be work for nothing.
    if (last === null && !force) return;
    if (!force && last && last.w === size.w && last.h === size.h) return;
    restoreOffsetRef.current(currentOffsetRef.current);
  }, []);

  /**
   * Measure now, and again once the rotation has actually finished.
   *
   * iPadOS reports the old `clientWidth` for a frame or more after it fires
   * the resize, so a single synchronous read at the event re-paginates the
   * chapter for the orientation the reader has just left - which is how a
   * tablet turned on its side kept one column when two would fit. The extra
   * passes cost a comparison each when nothing moved.
   */
  const scheduleRelayout = useCallback(
    (force = false) => {
      relayout(force);
      if (relayoutRafRef.current) cancelAnimationFrame(relayoutRafRef.current);
      relayoutRafRef.current = requestAnimationFrame(() => {
        relayoutRafRef.current = 0;
        relayout();
      });
      for (const timer of relayoutTimersRef.current) window.clearTimeout(timer);
      relayoutTimersRef.current = [120, 400].map((ms) => window.setTimeout(() => relayout(), ms));
    },
    [relayout],
  );

  useEffect(
    () => () => {
      if (relayoutRafRef.current) cancelAnimationFrame(relayoutRafRef.current);
      for (const timer of relayoutTimersRef.current) window.clearTimeout(timer);
    },
    [],
  );

  useEffect(() => {
    setPaginationFailed(false);
  }, [loadSeq, prefs.mode]);

  // The chapter gave up on pages part-way through settling: the reader is
  // wherever the transform left them, which the fallback ignores. Put the
  // line they were on back under the chrome in the box that now scrolls.
  useEffect(() => {
    if (!paginationFailed) return;
    restoreOffset(currentOffsetRef.current);
  }, [paginationFailed, restoreOffset]);

  /**
   * Measure the chapter again once it has finished becoming itself.
   *
   * Pagination is measured in a layout effect immediately after the chapter
   * HTML is injected - and the line above that rewrites every `img` src, so
   * at measuring time every image in the chapter is zero pixels tall. A
   * chapter with figures fits in one column, `pageCount` becomes 1, and
   * paging switches off. Then the images load, the text grows past the bottom
   * of a page box that cannot scroll, and the rest of the chapter is
   * unreachable: half a sentence at the screen edge and no way to reach the
   * rest. Web fonts do the same thing more quietly, since Literata's metrics
   * differ from the fallback's.
   *
   * Each pass also checks for text that has become trapped. In a correctly
   * paginated chapter the content is exactly as tall as its box and overflows
   * sideways into more columns, so vertical overflow means the columns never
   * formed - a monolithic element too tall to fragment, a publisher
   * stylesheet doing something strange. Whatever the cause, the honest answer
   * is to let that chapter scroll rather than hide the end of it.
   *
   * Every pass re-lands. It used to re-land only when the page COUNT had
   * changed, which is a proxy for "the chapter moved under the reader" and a
   * bad one: a font swapping to Literata, an image arriving mid-chapter or a
   * publisher stylesheet re-breaking the lines all change where a sentence
   * is without changing how many pages there are, and the reader was left on
   * a page number that now holds different words. Re-landing is idempotent -
   * it puts the page holding the offset they are already on back on screen -
   * so doing it every pass costs a measurement and settles nothing wrongly.
   */
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !html || prefs.mode !== 'paginated') return;
    let alive = true;

    const pass = () => {
      const el = contentRef.current;
      if (!alive || !el || prefs.mode !== 'paginated') return;
      // A hidden page has no geometry worth reading; the return handler
      // re-measures, so skipping here loses nothing.
      if (document.hidden) return;
      applyPagination();
      // Reflow is not the reader moving, so this restores rather than records.
      restoreOffset(currentOffsetRef.current);
      // Trapped text is judged by geometry, not by scrollHeight, which
      // WebKit reports for a multi-column box as if it were one column - so
      // every chapter longer than a page "failed" on an iPhone and scrolled.
      // Judged only while the chapter is still in columns. Once it scrolls
      // nothing is trapped, by construction - and judging it there used to
      // put it back into columns, where it was trapped again, and so on at
      // the speed of a render: the text and the footer blinking between the
      // two layouts while the tab ground to a halt. The fallback holds until
      // the chapter is loaded again or the mode changes; a late image can
      // still tip a paged chapter into it, which is the case that matters.
      if (!el.classList.contains('is-unpaginated') && trappedContent(el)) setPaginationFailed(true);
    };

    const pending = Array.from(content.querySelectorAll('img')).filter((img) => !img.complete);
    for (const img of pending) {
      img.addEventListener('load', pass);
      img.addEventListener('error', pass);
    }
    void document.fonts?.ready.then(pass);
    // Spaced passes for everything the events do not cover: a slow decode, a
    // late stylesheet, a publisher script. Cheap, and bounded.
    const timers = [250, 1200, 3000].map((ms) => window.setTimeout(pass, ms));
    // Whatever the timers could not measure while the page was in the
    // background, measure the moment it is on screen again.
    document.addEventListener('visibilitychange', pass);

    return () => {
      alive = false;
      for (const t of timers) window.clearTimeout(t);
      document.removeEventListener('visibilitychange', pass);
      for (const img of pending) {
        img.removeEventListener('load', pass);
        img.removeEventListener('error', pass);
      }
    };
  }, [loadSeq, html, prefs.mode, applyPagination, restoreOffset]);

  /**
   * Keep the page's reserved space equal to the chrome that actually covers it.
   *
   * Watched rather than computed: the bottom bar grows when read-along mounts
   * its transport, shrinks when the progress bar is set to compact or hidden,
   * and changes again with the safe-area inset on a phone that rotates. A
   * change in height changes how many lines fit, so the columns are re-laid
   * out and the reader is put back on the line they were on.
   */
  useEffect(() => {
    const top = topChromeRef.current;
    const bottom = bottomChromeRef.current;
    if (!top || !bottom) return;
    const measure = () => {
      const next = {
        top: Math.round(top.getBoundingClientRect().height),
        bottom: Math.round(bottom.getBoundingClientRect().height),
      };
      setChromeInset((prev) =>
        prev.top === next.top && prev.bottom === next.bottom ? prev : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(top);
    ro.observe(bottom);
    return () => ro.disconnect();
  }, [prefs.progressBar, readAlong, html]);

  // A different reserve means a different column height, so the chapter has a
  // different number of pages. Re-lay it out and stay on the same sentence.
  useEffect(() => {
    if (prefs.mode !== 'paginated') return;
    restoreOffset(currentOffsetRef.current);
  }, [chromeInset.top, chromeInset.bottom, prefs.mode, restoreOffset]);

  /**
   * Resize and rotation re-pagination: keep the reader on the sentence they
   * were on. Never page-zero, never a progress write.
   *
   * Watched on the ELEMENT, not only on the window. `resize` is a statement
   * about the window, and the one thing that has to be true before the page
   * can be re-measured is that the page box has the new size - which on
   * iPadOS it does not yet when the event arrives. A ResizeObserver on the
   * viewport fires when that box actually changes, which is the fact the
   * measurement depends on; the window events are kept because they arrive
   * first and start the settle, and because a box that ends up the same size
   * makes every pass a no-op anyway.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    const onResize = () => scheduleRelayout();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    const ro = viewport ? new ResizeObserver(onResize) : null;
    if (viewport) ro?.observe(viewport);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, [scheduleRelayout]);

  /**
   * Coming back to the page, from another app or out of the back/forward
   * cache: measure before anything is read from geometry.
   *
   * A tablet rotated while ReadPort was in the background comes back to a
   * viewport it has never measured and no resize event to say so - the
   * resize fired against a page that was not rendering, and `clientWidth`
   * answered with whatever it had. Paginated mode is re-landed on return
   * whether or not the size changed, because the transform that decides
   * which page is showing is the one thing a restore cannot infer.
   */
  useEffect(() => {
    const onReturn = () => {
      if (document.hidden) return;
      const owed = relayoutPendingRef.current;
      relayoutPendingRef.current = false;
      scheduleRelayout(owed || (prefs.mode === 'paginated' && !paginationFailed));
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('pageshow', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('pageshow', onReturn);
    };
  }, [scheduleRelayout, prefs.mode, paginationFailed]);

  // Follow the system appearance for the 'auto' theme.
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(DARK_MQ);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const theme = effectiveTheme(prefs.theme, systemDark);

  // Standalone iPhone: the status bar takes the page's theme-color, so the
  // reader paints it in its own theme and restores the app colour on exit.
  useEffect(() => {
    setThemeColor(THEME_BG[theme]);
    return () => applyAppThemeColor();
  }, [theme]);

  // Lifecycle persistence: expose the LIVE reading position so backgrounding
  // the tab records it even inside the scroll debounce window. In scroll
  // mode the offset is computed synchronously from live scroll geometry at
  // checkpoint time - the debounced ref may be up to 600ms stale.
  useEffect(() => {
    if (!manifest) return;
    return setActiveLocatorProvider(() => {
      if (chapterLoadingRef.current || spineIdx < 0) return null;
      const stillAtResume =
        resumeMark &&
        (prefs.mode === 'paginated' ||
          (scrollerRef.current && scrollOwnership.current.matches(scrollerRef.current)));
      const off =
        narrationOffsetRef.current() ??
        (stillAtResume
          ? currentOffsetRef.current
          : liveCheckpointOffset(
              prefs.mode,
              currentOffsetRef.current,
              textMapRef.current,
              scrollerRef.current,
            ));
      currentOffsetRef.current = off;
      return { bookId: id, locator: locatorAt(manifest, sentences, spineIdx, off) };
    });
  }, [manifest, sentences, spineIdx, id, prefs.mode, resumeMark]);

  useProgressNotices(id, () =>
    manifest ? locatorAt(manifest, sentences, spineIdx, currentOffsetRef.current) : null,
  );

  // Scroll-mode position tracking. The paginated fallback - a chapter that
  // would not divide into pages and scrolls instead - is a scroller too, and
  // used to be tracked by nothing: progress stayed where the chapter was
  // entered, however far down it the reader went.
  useEffect(() => {
    const scroller =
      prefs.mode === 'scroll' ? scrollerRef.current : paginationFailed ? pagesRef.current : null;
    if (!scroller || !manifest) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let footerTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (scrollOwnership.current.matches(scroller)) return;
      detachFollowing();
      // Footer: cheap, throttled to ~12 updates/s (a timer, not rAF, so a
      // backgrounded tab still lands on the right value when it returns).
      if (!footerTimer) {
        footerTimer = setTimeout(() => {
          footerTimer = null;
          const map = textMapRef.current;
          if (!map) return;
          const off = firstVisibleOffset(
            map,
            scroller.getBoundingClientRect(),
            hintForOffset(map, currentOffsetRef.current),
          );
          if (off !== null) {
            setLiveOffset(off);
            readingMoved({ spineIdx, charOffset: off });
          }
        }, 80);
      }
      // Progress checkpoint: debounced.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const map = textMapRef.current;
        if (!map) return;
        const rect = scroller.getBoundingClientRect();
        const off = firstVisibleOffset(map, rect, hintForOffset(map, currentOffsetRef.current));
        if (off !== null && Math.abs(off - currentOffsetRef.current) > 40) {
          currentOffsetRef.current = off;
          // Scrolling on is as deliberate as turning a page: the first
          // checkpoint after this surface (re)gained focus takes the
          // progress claim back, so a session that lost it to another device
          // is not reduced to heartbeats nobody applies.
          const effective = needsClaimRef.current ? 'seek' : 'heartbeat';
          needsClaimRef.current = false;
          void recordCheckpoint(id, effective, locatorAt(manifest, sentences, spineIdx, off));
        }
      }, 600);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
      if (footerTimer) clearTimeout(footerTimer);
    };
  }, [prefs.mode, paginationFailed, manifest, sentences, spineIdx, id, html]);

  /* ----------------------------------------------------------- actions */

  const gotoChapter = useCallback(
    (
      s: number,
      charOffset: number | undefined,
      intent: 'seek' | 'open',
      fragment: string | undefined,
      reason: JumpReason,
      extra: { sentenceId?: string; excerpt?: string | null; mark?: boolean } = {},
    ) => {
      if (!manifest) return;
      // A mark made before offsets were stored names only its sentence; the
      // sentence index of the current chapter can place it now, and the
      // target chapter's can once it has loaded.
      charOffset = charOffset ?? (s === spineIdx ? landingOffset(extra, sentences) : 0);
      // Jumping by hand - contents, search, a bookmark, the slider - takes the
      // wheel back from the narration, exactly as turning a page does. The one
      // caller that must not is the narration itself, which re-arms after.
      detachFollowing();
      const clamped = Math.max(0, Math.min(s, manifest.chapters.length - 1));
      const owned = scrollerRef.current && scrollOwnership.current.matches(scrollerRef.current);
      const origin = {
        spineIdx,
        charOffset: owned
          ? currentOffsetRef.current
          : liveCheckpointOffset(
              prefs.mode,
              currentOffsetRef.current,
              textMapRef.current,
              scrollerRef.current,
            ),
        label: manifest.chapters[spineIdx]?.title ?? '',
      };
      if (fragment && clamped === spineIdx && contentRef.current && textMapRef.current) {
        charOffset =
          offsetForFragment(contentRef.current, textMapRef.current, fragment) ?? charOffset;
      }
      setReturnPoint(
        returnAfterJump(
          origin,
          { spineIdx: clamped, charOffset },
          intent === 'open' ? 'resume' : reason,
        ),
      );
      if (!extra.mark) setResumeMark(null);
      handoffCleanupRef.current?.();
      pendingTargetRef.current = {
        charOffset,
        fragment,
        sentenceId: extra.sentenceId,
        excerpt: extra.excerpt,
        mark: extra.mark,
      };
      if (clamped === spineIdx) {
        // Same chapter: jump directly without re-rendering the HTML.
        const map = textMapRef.current;
        const content = contentRef.current;
        if (map && content) {
          pendingTargetRef.current = null;
          if (fragment) {
            const off = offsetForFragment(content, map, fragment);
            if (off !== null) charOffset = off;
          }
          if (extra.excerpt) {
            const recovered = recoverOffset(map, charOffset, extra.excerpt);
            if (recovered.moved) {
              charOffset = recovered.charOffset;
              toast.show(t('reader.toast.markMoved'));
            }
          }
          currentOffsetRef.current = charOffset;
          if (prefs.mode === 'paginated' && !paginationFailed) {
            // Measure before landing. This was the one lander that asked
            // which page an offset is on without first re-laying the chapter
            // out for the size the screen is now - so a mark opened after a
            // rotation, or after a settle changed the page count, was placed
            // against the layout the reader had left, and the jump arrived a
            // page short of the highlight.
            restoreOffset(charOffset);
          } else {
            const box = scrollBox();
            if (box) scrollLineTo(box, map, charOffset);
          }
          if (extra.mark) setResumeMark({ spineIdx, charOffset, opacity: 1 });
          // And check it arrived. The search path has verified its landing on
          // the next frame for as long as it has existed - the layout can
          // still be settling when a sheet closes and hands the viewport
          // back - and a jump to a mark is the same act with the same risk.
          const landed = charOffset;
          requestAnimationFrame(() => {
            const here = textMapRef.current;
            const box = (
              prefs.mode === 'paginated' && !paginationFailed
                ? pagesRef.current
                : scrollerRef.current
            )?.getBoundingClientRect();
            if (here && !spanOnScreen(here, landed, box)) restoreOffsetRef.current(landed);
          });
        }
      } else {
        chapterLoadingRef.current = true;
        setSpineIdx(clamped);
      }
      setLiveOffset(charOffset);
      void recordCheckpoint(
        id,
        intent,
        locatorAt(manifest, clamped === spineIdx ? sentences : [], clamped, charOffset),
      );
    },
    [
      manifest,
      spineIdx,
      prefs.mode,
      paginationFailed,
      restoreOffset,
      sentences,
      id,
      scrollBox,
      scrollLineTo,
      toast,
      t,
    ],
  );
  const gotoChapterRef = useRef(gotoChapter);
  gotoChapterRef.current = gotoChapter;

  /**
   * Mark the book read.
   *
   * Lifted out of nextPage, which only reaches it by turning past the last
   * page - a thing scroll mode has no way to do, so in scroll mode a book
   * could never be finished and the "Finish book" button at the end of the
   * last chapter did nothing at all.
   */
  const finishBook = useCallback(() => {
    if (!manifest || spineIdx < manifest.chapters.length - 1) return;
    const last = Math.max(0, (manifest.chapters[spineIdx]?.charCount ?? 1) - 1);
    void recordCheckpoint(id, 'finish', {
      ...locatorAt(manifest, sentences, spineIdx, last),
      pct: 1,
    });
    toast.show(t('reader.toast.finished'));
  }, [manifest, spineIdx, sentences, id, toast, t]);

  const nextPage = useCallback(() => {
    if (chapterLoadingRef.current) return;
    // Only an explicit successful relocation gives the voice control again.
    detachFollowing();
    if (prefs.mode === 'scroll') {
      const s = scrollerRef.current;
      if (s) s.scrollTop += s.clientHeight * 0.9;
      return;
    }
    if (page < pageCount - 1) {
      carrySelection('next');
      goToPage(page + 1);
    } else if (manifest && spineIdx < manifest.chapters.length - 1)
      gotoChapter(spineIdx + 1, 0, 'seek', undefined, 'progression');
    else if (manifest) finishBook();
  }, [
    prefs.mode,
    page,
    pageCount,
    manifest,
    spineIdx,
    goToPage,
    gotoChapter,
    carrySelection,
    id,
    sentences,
    toast,
  ]);

  const prevPage = useCallback(() => {
    if (chapterLoadingRef.current) return;
    detachFollowing();
    if (prefs.mode === 'scroll') {
      const s = scrollerRef.current;
      if (s) s.scrollTop -= s.clientHeight * 0.9;
      return;
    }
    if (page > 0) {
      carrySelection('prev');
      goToPage(page - 1);
    } else if (spineIdx > 0 && manifest) {
      readingMoved({ spineIdx: spineIdx - 1, charOffset: 0 });
      // Land on the previous chapter's end.
      const back = Math.max(0, (manifest.chapters[spineIdx - 1]?.charCount ?? 1) - 2);
      pendingTargetRef.current = { charOffset: back };
      setSpineIdx(spineIdx - 1);
      // Record the crossing itself: the next checkpoint only comes with the
      // next turn, so a tab that dies here would leave progress a whole
      // chapter ahead of where the reader actually is. The new chapter's
      // sentence index is not loaded yet, hence no sentenceId.
      needsClaimRef.current = false;
      void recordCheckpoint(id, 'seek', locatorAt(manifest, [], spineIdx - 1, back));
    }
  }, [prefs.mode, page, spineIdx, manifest, goToPage, carrySelection, id]);

  /* -------------------------------------------------------- read along */

  const pair =
    detail?.book.pair && detail.book.pair.status !== 'candidate' ? detail.book.pair : null;
  const startOffset = useCallback(() => currentOffsetRef.current, []);

  /**
   * The narration has run off the end (or the start) of this chapter. Follow
   * it, and stay in follow mode - this is the voice moving the page, which is
   * the whole point, not the reader taking over.
   */
  const onLeaveChapter = useCallback(
    (dir: 'next' | 'prev', to?: number) => {
      if (!manifest || chapterLoadingRef.current) return;
      const target = to ?? (dir === 'next' ? spineIdx + 1 : spineIdx - 1);
      if (target < 0 || target >= manifest.chapters.length || target === spineIdx) return;
      const offset =
        dir === 'next' ? 0 : Math.max(0, (manifest.chapters[target]?.charCount ?? 1) - 2);
      // Deliberately not gotoChapter: this is the voice carrying the page, not
      // the reader jumping. It must leave no "back to where you were" chip
      // behind, and must not release auto-follow the way a jump does.
      handoffCleanupRef.current?.();
      pendingTargetRef.current = { charOffset: offset };
      readingMoved({ spineIdx: target, charOffset: offset });
      chapterLoadingRef.current = true;
      setSpineIdx(target);
      needsClaimRef.current = false;
      void recordCheckpoint(id, 'seek', locatorAt(manifest, [], target, offset));
    },
    [manifest, spineIdx, id],
  );

  const narration = useNarration({
    enabled: readAlong,
    following,
    pairId: pair?.pairId ?? null,
    audioBookId: pair?.otherBookId ?? null,
    spineIdx,
    sentences,
    startOffset,
    onLeaveChapter,
  });

  // Read the media element clock at capture time, not React's last timeupdate.
  narrationOffsetRef.current = () =>
    readAlong && followingRef.current
      ? paceOffset(narration.cues, narration.currentBookMs?.() ?? narration.bookMs)
      : null;
  useEffect(() => {
    if (!readAlong || !manifest) return;
    let last = performance.now();
    let saved = currentOffsetRef.current;
    const timer = setInterval(() => {
      if (chapterLoadingRef.current || !followingRef.current || !narration.playing) return;
      const at = narrationOffsetRef.current();
      if (at === null) return;
      const off = Math.round(at);
      readingMoved({ spineIdx, charOffset: off });
      if (!checkpointDue(last, performance.now(), off !== saved)) return;
      saved = off;
      last = performance.now();
      currentOffsetRef.current = off;
      void recordCheckpoint(id, 'heartbeat', locatorAt(manifest, sentences, spineIdx, off));
    }, 500);
    return () => clearInterval(timer);
  }, [readAlong, manifest, spineIdx, sentences, id, narration.playing, readingMoved]);

  /**
   * Relocate first, verify the rendered cue, then give the voice control.
   *
   * The voice may be in another chapter altogether - it wandered on while
   * the reader looked something up - and then there is nothing on this page
   * to attach to. With the book's chapter bounds that chapter is opened
   * directly, paused or playing, and the page attaches once it is up. It
   * used to attach to the nearest cue of whatever chapter was open, which was
   * the wrong chapter by definition, and then walk from there.
   */
  const resumeFollowing = useCallback(
    (enableAuto?: boolean): boolean => {
      const auto = enableAuto ?? (wantAutoScrollRef.current || prefs.autoScroll);
      const map = textMapRef.current;
      const content = contentRef.current;
      if (!readAlong || !narration.ready || chapterLoadingRef.current || !map || !content)
        return false;
      const at = narration.bookMs;
      if (narration.state === 'before' || narration.state === 'after') {
        const there = narration.chapterAt(at);
        if (there !== null && there !== spineIdx) {
          followingRef.current = true;
          cueLeftSinceTakeoverRef.current = true;
          setFollowing(true);
          if (auto) setAutoScroll(!reduceMotion);
          onLeaveChapter(there > spineIdx ? 'next' : 'prev', there);
          return true;
        }
        // No bounds to consult (an older server): while playing, the walker
        // finds the way; paused, nothing can, and the reader is told.
        if (there === null && narration.playing) {
          followingRef.current = true;
          setFollowing(true);
          return true;
        }
      }
      const cue = narration.cue ?? nearestCue(narration.cues, at);
      if (!cue) return false;
      if (!canResumeAt(narration.state, at, narration.playing)) return false;
      // rangeForSpan clamps offsets; a clamped invalid cue is not a relocation.
      if (cue.charStart < 0 || cue.charStart >= map.totalChars) return false;
      const range = rangeForSpan(map, cue.charStart, cue.charStart + 1);
      if (!range || range.getBoundingClientRect().height <= 0) return false;
      const paged = prefs.mode === 'paginated' && !paginationFailed;
      const box = prefs.mode === 'paginated' ? pagesRef.current : scrollerRef.current;
      if (!box) return false;
      // The page the voice is on: mid-sentence, that can be the page after
      // the one the sentence starts on.
      const spoken =
        narration.cue === cue ? spokenOffset(narration.cues, cue, narration.bookMs) : cue.charStart;
      if (paged) {
        if (!layoutRef.current) return false;
        const target = pageForOffset(spoken);
        // No page to name is no relocation: the caller tells the reader that
        // the voice could not be found rather than moving them anywhere.
        if (target === null || target >= pageCount) return false;
        // Explicit relocation is atomic, not an attachment to a page mid-slide.
        const transition = content.style.transition;
        content.style.transition = 'none';
        goToPage(target, 'heartbeat', false);
        content.getBoundingClientRect();
        content.style.transition = transition;
      } else {
        const r = range.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        const want = box.scrollTop + r.top - b.top + r.height / 2 - b.height * AUTO_SCROLL_ANCHOR;
        // Checked against the page as it will be once the glide has landed,
        // because the glide has not moved anything yet.
        const delta =
          Math.max(0, Math.min(want, box.scrollHeight - box.clientHeight)) - box.scrollTop;
        if (!spanOnScreen(map, cue.charStart, shifted(b, delta))) return false;
        glideTo(box, want);
      }
      if (paged && !spanOnScreen(map, spoken, box.getBoundingClientRect())) return false;
      // Late layout/image passes must preserve this relocation, not the old landing.
      currentOffsetRef.current = cue.charStart;
      setLiveOffset(cue.charStart);
      autoScrollTargetRef.current = null;
      autoScrollSpeedRef.current = 0;
      autoScrollAtRef.current = null;
      followingRef.current = true;
      cueLeftSinceTakeoverRef.current = true;
      setFollowing(true);
      if (auto && !paged) setAutoScroll(!reduceMotion);
      return true;
    },
    [
      narration.cue,
      narration.cues,
      narration.bookMs,
      narration.ready,
      narration.playing,
      narration.state,
      narration.chapterAt,
      reduceMotion,
      readAlong,
      prefs.mode,
      prefs.autoScroll,
      paginationFailed,
      pageCount,
      pageForOffset,
      goToPage,
      glideTo,
      onLeaveChapter,
      spineIdx,
    ],
  );

  /** "Back to the voice", with a sentence when it cannot be done. */
  const returnToVoice = useCallback(() => {
    if (resumeFollowing()) return;
    const now = Date.now();
    if (now - resumeRefusedAtRef.current < 4000) return;
    resumeRefusedAtRef.current = now;
    toast.show(
      !narration.ready
        ? t('reader.readAlong.stillLoading')
        : narration.state === 'before' || narration.state === 'after'
          ? t('reader.readAlong.voiceElsewhere')
          : t('reader.readAlong.noTimedText'),
    );
  }, [resumeFollowing, narration.ready, narration.state, toast, t]);

  /**
   * Bring the page to the sentence being spoken.
   *
   * The sentence itself is drawn by the spoken-mark overlay below, measured
   * from the text at draw time. Following is abandoned as soon as the reader
   * moves the page. Only an explicit relocation gives control back, so the
   * return target stays put.
   */
  useEffect(() => {
    const map = textMapRef.current;
    if (!readAlong) return;
    const cue = narration.cue;
    if (!cue || !map) return;
    const paged = prefs.mode === 'paginated' && !paginationFailed;
    const box = prefs.mode === 'paginated' ? pagesRef.current : scrollerRef.current;
    // Judged by where the voice IS in the sentence, not by the sentence's
    // first character: a sentence the page ends in the middle of has its
    // start on this page and its voice, before long, on the next - and a
    // page turned to the voice must not be pulled back to the start.
    const spoken = spokenOffset(narration.cues, cue, narration.bookMs);
    const onScreen = spanOnScreen(map, spoken, box?.getBoundingClientRect());
    if (!following || !followingRef.current) {
      // The reader took the wheel. Following comes back on its own the
      // moment the voice reaches the page they went to - once it has been
      // off that page at all, or the very next tick would undo a deliberate
      // scroll in scroll mode, where "on screen" is most of a chapter.
      if (!onScreen) cueLeftSinceTakeoverRef.current = true;
      else if (cueLeftSinceTakeoverRef.current) {
        followingRef.current = true;
        setFollowing(true);
        if (!paged && (wantAutoScrollRef.current || prefs.autoScroll)) setAutoScroll(!reduceMotion);
      }
      return;
    }
    if (onScreen) return;
    if (paged) {
      const target = pageForOffset(spoken);
      if (target !== null && target !== page) goToPage(target, 'heartbeat', false);
      // The page is no longer where the chapter landed, and the tracked
      // offset has to say so - the same thing the scroll branch below has
      // always done. Without it the next relayout (an image arriving, a
      // rotation, coming back to the tab) reads a position the voice left
      // long ago and yanks the reader back to it mid-sentence.
      if (target !== null) currentOffsetRef.current = spoken;
    } else {
      const range = rangeForSpan(map, cue.charStart, cue.charStart + 1);
      if (range && box) {
        const r = range.getBoundingClientRect();
        const base = box.getBoundingClientRect();
        const want = box.scrollTop + r.top - base.top - base.height * AUTO_SCROLL_ANCHOR;
        // Auto-scrolling glides; the jump here is for when the line is too
        // far for a glide to be anything but a long wait.
        if (autoScroll && !reduceMotion && Math.abs(want - box.scrollTop) < base.height * 1.5)
          return;
        glideTo(box, want);
        // The page is no longer where the chapter landed, and the tracked
        // offset has to say so. A late layout pass - the settle re-land
        // below, an image arriving - otherwise reads a position the voice
        // moved away from long ago and puts the reader back on it, which
        // with reduced motion (no glide to correct it) means the top of the
        // chapter mid-sentence.
        currentOffsetRef.current = cue.charStart;
      }
    }
  }, [
    readAlong,
    narration.cue,
    following,
    prefs.mode,
    prefs.autoScroll,
    paginationFailed,
    autoScroll,
    reduceMotion,
    page,
    goToPage,
    glideTo,
    pageForOffset,
    chromeInset.bottom,
  ]);

  /**
   * A sentence that runs off the page.
   *
   * Following turns the page when a sentence STARTS off it, which is right
   * for every sentence but the one the page ends in the middle of: its
   * start is on the page, so nothing turns, and the voice reads the rest of
   * it - two lines, or ten - from a page the reader cannot see. The voice's
   * place inside a sentence is the pace estimate, the same one the margin
   * tick is drawn from; once that place has crossed onto the next page, the
   * page turns to it. Forward only, and only to the very next page: an
   * estimate is reason enough to turn a page on, and not to turn one back.
   */
  useEffect(() => {
    if (!readAlong || !following || !followingRef.current || !narration.playing) return;
    if (prefs.mode !== 'paginated' || paginationFailed) return;
    const map = textMapRef.current;
    const cue = narration.cue;
    const box = pagesRef.current;
    if (!cue || !map || !box || !layoutRef.current) return;
    const offset = spokenOffset(narration.cues, cue, narration.bookMs);
    if (offset <= cue.charStart) return;
    if (spanOnScreen(map, offset, box.getBoundingClientRect())) return;
    const target = pageForOffset(offset);
    if (target !== page + 1 || target >= pageCount) return;
    goToPage(target, 'heartbeat', false);
    currentOffsetRef.current = offset;
  }, [
    readAlong,
    following,
    narration.playing,
    narration.cue,
    narration.cues,
    narration.bookMs,
    prefs.mode,
    paginationFailed,
    page,
    pageCount,
    pageForOffset,
    goToPage,
  ]);

  /**
   * Land on a search hit, verifiably, and mark it.
   *
   * The jump itself measured the target page against the layout as it was at
   * the moment the result was pressed. On a phone that is the wrong moment:
   * the sheet holding the on-screen keyboard is closing, and the viewport is
   * about to change size and re-paginate underneath the answer. So the hit is
   * checked once more on the next frame and, if it is not actually on screen,
   * the jump is redone against the layout that settled.
   *
   * The offset itself is checked too. It came from the server's extracted
   * text; the reader addresses a DOM built from the same source, and the two
   * agreeing is a property of two walks staying in step rather than a
   * guarantee. If it does not resolve, the words are searched for directly.
   */
  useEffect(() => {
    const map = textMapRef.current;
    if (!found || found.spineIdx !== spineIdx || !map) {
      if (!found) paintFound(null, null);
      return;
    }
    let offset = found.charOffset;
    const here = rangeForSpan(map, offset, offset + found.text.length);
    if (!here) {
      const better = nearestOccurrence(map, found.text, offset);
      if (better === null) {
        paintFound(null, null);
        return;
      }
      offset = better;
    }
    paintFound(map, { start: offset, end: offset + found.text.length });
    const raf = requestAnimationFrame(() => {
      const box = (
        prefs.mode === 'paginated' ? pagesRef.current : scrollerRef.current
      )?.getBoundingClientRect();
      if (!spanOnScreen(map, offset, box)) restoreOffset(offset);
    });
    return () => cancelAnimationFrame(raf);
  }, [found, spineIdx, html, prefs.mode, restoreOffset]);

  // A hit belongs to the search that found it. Turning pages away from it, or
  // opening another chapter, is the reader moving on.
  useEffect(() => {
    if (!found) return;
    const t = setTimeout(() => setFound(null), 20_000);
    return () => clearTimeout(t);
  }, [found]);

  /**
   * The pace marker: where the narration has got to, beside the text.
   *
   * Highlighting every sentence made two promises the alignment cannot keep -
   * that this exact sentence is being spoken, and that the marks left behind
   * mean something. A marker in the margin makes the honest promise instead:
   * roughly here, moving at the pace the narrator is reading. It is drawn
   * beside the words, never on them, so nothing is ever left marked up.
   *
   * Positioned from the interpolated character offset, which keeps moving
   * between sentences rather than stalling and jumping.
   */
  const updatePace = useCallback(() => {
    // Paused, the marker stays: it is where the voice will pick up, and a
    // marker that vanished on pause left the reader hunting for the line.
    if (!readAlong) {
      setPace(null);
      return;
    }
    const map = textMapRef.current;
    const raw = paceOffset(narration.cues, narration.bookMs);
    if (raw === null || !map) {
      setPace(null);
      return;
    }
    // Held to the sentence being spoken: the estimate and the sentence are
    // read from the same clock, but the clock is sampled a few times a
    // second and a sentence can be picked up mid-way, and the mark must
    // never sit on a line the voice has not reached or has left.
    const cue = narration.cue;
    const at =
      cue && narration.state === 'on'
        ? Math.min(cue.charEnd - 1, Math.max(cue.charStart, raw))
        : raw;
    const offset = Math.round(at);
    const range = rangeForSpan(map, offset, offset + 1);
    const paged = prefs.mode === 'paginated' && !paginationFailed;
    const box = (prefs.mode === 'paginated' ? pagesRef.current : scrollerRef.current) ?? null;
    if (!range || !box) {
      setPace(null);
      return;
    }
    // The first rect, not the union: a one-character range that straddles a
    // line or column break reports two, and their union has its centre in
    // the gutter and the height of a column.
    const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    // Nailed to the viewport while the page is being driven under it;
    // otherwise drawn inside the box the text moves in, so it moves with
    // the text and never chases it.
    const nailed = autoScroll && following && narration.playing && !reduceMotion && !paged;
    const origin = nailed ? viewportRef.current?.getBoundingClientRect() : contentOriginBox(box);
    const textBox = (paged ? box : contentRef.current)?.getBoundingClientRect();
    if (!origin || !textBox) return;
    const position = markerPosition(
      r,
      b,
      origin,
      textBox,
      rtl,
      paged && layoutRef.current
        ? layoutRef.current
        : { columns: 1, pad: MARGINS[prefs.margin].padding, columnGap: 0 },
    );
    // A change of column is a jump, not a glide: the marker used to slide
    // from the foot of one column up through the text of the next.
    const jumped =
      position !== null && paceLeftRef.current !== null && position.left !== paceLeftRef.current;
    paceLeftRef.current = position?.left ?? null;
    setPaceJump(jumped);

    // Auto-scrolling: the marker is nailed to the anchor line and the text is
    // moved to meet it. Its position is therefore a constant, and what varies
    // is where the page has to be.
    if (nailed) {
      const scroller = scrollerRef.current;
      setPace(
        position && scroller
          ? {
              ...position,
              top: b.top - origin.top + scroller.clientHeight * AUTO_SCROLL_ANCHOR,
              nailed: true,
            }
          : null,
      );
      if (scroller) {
        const next =
          scroller.scrollTop +
          (r.top - b.top) +
          r.height / 2 -
          scroller.clientHeight * AUTO_SCROLL_ANCHOR;
        // How fast the narration is moving down the page, from the distance
        // between two targets. Smoothed, because the estimate jitters and a
        // jittering speed is exactly the stutter this replaces.
        const prev = autoScrollTargetRef.current;
        const at = performance.now();
        if (prev !== null && autoScrollAtRef.current !== null) {
          const dt = at - autoScrollAtRef.current;
          if (dt > 80 && dt < 4000) {
            const observed = Math.max(0, (next - prev) / dt);
            autoScrollSpeedRef.current = autoScrollSpeedRef.current * 0.7 + observed * 0.3;
          }
        }
        autoScrollAtRef.current = at;
        autoScrollTargetRef.current = next;
      }
      return;
    }
    autoScrollTargetRef.current = null;

    // Off the current page or scrolled out of view: nothing to point at.
    setPace(position);
  }, [
    readAlong,
    narration.playing,
    narration.bookMs,
    narration.cues,
    prefs.mode,
    prefs.margin,
    paginationFailed,
    autoScroll,
    following,
    reduceMotion,
    rtl,
  ]);

  // The clock moves the marker; so does the reader. Recomputing only on the
  // clock left it pinned to a stale screen position during a scroll - it sat
  // still while the text slid under it, then jumped on the next tick, and
  // blinked in and out as the on-screen test flipped between ticks.
  useEffect(() => {
    updatePace();
    // The key, not only the clock: paused, the clock never ticks, and a
    // marker computed for the layout before a rotation or a size change
    // sat on a line the text had left.
  }, [updatePace, page, layoutKey]);

  useEffect(() => {
    if (!readAlong) return;
    const scroller =
      prefs.mode === 'scroll' ? scrollerRef.current : paginationFailed ? pagesRef.current : null;
    if (!scroller) return;
    let raf = 0;
    const onScroll = () => {
      // One recompute per frame at most: scroll fires far faster than paint.
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updatePace();
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [readAlong, prefs.mode, paginationFailed, updatePace, html]);

  /**
   * A deliberate seek means "take me with you".
   *
   * Rewinding fifteen seconds is a request to hear something again, and a
   * reader who had scrolled away earlier still expects the page to come
   * along. Without this the page stayed where it was and the marker had
   * nothing to point at, which read as the alignment having broken.
   */
  useEffect(() => {
    if (!readAlong || narration.seekNonce === 0) return;
    resumeFollowing();
  }, [narration.seekNonce, readAlong]);

  /**
   * Auto-scroll: the marker holds still and the text moves under it.
   *
   * The first version did the opposite - the marker drifted down and the page
   * jumped to catch it every so often, which is two things moving and neither
   * of them smoothly. Pinned, it becomes what it should be: a fixed line to
   * read at, with the book flowing past it.
   *
   * Eased every frame rather than scrolled in steps. `scrollBy` with smooth
   * behaviour restarts its own animation on each call, so successive nudges
   * fight each other and the page stutters; a small fraction of the remaining
   * distance per frame is continuous and self-correcting, speeding up when
   * the voice gets ahead and settling when it is level.
   *
   * Scrolling mode only: in paginated mode the page already turns itself.
   */
  useEffect(() => {
    if (!autoScroll || !following || reduceMotion || !readAlong || !narration.playing) return;
    if (prefs.mode === 'paginated' && !paginationFailed) return;
    const scroller = prefs.mode === 'paginated' ? pagesRef.current : scrollerRef.current;
    if (!scroller) return;
    autoScrollSpeedRef.current = 0;
    autoScrollAtRef.current = null;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      if (!followingRef.current) return;
      if (!scrollOwnership.current.matches(scroller)) {
        detachFollowing();
        return;
      }
      raf = requestAnimationFrame(step);
      const dt = Math.min(64, now - last); // a backgrounded tab must not lurch
      last = now;
      // A relocation glide owns the page until it lands.
      if (glideRef.current.active) return;
      const want = autoScrollTargetRef.current;
      if (want === null) return;

      // Move at a steady speed, not by easing to each new target.
      //
      // Easing decelerates as it arrives, so with a target that only updates
      // a few times a second the page rushed, stopped, rushed, stopped - one
      // lurch per line. `autoScrollSpeedRef` is how fast the narration is
      // actually working through the page, measured between targets, so the
      // text drifts up at the pace it is being read.
      const speed = autoScrollSpeedRef.current; // px per ms
      scrollOwnership.current.write(
        scroller,
        scroller.scrollTop +
          autoScrollDelta(scroller.scrollTop, want, speed, dt, followingRef.current, reduceMotion),
      );
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [
    autoScroll,
    following,
    reduceMotion,
    readAlong,
    narration.playing,
    prefs.mode,
    paginationFailed,
  ]);

  /**
   * The page turn actually used.
   *
   * A reader who has asked the system for less motion gets none, whatever the
   * preference says - the preference is a taste, that is an accessibility
   * setting, and it wins.
   */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      setReduceMotion(mq.matches);
      if (mq.matches) {
        setAutoScroll(false);
        autoScrollTargetRef.current = null;
      }
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const pageTurn = reduceMotion ? 'instant' : prefs.pageTurn;

  /**
   * Fade: the page does not travel, it crosses over.
   *
   * Setting the transition to `opacity` alone would do nothing, because
   * nothing changes the opacity - so the turn would silently be `instant`
   * wearing another name. This dips it and brings it back.
   */
  useEffect(() => {
    if (pageTurn !== 'fade' || prefs.mode !== 'paginated') return;
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = 'opacity 110ms var(--rp-ease)';
    el.style.opacity = '0';
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.opacity = '1';
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      el.style.opacity = '1';
    };
  }, [page, pageTurn, prefs.mode]);

  // Leaving the reader mid-glide must not leave a frame loop behind.
  useEffect(() => () => glideRef.current.cancel(), []);

  // The blink lasts its two pulses and no longer.
  useEffect(() => {
    if (!blink) return;
    const timer = window.setTimeout(() => setBlink(null), BLINK_MS);
    return () => window.clearTimeout(timer);
  }, [blink]);

  // A carried selection names offsets in this chapter's text and pages; a
  // different chapter, or a mode with no page edge, has nothing to continue.
  useEffect(() => setPendingSel(null), [spineIdx, prefs.mode]);

  /**
   * A tap while reading along. On a timed sentence it moves the voice there -
   * the gesture the whole feature turns on. On the margin, or on text the
   * aligner never timed, it falls through to the reader's own behaviour, so
   * no existing gesture is lost.
   */
  const seekVoiceAt = useCallback(
    (x: number, y: number): boolean => {
      if (!readAlong || !narration.ready) return false;
      const offset = offsetAtPoint(textMapRef.current, x, y);
      if (offset === null) return false;
      const cue = cueForOffset(narration.cues, offset);
      narration.playFrom(offset);
      setFollowing(true);
      // Show where the voice starts again: the aligned start of the sentence
      // the tap landed in, which is rarely where the finger was.
      if (cue) setBlink({ start: cue.charStart, end: cue.charEnd, nonce: Date.now() });
      return true;
    },
    [readAlong, narration],
  );

  /**
   * A plain click near either edge of the column turns the page.
   *
   * On touch the tapzone buttons on top of the page do this. They cannot on a
   * mouse - a button over the text swallows the drag that would otherwise be
   * a selection - so there they sit behind the page box and this handles the
   * part of the edge that the text covers. Only ever reached for a genuine
   * tap: a drag is filtered out before this runs, which is the whole point.
   */
  const edgeTap = useCallback(
    (clientX: number): boolean => {
      if (prefs.mode !== 'paginated') return false;
      const box = pagesRef.current?.getBoundingClientRect();
      if (!box || box.width < 200) return false;
      const edge = box.width * 0.18;
      const atStart = clientX < box.left + edge;
      const atEnd = clientX > box.right - edge;
      if (!atStart && !atEnd) return false;
      const backward = rtl ? atEnd : atStart;
      if (backward) prevPage();
      else nextPage();
      return true;
    },
    [prefs.mode, rtl, prevPage, nextPage],
  );

  const startReadAlong = useCallback(() => {
    followingRef.current = true;
    cueLeftSinceTakeoverRef.current = true;
    setFollowing(true);
    setReadAlong(true);
    setChrome(true);
    wantAutoScrollRef.current = prefs.autoScroll;
    if (prefs.autoScroll && prefs.mode === 'scroll' && !reduceMotion) setAutoScroll(true);
    try {
      if (!localStorage.getItem('rp-readalong-hint')) {
        localStorage.setItem('rp-readalong-hint', '1');
        toast.show(t('reader.readAlong.hint'));
      }
    } catch {
      /* private mode: the hint is a nicety, not a requirement */
    }
  }, [toast, t, prefs.autoScroll, prefs.mode, reduceMotion]);

  // Keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet !== 'none') return;
      const fwd = rtl ? 'ArrowLeft' : 'ArrowRight';
      const back = rtl ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === fwd || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault();
        nextPage();
      } else if (e.key === back || e.key === 'PageUp') {
        e.preventDefault();
        prevPage();
      } else if (e.key === 'Escape') {
        // A selection being carried, then a selection, then the reader.
        if (pendingSelRef.current) {
          setPendingSel(null);
          return;
        }
        if (selectionRef.current) {
          clearSelection();
          return;
        }
        navigate(`/book/${id}`);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [nextPage, prevPage, sheet, navigate, id, rtl, clearSelection]);

  // Selection handling.
  useEffect(() => {
    const onUp = () => {
      // Cleared before the note sheet can send this home. While the sheet is
      // open `measure` hides the toolbar anyway (it checks the sheet), so the
      // flag has no work to do there - but leaving it set outlived the sheet,
      // and a flag that says "the selection is still moving" hides the
      // toolbar unconditionally for as long as it is set.
      selMenuSettlingRef.current = false;
      if (sheetRef.current === 'note') return;
      const sel = document.getSelection();
      const content = contentRef.current;
      const map = textMapRef.current;
      if (!sel || sel.isCollapsed || !content || !map) {
        setSelection(null);
        return;
      }
      if (!content.contains(sel.anchorNode) || !content.contains(sel.focusNode)) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const start = domToOffset(map, range.startContainer, range.startOffset);
      const end = domToOffset(map, range.endContainer, range.endOffset);
      if (start === null || end === null || end <= start) {
        // A range the text map cannot place - it began in the chapter-end
        // control, say. Keeping the previous selection here meant the toolbar
        // came back over NEW geometry offering to highlight the OLD span.
        setSelection(null);
        return;
      }
      // Armed to continue a selection from another page: this settled range
      // - a long-press, a drag - says where the selection ends, and is
      // replaced by the one from the anchor. The replacement settles here
      // again, unarmed, as an ordinary selection.
      const pending = pendingSelRef.current;
      if (
        pending?.armed &&
        completeSelection(pending.anchor, start >= pending.anchor ? end : start)
      )
        return;
      const geometry = selectionGeometry(
        clipRects(Array.from(range.getClientRects()), pageClipBox()),
        getComputedStyle(content).direction === 'rtl' ? 'rtl' : 'ltr',
      );
      if (!geometry) {
        setSelection(null);
        return;
      }
      // A different span is a different selection: a long-press on other
      // text while a docked toolbar is up must not inherit the dock.
      const span = `${start}:${end}`;
      if (selSpanRef.current !== span) {
        selMenuModeRef.current = null;
        // Decided once per selection, from the gesture that made it, and the
        // gesture is CONSUMED so it can never describe a later one. A
        // selection that no pointer made - the keyboard, Select All from the
        // platform's own menu, a handle dragged by the OS - gets the device's
        // answer instead, which is the safe way round: room reserved and not
        // needed only moves ReadPort's toolbar down a little, while room
        // needed and not reserved puts it exactly where the platform wanted
        // to draw Look Up and Translate, and the reader stops being offered
        // them at all.
        const pointer = lastPointerTypeRef.current;
        lastPointerTypeRef.current = null;
        selCoarseRef.current =
          pointer === null
            ? (window.matchMedia?.('(any-pointer: coarse)').matches ?? false)
            : pointer !== 'mouse';
      }
      selSpanRef.current = span;
      recentSelRef.current = { start, end, collapsedAt: null };
      const text = sel.toString();
      setSelection({
        start,
        end,
        text: text.slice(0, 500),
        fullText: text.slice(0, SELECTION_TEXT_MAX),
        geometry,
      });
      // On a touch screen the platform draws its own edit menu over a
      // fresh selection - sometimes over ours, sometimes not at all. Setting
      // the same selection again takes that menu down, every time; a tap on
      // the selected words brings it back, and ours steps aside for that
      // tap (see the tap handlers), so one menu shows at a time.
      if (selCoarseRef.current && reappliedRef.current !== span && sel.rangeCount) {
        reappliedRef.current = span;
        const keep = sel.getRangeAt(0).cloneRange();
        reappliedRangeRef.current = keep;
        sel.removeAllRanges();
        sel.addRange(keep);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (contentRef.current?.contains(e.target as Node))
        lastPointerTypeRef.current = e.pointerType;
    };
    let settle: ReturnType<typeof setTimeout> | null = null;
    const onSelectionChange = (event: Event) => {
      // The note sheet autofocuses its textarea, which collapses the DOM
      // selection - and dropping it here would attach the note to a point
      // instead of to the passage the reader had chosen, losing the quotation
      // with it. The sheet owns the selection until it closes.
      if (sheetRef.current === 'note') return;
      // A press released on the toolbar itself - opening the colours, say -
      // is not the selection settling, and must not hide the toolbar for
      // the length of a settle.
      if (event.type === 'pointerup' && selMenuRef.current?.contains(event.target as Node)) return;
      // The change our own re-setting of the selection raises is not a
      // selection being made: the toolbar would hide and settle again for
      // nothing. Told apart by the range itself, not by the clock - a handle
      // dragged a moment later is a different range and is a change.
      if (event.type === 'selectionchange' && reappliedRangeRef.current) {
        const live = document.getSelection();
        const r = live?.rangeCount ? live.getRangeAt(0) : null;
        const same =
          !!r &&
          r.startContainer === reappliedRangeRef.current.startContainer &&
          r.startOffset === reappliedRangeRef.current.startOffset &&
          r.endContainer === reappliedRangeRef.current.endContainer &&
          r.endOffset === reappliedRangeRef.current.endOffset;
        if (same) return;
        reappliedRangeRef.current = null;
      }
      if (event.type === 'selectionchange' && selMenuRef.current) {
        // Hide stale geometry while the OS drags a handle; the settled
        // snapshot restores the toolbar once, before paint.
        selMenuRef.current.style.visibility = 'hidden';
      }
      selMenuSettlingRef.current = true;
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) {
        // A pointer that has come and gone leaving nothing selected has
        // selected nothing, so it says nothing about whatever is selected
        // next. Only at pointerup: the press that BEGINS a drag-selection
        // collapses the selection first, and forgetting the pointer there
        // would throw away the one fact worth keeping about a trackpad drag.
        if (event.type === 'pointerup') lastPointerTypeRef.current = null;
        if (settle) clearTimeout(settle);
        // Gone from the page, remembered for a moment: the press that
        // cleared it may be the start of a page turn.
        const recent = recentSelRef.current;
        if (recent && recent.collapsedAt === null) recent.collapsedAt = performance.now();
        setSelection(null);
        return;
      }
      // Showing the menu on `pointerup` alone is why it took two tries on a
      // phone: a long-press selection is finalised by the OS AFTER the finger
      // lifts, so the first pointerup saw nothing to offer. This fires as the
      // selection is made and again on every handle drag, so it waits for the
      // selection to stop moving before it offers anything.
      if (settle) clearTimeout(settle);
      settle = setTimeout(onUp, 180);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onSelectionChange);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      if (settle) clearTimeout(settle);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onSelectionChange);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [pageClipBox, completeSelection]);

  const addAnnotation = useCallback(
    async (
      kind: 'highlight' | 'bookmark' | 'note',
      note?: string,
      color?: HighlightColor,
    ): Promise<boolean> => {
      if (!manifest) return false;
      const sel = selection;
      const start = sel?.start ?? currentOffsetRef.current;
      const end = sel?.end ?? start;
      const sent = sentences.find((s) => start >= s.start && start < s.end);
      const body = {
        kind,
        locator: {
          medium: 'ebook',
          spineIdx,
          charOffset: start,
          sentenceId: sent?.id,
          pct: pctFor(manifest, spineIdx, start),
        },
        endLocator:
          end > start
            ? { medium: 'ebook', spineIdx, charOffset: end, pct: pctFor(manifest, spineIdx, end) }
            : null,
        color: kind === 'highlight' ? (color ?? DEFAULT_HIGHLIGHT) : null,
        selectedText: sel?.text ?? null,
        note: note ?? null,
      };
      try {
        const res = await api<{ annotation: Annotation }>(`/api/books/${id}/annotations`, {
          method: 'POST',
          body,
        });
        setAnnotations((a) => [...a, res.annotation]);
        toast.show(t('reader.toast.saved', { kind }));
        clearSelection();
        return true;
      } catch {
        toast.show(t('reader.toast.couldNotSave'));
        return false;
      }
    },
    [manifest, selection, sentences, spineIdx, id, toast, t, clearSelection],
  );

  /** The selected words: from the page while it still has them, from memory once it does not. */
  const selectedText = useCallback((): string => {
    const live = document.getSelection();
    const fromPage = live && !live.isCollapsed ? live.toString() : '';
    return (fromPage || selectionRef.current?.fullText || '').slice(0, SELECTION_TEXT_MAX);
  }, []);

  /**
   * Share the quotation: the words, the book, and a link to it.
   *
   * The link is the caller's share link for this book, made or reused by the
   * server. A server that has no such thing yet, or no network, still lets
   * the words go - without the link. The platform's own share sheet where
   * there is one; the clipboard where there is not, with a word to say so.
   */
  const shareSelection = useCallback(
    async (passage?: string) => {
      const quote = trimQuote(passage ?? selectedText());
      if (!quote || !manifest) return;
      let url = '';
      try {
        const res = await api<{ url: string; token: string }>(`/api/books/${id}/share`, {
          method: 'POST',
        });
        url = res.url;
      } catch {
        /* no share links on this server, or offline: the quotation still travels */
      }
      const text = t('reader.share.text', { title: manifest.title, quote, url }).trim();
      if (typeof navigator.share === 'function') {
        try {
          await navigator.share({ text });
          return;
        } catch (err) {
          // Dismissed is dismissed. A sheet that could not open at all - a
          // desktop that has the API and nothing behind it - falls through.
          if ((err as { name?: string } | null)?.name === 'AbortError') return;
        }
      }
      try {
        await navigator.clipboard.writeText(text);
        toast.show(t('reader.share.copied'));
      } catch {
        toast.show(t('reader.toast.copyFailed'));
      }
    },
    [selectedText, manifest, id, toast, t],
  );

  /**
   * The mark the reader tapped. A highlight is paint, not an element, so the
   * tap is resolved by character offset (see marks.ts) - and it has to win
   * over toggling the chrome, or a highlight would be unreachable on a phone.
   */
  /**
   * The selection menu, positioned from its own measured width.
   *
   * It is a row of swatches plus two buttons, so its width depends on the
   * font and the platform; a hardcoded half-width cannot centre it and cannot
   * keep it on screen.
   */
  const selMenuRef = useRef<HTMLDivElement>(null);
  const selMenuModeRef = useRef<PlacementMode | null>(null);
  const selMenuSettlingRef = useRef(false);
  /** The span the toolbar was placed for; a new span forgets a dock. */
  const selSpanRef = useRef<string | null>(null);
  /** The span the platform's edit menu was taken down for, so it is done once per selection. */
  const reappliedRef = useRef<string | null>(null);
  /** The range set again, so the selectionchange that raises is not read as a new selection. */
  const reappliedRangeRef = useRef<Range | null>(null);
  /**
   * What made the CURRENT selection. The media query says whether this device
   * HAS a coarse pointer; an iPad with a trackpad has both, and a selection
   * dragged with the trackpad gets no native edit menu to keep clear of.
   *
   * Cleared with the selection it describes. It used to be written once and
   * never reset, so a single trackpad selection made every later one on that
   * device look like a mouse selection: the placer stopped reserving room for
   * the platform's own Look Up / Translate menu, and ReadPort's toolbar was
   * placed exactly where iOS wanted to put it. The reader sees their own
   * menu stop appearing, and nothing on the page says why.
   */
  const lastPointerTypeRef = useRef<string | null>(null);
  /** Whether the CURRENT selection needs room kept for the platform's menu. */
  const selCoarseRef = useRef(false);
  /** Whether the toolbar is actually on screen, which the return pill yields to. */
  const [toolbarShown, setToolbarShown] = useState(false);

  /**
   * Where the position slider's thumb is while it is being dragged.
   *
   * The input used to be driven by the real reading position and to commit on
   * every change - so each step of a drag loaded a chapter, and the thumb
   * sprang back to wherever the reader actually still was. The thumb now
   * follows the finger and the jump happens once, when it stops moving.
   */
  const [dragPct, setDragPct] = useState<number | null>(null);
  const dragCommitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sheetRef = useRef<SheetKind>('none');
  sheetRef.current = sheet;

  const [markPop, setMarkPop] = useState<{ a: Annotation; x: number; y: number } | null>(null);
  /** The colour row in place of the icons, while a highlight colour is being chosen. */
  const [palette, setPalette] = useState(false);
  const [markPalette, setMarkPalette] = useState(false);
  /**
   * Our toolbar stepping aside for the platform's. On a phone a tap on the
   * selected words brings the platform's own edit menu up, and two menus
   * over one selection is one too many; the next tap brings ours back.
   */
  const [toolbarHidden, setToolbarHidden] = useState(false);
  const toolbarHiddenRef = useRef(false);
  toolbarHiddenRef.current = toolbarHidden;
  useEffect(() => {
    setPalette(false);
    setToolbarHidden(false);
  }, [selection]);
  useEffect(() => setMarkPalette(false), [markPop]);
  /** Measured position for the popover; null until it has been measured. */
  const [markPopTop, setMarkPopTop] = useState<number | null>(null);
  const markPopRef = useRef<HTMLDivElement | null>(null);

  const openMarkAt = useCallback(
    (x: number, y: number): boolean => {
      const hit = markAtPoint(textMapRef.current, annotations, spineIdx, x, y);
      if (!hit) {
        setMarkPop(null);
        return false;
      }
      const vv = window.visualViewport;
      const vLeft = vv?.offsetLeft ?? 0;
      const vWidth = vv?.width ?? window.innerWidth;
      setMarkPop({
        a: hit,
        x: Math.max(vLeft + 12, Math.min(x - 150, vLeft + vWidth - 340)),
        y: Math.max((vv?.offsetTop ?? 0) + 70, y + 14),
      });
      return true;
    },
    [annotations, spineIdx],
  );

  // The contents open on the chapter being read, not at the top of the list.
  useEffect(() => {
    if (sheet !== 'toc' || contentsTab !== 'toc') return;
    const raf = requestAnimationFrame(() => {
      document.querySelector('.list-row[aria-current="true"]')?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(raf);
  }, [sheet, contentsTab]);

  // Read native geometry without ever cancelling contextmenu, callout or
  // selection gestures. Layout measurement and placement happen before paint.
  useLayoutEffect(() => {
    if (!selection) {
      selMenuModeRef.current = null;
      selSpanRef.current = null;
      selMenuSettlingRef.current = false;
      lastPointerTypeRef.current = null;
      setToolbarShown(false);
      setSelFrame(null);
      return;
    }
    const el = selMenuRef.current;
    if (!el) return;
    let raf = 0;
    /**
     * Transitions in flight on the content, and the latest moment one of
     * them can still be running.
     *
     * A `transitionrun` with no matching end - a transition cancelled by a
     * node leaving the document, one whose property stops being animated -
     * used to leave this on forever, and "on" means measure and reposition
     * the toolbar on EVERY frame for the rest of the selection's life. Each
     * of those frames forces layout and writes to the toolbar's style, which
     * on iOS is also how you get the platform to give up on drawing its own
     * edit menu. Bounded: the longest thing that moves here is a 200ms page
     * turn.
     */
    let moving = 0;
    let movingUntil = 0;
    const mq = window.matchMedia('(any-pointer: coarse)');
    const measure = () => {
      const sel = document.getSelection();
      const content = contentRef.current;
      if (
        selMenuSettlingRef.current ||
        sheetRef.current !== 'none' ||
        !sel?.rangeCount ||
        sel.isCollapsed ||
        !content?.contains(sel.anchorNode) ||
        !content.contains(sel.focusNode)
      ) {
        el.style.visibility = 'hidden';
        setToolbarShown(false);
        setSelFrame(null);
        return;
      }
      const geometry = selectionGeometry(
        clipRects(Array.from(sel.getRangeAt(0).getClientRects()), pageClipBox()),
        selection.geometry.direction,
      );
      if (!geometry) {
        el.style.visibility = 'hidden';
        setToolbarShown(false);
        setSelFrame(null);
        return;
      }
      const vv = window.visualViewport;
      const root = getComputedStyle(document.documentElement);
      const safe = (edge: string) => parseFloat(root.getPropertyValue(`--rp-safe-${edge}`)) || 0;
      const viewport = {
        left: (vv?.offsetLeft ?? 0) + safe('left'),
        top: (vv?.offsetTop ?? 0) + safe('top'),
        right: (vv?.offsetLeft ?? 0) + (vv?.width ?? window.innerWidth) - safe('right'),
        bottom: (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight) - safe('bottom'),
      };
      el.style.maxWidth = `${Math.max(0, viewport.right - viewport.left - 16)}px`;
      const input = {
        selection: geometry,
        viewport,
        toolbar: el.getBoundingClientRect(),
        topBoundary: topChromeRef.current?.getBoundingClientRect().bottom ?? viewport.top,
        bottomBoundary: bottomChromeRef.current?.getBoundingClientRect().top ?? viewport.bottom,
        // A mouse or trackpad selection gets no native menu, on any device;
        // a finger or a pencil does. Latched when this selection was made
        // (see `onUp`), so it describes THIS selection and not the last
        // pointer to touch the chapter.
        coarse: selCoarseRef.current,
        previous: selMenuModeRef.current,
      };
      const placement = placeSelectionToolbar(input);
      if (!placement) {
        el.style.visibility = 'hidden';
        setToolbarShown(false);
        setSelFrame(null);
        return;
      }
      selMenuModeRef.current = placement.mode;
      el.dataset.placement = placement.mode;
      el.style.left = `${placement.left}px`;
      el.style.top = `${placement.top}px`;
      el.style.visibility = toolbarHiddenRef.current ? 'hidden' : 'visible';
      setToolbarShown(true);
      // The frame: the same settled lines, in the pixels of the box the text
      // moves in (clipped to the page when there is one), and nothing at all
      // while a page is still sliding under them.
      const paged = prefs.mode === 'paginated';
      const host = paged ? pagesRef.current : scrollerRef.current;
      const boxes =
        host && !pageTurning(content)
          ? relativeTo(
              lineBoxes(geometry.rects, paged ? host.getBoundingClientRect() : null),
              hostOrigin(host),
            )
          : [];
      const last = boxes[boxes.length - 1];
      setSelFrame((prev) => {
        if (!last) return null;
        if (prev && sameBoxes(prev.boxes, boxes)) return prev;
        return {
          boxes,
          end: {
            x: geometry.direction === 'rtl' ? last.left : last.left + last.width,
            y: last.top,
          },
        };
      });
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
        if (moving > 0 && performance.now() < movingUntil) schedule();
      });
    };
    const start = () => {
      moving++;
      movingUntil = performance.now() + 600;
      schedule();
    };
    const end = () => {
      moving = Math.max(0, moving - 1);
      schedule();
    };
    measure();
    const ro = new ResizeObserver(schedule);
    for (const node of [el, contentRef.current, topChromeRef.current, bottomChromeRef.current])
      if (node) ro.observe(node);
    const content = contentRef.current;
    const mo = new MutationObserver(schedule);
    if (content) mo.observe(content, { attributes: true, attributeFilter: ['style', 'class'] });
    content?.addEventListener('transitionrun', start);
    content?.addEventListener('transitionend', end);
    content?.addEventListener('transitioncancel', end);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    mq.addEventListener('change', schedule);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      content?.removeEventListener('transitionrun', start);
      content?.removeEventListener('transitionend', end);
      content?.removeEventListener('transitioncancel', end);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      mq.removeEventListener('change', schedule);
    };
  }, [
    selection,
    page,
    loadSeq,
    chrome,
    chromeInset,
    sheet,
    prefs.mode,
    pageClipBox,
    palette,
    toolbarHidden,
  ]);

  /**
   * Keep the mark's popover on the screen, vertically.
   *
   * `y` was clamped at the top only. The reader is a fixed, non-scrolling
   * surface, so a mark in the lower half of the page put Edit and Remove
   * below the bottom edge with no way to reach them - and no way to scroll
   * to them. Measured, then flipped above the mark when it does not fit
   * below, and finally pinned inside the safe area.
   */
  useLayoutEffect(() => {
    if (!markPop) {
      setMarkPopTop(null);
      return;
    }
    const el = markPopRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    const vv = window.visualViewport;
    const safeTop = (vv?.offsetTop ?? 0) + 70;
    const safeBottom =
      (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight) - chromeInset.bottom - 12;
    // Below the mark if it fits, otherwise above it, otherwise pinned.
    const below = markPop.y;
    const above = markPop.y - h - 28;
    const top = below + h <= safeBottom ? below : above >= safeTop ? above : safeTop;
    setMarkPopTop(Math.min(Math.max(safeTop, top), Math.max(safeTop, safeBottom - h)));
  }, [markPop, chromeInset.bottom]);

  /**
   * Put the reader back where they asked to be, once the chapter settles.
   *
   * Scroll mode has the same problem paginated mode had: the landing is
   * computed the instant the HTML is injected, before its images have any
   * height, so a chapter with a figure near the top slides out from under the
   * reader as the images arrive. Opening a chapter at its start would leave
   * them somewhere in the middle of it.
   */
  useEffect(() => {
    if (!html) return;
    const scroller = scrollBox();
    const content = contentRef.current;
    if (!scroller || !content) return;
    // Only while they have not moved themselves: re-landing someone who has
    // started reading is worse than the drift.
    const landing = currentOffsetRef.current;
    const epoch = manualScrollEpoch.current;
    let alive = true;
    const settle = () => {
      if (!alive || scrollBox() !== scroller) return;
      // A backgrounded page reports the geometry it had when it went away,
      // and landing against that puts the reader somewhere they never were.
      // Deferred to the visibility listener below rather than dropped.
      if (document.hidden) return;
      if (manualScrollEpoch.current !== epoch) return;
      if (Math.abs(currentOffsetRef.current - landing) > 40) return;
      const map = textMapRef.current;
      // Through the ref: the chrome is measured a beat after the chapter is on
      // screen, and this has to use that measurement without being re-armed by
      // it (see the dependencies below).
      if (map) scrollLineToRef.current(scroller, map, landing);
    };
    const pending = Array.from(content.querySelectorAll('img')).filter((i) => !i.complete);
    for (const img of pending) {
      img.addEventListener('load', settle);
      img.addEventListener('error', settle);
    }
    const timers = [120, 600, 1600].map((ms) => window.setTimeout(settle, ms));
    document.addEventListener('visibilitychange', settle);
    return () => {
      alive = false;
      for (const t of timers) window.clearTimeout(t);
      document.removeEventListener('visibilitychange', settle);
      for (const img of pending) {
        img.removeEventListener('load', settle);
        img.removeEventListener('error', settle);
      }
    };
    // Armed by a chapter arriving, and by nothing else. `scrollLineTo` is
    // rebuilt whenever the top chrome is re-measured - which happens once,
    // shortly after the chapter is on screen - and listing it here restarted
    // the 1.6s timer from that moment, long after the landing had been
    // superseded by wherever the reader or the voice had since gone.
  }, [loadSeq, html, prefs.mode, paginationFailed]);

  /**
   * Tell the toast how tall this page's chrome is.
   *
   * The toast is pinned 96px up - the height of the bottom bar without
   * read-along. With the narration transport open the bar is taller, and the
   * toast landed on top of it, covering the play button for eight seconds.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--rp-toast-bottom', `${chromeInset.bottom + 12}px`);
    return () => {
      root.style.removeProperty('--rp-toast-bottom');
    };
  }, [chromeInset.bottom]);

  // A mark's popover belongs to the mark, not to the page: turning the page or
  // changing chapter must not leave it hanging over unrelated text.
  useEffect(() => setMarkPop(null), [spineIdx, page]);

  /**
   * Which contents row the reader is actually on.
   *
   * Not "every row pointing at this spine item". A chapter is often several
   * rows - the chapter itself and its sections, which differ only by their
   * fragment - and marking all of them says nothing about where in the
   * chapter the reader is. Each row's fragment is resolved to a character
   * offset in the chapter as it is rendered, and the row marked is the last
   * one at or before where they are. Computed when the sheet opens, because
   * resolving a fragment means looking in the document.
   */
  const [currentTocRow, setCurrentTocRow] = useState<number | null>(null);
  useEffect(() => {
    if (sheet !== 'toc' || !manifest) return;
    const content = contentRef.current;
    const map = textMapRef.current;
    const here = currentOffsetRef.current;
    let row: number | null = null;
    let best = -1;
    let firstInChapter: number | null = null;
    manifest.toc.forEach((entry, i) => {
      if (entry.spineIdx !== spineIdx) return;
      if (firstInChapter === null) firstInChapter = i;
      const at =
        entry.fragment && content && map
          ? (offsetForFragment(content, map, entry.fragment) ?? 0)
          : 0;
      if (at <= here && at > best) {
        best = at;
        row = i;
      }
    });
    // A chapter whose only rows are sections deeper in it is still the
    // chapter the reader is in, so say so rather than marking nothing.
    setCurrentTocRow(row ?? firstInChapter);
  }, [sheet, manifest, spineIdx, liveOffset]);

  const patchAnnotation = useCallback(
    async (annId: string, body: { color?: HighlightColor; note?: string }): Promise<boolean> => {
      try {
        const res = await api<{ annotation: Annotation }>(`/api/annotations/${annId}`, {
          method: 'PATCH',
          body,
        });
        setAnnotations((all) => all.map((x) => (x.id === annId ? res.annotation : x)));
        setMarkPop((m) => (m && m.a.id === annId ? { ...m, a: res.annotation } : m));
        return true;
      } catch {
        toast.show(t('reader.toast.couldNotSaveChange'));
        return false;
      }
    },
    [toast, t],
  );
  const recolour = useCallback(
    (annId: string, color: HighlightColor) => patchAnnotation(annId, { color }),
    [patchAnnotation],
  );
  const editNote = useCallback(
    (annId: string, note: string) => patchAnnotation(annId, { note }),
    [patchAnnotation],
  );

  /** Bookmarks in this chapter, with "is it on the page I am looking at". */
  const bookmarks = annotations.filter(
    (a) => a.kind === 'bookmark' && a.locator.medium === 'ebook',
  );
  const bookmarkOnPage = (a: Annotation): boolean => {
    if (a.locator.medium !== 'ebook' || a.locator.spineIdx !== spineIdx) return false;
    const off = a.locator.charOffset ?? landingOffset(a.locator, sentences);
    if (prefs.mode === 'paginated' && !paginationFailed) return pageForOffset(off) === page;
    const map = textMapRef.current;
    const scroller = scrollBox();
    if (!map || !scroller) return false;
    const r = rangeForSpan(map, off, off + 1)?.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    // Under the chrome is not on the page.
    return (
      !!r && r.top >= box.top + chromeInset.top - 4 && r.top <= box.bottom - chromeInset.bottom
    );
  };
  const currentBookmark = bookmarks.find(bookmarkOnPage) ?? null;

  const toggleBookmark = useCallback(async () => {
    if (!manifest) return;
    if (currentBookmark) {
      try {
        await api(`/api/annotations/${currentBookmark.id}`, { method: 'DELETE' });
        setAnnotations((a) => a.filter((x) => x.id !== currentBookmark.id));
        toast.show(t('reader.toast.bookmarkRemoved'));
      } catch {
        toast.show(t('reader.toast.couldNotRemoveBookmark'));
      }
      return;
    }
    // Capture live geometry, even before scroll tracking's debounce. The
    // sentence supplies an excerpt/recovery hint, never the exact position.
    const viewport = prefs.mode === 'paginated' ? pagesRef.current : scrollerRef.current;
    const box = viewport?.getBoundingClientRect();
    const visible =
      box && (prefs.mode === 'scroll' || paginationFailed)
        ? { left: box.left, right: box.right, top: box.top + chromeInset.top, bottom: box.bottom }
        : box;
    const start =
      visible && textMapRef.current
        ? (firstVisibleOffset(textMapRef.current, visible) ?? currentOffsetRef.current)
        : currentOffsetRef.current;
    const sent =
      sentences.find((s) => start >= s.start && start < s.end) ??
      sentences.find((s) => s.start >= start);
    const map = textMapRef.current;
    const excerpt =
      sent && map
        ? (rangeForSpan(map, sent.start, sent.end)?.toString().trim().slice(0, 240) ?? null)
        : null;
    const body = {
      kind: 'bookmark',
      locator: {
        medium: 'ebook',
        spineIdx,
        charOffset: start,
        sentenceId: sent?.id,
        pct: pctFor(manifest, spineIdx, start),
      },
      selectedText: excerpt,
    };
    try {
      const res = await api<{ annotation: Annotation }>(`/api/books/${id}/annotations`, {
        method: 'POST',
        body,
      });
      setAnnotations((a) => [...a, res.annotation]);
      // Show WHICH line was marked: the sentence lights up for a moment, so
      // the bookmark is never an invisible event.
      if (sent && map) {
        handoffCleanupRef.current?.();
        handoffCleanupRef.current = paintHandoff(map, sent.start, sent.end);
      }
      toast.show(
        prefs.mode === 'paginated'
          ? t('reader.toast.bookmarkedPage', { n: page + 1 })
          : t('reader.toast.bookmarkedPassage'),
        {
          label: t('reader.toast.openBookmarks'),
          onClick: () => {
            setContentsTab('marks');
            setSheet('toc');
          },
        },
      );
    } catch {
      toast.show(t('reader.toast.couldNotSave'));
    }
  }, [
    manifest,
    currentBookmark,
    sentences,
    spineIdx,
    page,
    prefs.mode,
    paginationFailed,
    chromeInset.top,
    id,
    toast,
    t,
  ]);

  const deleteAnnotation = useCallback(
    async (annId: string) => {
      try {
        await api(`/api/annotations/${annId}`, { method: 'DELETE' });
        setAnnotations((a) => a.filter((x) => x.id !== annId));
      } catch {
        toast.show(t('reader.toast.couldNotDelete'));
      }
    },
    [toast, t],
  );

  const switchToAudio = useCallback(async () => {
    if (!detail?.book.pair || !manifest) return;
    const sent = sentences.find(
      (s) => currentOffsetRef.current >= s.start && currentOffsetRef.current < s.end,
    );
    const from: EbookLocator = {
      medium: 'ebook',
      spineIdx,
      sentenceId: sent?.id,
      charOffset: currentOffsetRef.current,
      pct: pctFor(manifest, spineIdx, currentOffsetRef.current),
    };
    try {
      let res: ResolveResponse;
      try {
        res = await api<ResolveResponse>(`/api/pairs/${detail.book.pair.pairId}/resolve`, {
          method: 'POST',
          body: { from },
        });
      } catch (err) {
        if (!isOffline(err)) throw err;
        // No network. The downloaded package carries the server's own
        // answers, so the handoff lands where it would online.
        const stored = await cachedSwitch(id, from);
        if (!stored) {
          toast.show(t('reader.switch.notStoredOffline'));
          return;
        }
        res = stored;
      }
      if (!res.to || res.to.medium !== 'audio') {
        // Never silently cross an alignment gap: explain, and point at the
        // nearest verified aligned narration instead.
        const anchor = res.anchors?.before ?? res.anchors?.after;
        // The reason is the server's own sentence, shown as it came.
        const parts = [res.resolution.reason ?? t('reader.switch.noAlignedAudio')];
        if (anchor && anchor.to.medium === 'audio')
          parts.push(
            t('reader.switch.nearestNarration', {
              time: formatDuration(anchor.to.bookMs ?? anchor.to.positionMs),
            }),
          );
        toast.show(parts.join(' '));
        return;
      }
      void recordCheckpoint(id, 'switch', from);
      const to = res.to as AudioLocator;
      const back = res.resolution.rewindMs ?? 0;
      navigate(
        `/listen/${detail.book.pair.otherBookId}?track=${to.trackIdx}&pos=${to.positionMs}` +
          `&handoff=1&granularity=${res.resolution.granularity}` +
          (back > 0 ? `&back=${back}` : ''),
      );
    } catch {
      toast.show(t('reader.switch.failed'));
    }
  }, [detail, manifest, sentences, spineIdx, id, navigate, toast, t]);

  /* ----------------------------------------------------- drawn over text */

  // Stable getters for the overlays: what they measure changes; where to
  // find it does not.
  const getMap = useCallback(() => textMapRef.current, []);
  /** The box the text moves in - the scroller, or the page box - and so the box to draw over it in. */
  const getHost = useCallback(
    () => (prefs.mode === 'paginated' ? pagesRef.current : scrollerRef.current),
    [prefs.mode],
  );
  const getContent = useCallback(() => contentRef.current, []);
  const getScroller = useCallback(() => scrollBox(), [scrollBox]);
  const getClip = useCallback(
    () =>
      (prefs.mode === 'paginated'
        ? pagesRef.current
        : scrollerRef.current
      )?.getBoundingClientRect() ?? null,
    [prefs.mode],
  );

  /* ------------------------------------------------------------- render */

  if (loadError) {
    return (
      <div className="reader-page" data-reader-theme={theme}>
        <div className="empty-state" style={{ margin: 'auto' }}>
          <h2>{t('reader.error.title')}</h2>
          <p>{t(loadError)}</p>
          <Link className="btn btn--secondary" to={`/book/${id}`}>
            {t('reader.error.backToDetails')}
          </Link>
        </div>
      </div>
    );
  }

  const chapterTitle =
    manifest?.chapters[spineIdx]?.title ??
    manifest?.toc.find((t) => t.spineIdx === spineIdx)?.title ??
    manifest?.title ??
    '';
  const bookPct = manifest ? pctFor(manifest, spineIdx, liveOffset) : 0;
  const chapterPct = (() => {
    const ch = manifest?.chapters[spineIdx];
    if (!ch || ch.charCount === 0) return 0;
    return Math.min(1, Math.max(0, liveOffset / ch.charCount));
  })();
  const margins = MARGINS[prefs.margin];
  const pagesLeft = Math.max(0, pageCount - page - 1);

  /**
   * Drawn over the text, inside the box the text moves in - the scroller,
   * or the page box - so it all moves with the text natively rather than
   * chasing it a frame behind: the resumed line, the voice's mark, the
   * sentence being spoken, the blink where the voice starts again after a
   * tap, and the frame around a settled selection.
   */
  const overText = (
    <>
      {resumeMark && resumeMark.spineIdx === spineIdx && (
        <ResumeMarker
          target={resumeMark}
          map={() => textMapRef.current}
          container={getHost}
          scroller={() => scrollerRef.current}
          layoutKey={layoutKey}
        />
      )}
      {pace && !pace.nailed && prefs.voiceMark === 'margin' && (
        // Beside the text, never on it: an estimate drawn as one.
        <span
          className={`pace-marker${paceJump ? ' is-jump' : ''}`}
          style={{ left: pace.left, top: pace.top }}
          aria-hidden="true"
          data-paused={narration.playing ? undefined : 'yes'}
        />
      )}
      {readAlong && narration.cue && prefs.voiceMark === 'wash' && (
        <LineOverlay
          className="spoken-mark"
          span={{ start: narration.cue.charStart, end: narration.cue.charEnd }}
          map={getMap}
          container={getHost}
          clip={getClip}
          scroller={getScroller}
          content={getContent}
          layoutKey={layoutKey}
          data={{
            start: String(narration.cue.charStart),
            confident: isConfident(narration.cue) ? 'yes' : 'no',
            paused: narration.playing ? undefined : 'yes',
          }}
        />
      )}
      {blink && (
        <LineOverlay
          key={blink.nonce}
          className="blink-mark"
          span={blink}
          fade
          map={getMap}
          container={getHost}
          clip={getClip}
          scroller={getScroller}
          content={getContent}
          layoutKey={layoutKey}
          data={{ start: String(blink.start) }}
        />
      )}
      {selFrame && (
        // One outline around the whole of it, not a box per line.
        <svg className="line-overlay selframe" aria-hidden="true">
          {outlineRuns(selFrame.boxes).map((run, i) => (
            <path key={i} d={outlinePath(run, 2)} />
          ))}
        </svg>
      )}
      {selFrame && (
        <button
          type="button"
          className="selframe__x"
          style={{ left: selFrame.end.x, top: selFrame.end.y }}
          aria-label={t('reader.select.clear')}
          // Like the toolbar: a press must not collapse the selection
          // before the click that is meant to.
          onPointerDown={(e) => e.preventDefault()}
          onClick={clearSelection}
        >
          <IconClose size={12} />
        </button>
      )}
    </>
  );

  return (
    <div
      className={`reader-page ${chrome ? '' : 'chrome-hidden'} ${readAlong ? 'is-readalong' : ''}`}
      data-reader-theme={theme}
      style={
        {
          '--rd-font': FONTS[prefs.font].stack,
          '--rd-size': `${prefs.size}px`,
          '--rd-weight': prefs.weight,
          '--rd-leading': prefs.lineHeight,
          '--rd-margin': `${margins.padding}px`,
          '--rd-measure': margins.measure,
          '--rd-align': prefs.align,
          '--rd-hyphens': prefs.hyphens ? 'auto' : 'manual',
          // Measured, so scroll mode and the chapter-end button reserve the
          // room the bars actually take rather than a constant that was
          // already wrong before read-along made it worse.
          '--rd-chrome-top': `${chromeInset.top}px`,
          '--rd-chrome-bottom': `${chromeInset.bottom}px`,
        } as React.CSSProperties
      }
    >
      <div className="immersive-chrome immersive-chrome--top" ref={topChromeRef}>
        <button
          className="icon-btn"
          onClick={() => navigate(`/book/${id}`)}
          aria-label={t('reader.chrome.backToBook')}
        >
          <IconBack />
        </button>
        <button
          className="icon-btn"
          // The tab is said out loud, not left to whatever it was set to
          // last: the button is Contents, and it opens on the chapters.
          onClick={() => {
            setContentsTab('toc');
            setSheet('toc');
          }}
          aria-label={t('reader.chrome.contents')}
        >
          <IconToc />
        </button>
        <button
          className="icon-btn"
          onClick={() => setSheet('settings')}
          aria-label={t('reader.chrome.settings')}
        >
          <IconType />
        </button>
        <span className="reader-title">{chapterTitle}</span>
        {/* Search, drawn as the small field it opens: a glass and a word,
            at the end of the bar where a search field is looked for. */}
        <button
          type="button"
          className="reader-searchpill"
          onClick={() => setSheet('search')}
          aria-label={t('reader.chrome.search')}
        >
          <IconSearch size={16} />
          <span>{t('reader.chrome.searchPill')}</span>
        </button>
      </div>

      <div
        className="reader-viewport"
        ref={viewportRef}
        dir={rtl ? 'rtl' : 'ltr'}
        // Detach on evidence of intent, not on any event: a wheel in
        // paginated mode moves nothing, a pinch is two fingers, a tap has
        // jitter. Page turns detach through nextPage/prevPage themselves.
        onWheelCapture={(e) => {
          if (e.ctrlKey || e.deltaY === 0) return;
          if (prefs.mode === 'scroll' || paginationFailed) detachFollowing();
        }}
        onTouchStartCapture={(e) => {
          const t = e.touches[0];
          touchStartRef.current =
            e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchMoveCapture={(e) => {
          const start = touchStartRef.current;
          const t = e.touches[0];
          if (!start || !t || e.touches.length !== 1) return;
          if (prefs.mode !== 'scroll' && !paginationFailed) return;
          if (Math.hypot(t.clientX - start.x, t.clientY - start.y) < TOUCH_SLOP_PX) return;
          touchStartRef.current = null;
          detachFollowing();
        }}
      >
        {currentBookmark && (
          <svg className="reader-ribbon" viewBox="0 0 22 34" aria-hidden="true">
            <path d="M0 0h22v34l-11-8-11 8z" fill="currentColor" />
          </svg>
        )}
        {pace?.nailed && (
          // Driving the page: the mark holds still in the viewport and the
          // text is moved to meet it.
          <span
            className={`pace-marker${paceJump ? ' is-jump' : ''}`}
            style={{ left: pace.left, top: pace.top }}
            aria-hidden="true"
            data-auto="on"
            data-paused={narration.playing ? undefined : 'yes'}
          />
        )}
        {prefs.mode === 'paginated' ? (
          <>
            <button
              className="tapzone tapzone--prev"
              aria-label={t('reader.chrome.previousPage')}
              onClick={prevPage}
              tabIndex={-1}
            />
            <button
              className="tapzone tapzone--next"
              aria-label={t('reader.chrome.nextPage')}
              onClick={nextPage}
              tabIndex={-1}
            />
            <div
              className={`reader-pages ${paginationFailed ? 'is-unpaginated' : ''}`}
              ref={pagesRef}
            >
              <div
                ref={contentRef}
                className={`reader-content reader-content--paginated ${
                  paginationFailed ? 'is-unpaginated' : ''
                }`}
                style={{
                  // How a page turn looks. Fade moves the page without
                  // travel (the dip is applied below); slide is the default.
                  transition: pageTurn === 'slide' ? 'transform 200ms var(--rp-ease)' : 'none',
                  padding: `${chromeInset.top + 8}px ${margins.padding}px ${chromeInset.bottom + 8}px`,
                }}
                onPointerDown={(e) => {
                  swipeRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
                  handoffCleanupRef.current?.();
                }}
                onPointerUp={(e) => {
                  const sw = swipeRef.current;
                  swipeRef.current = null;
                  if (!sw) return;
                  const dx = e.clientX - sw.x;
                  const dy = e.clientY - sw.y;
                  if (Math.abs(dx) > 48 && Math.abs(dy) < 60 && Date.now() - sw.t < 600) {
                    const backward = rtl ? dx < 0 : dx > 0;
                    if (backward) prevPage();
                    else nextPage();
                  } else if (
                    Math.abs(dx) < 8 &&
                    Math.abs(dy) < 8 &&
                    !(e.target as Element).closest('a')
                  ) {
                    const sel = document.getSelection();
                    if (sel && !sel.isCollapsed) {
                      // A tap on the selected words brings the platform's own
                      // menu up on a phone: ours steps aside, and comes back
                      // with the next tap.
                      if (tapInSelection(sel, e.clientX, e.clientY)) setToolbarHidden((h) => !h);
                      return;
                    }
                    // Armed to continue a selection: this tap is where it ends.
                    if (extendSelectionTo(e.clientX, e.clientY)) return;
                    if (openMarkAt(e.clientX, e.clientY)) return;
                    if (seekVoiceAt(e.clientX, e.clientY)) return;
                    if (edgeTap(e.clientX)) return;
                    setChrome((c) => !c);
                  }
                }}
                onClick={(e) => interceptLink(e, manifest, spineIdx, gotoChapter)}
                lang={language ?? undefined}
                dangerouslySetInnerHTML={{ __html: html }}
              />
              {overText}
            </div>
          </>
        ) : (
          <div
            className={`reader-scroller ${autoScroll && readAlong ? 'is-autoscrolling' : ''}`}
            ref={scrollerRef}
          >
            <div
              ref={contentRef}
              className="reader-content"
              onClick={(e) => {
                if ((e.target as Element).closest('a')) {
                  interceptLink(e, manifest, spineIdx, gotoChapter);
                  return;
                }
                const sel = document.getSelection();
                if (sel && !sel.isCollapsed) {
                  if (tapInSelection(sel, e.clientX, e.clientY)) setToolbarHidden((h) => !h);
                  return;
                }
                if (openMarkAt(e.clientX, e.clientY)) return;
                if (seekVoiceAt(e.clientX, e.clientY)) return;
                setChrome((c) => !c);
              }}
              onPointerDown={() => handoffCleanupRef.current?.()}
              lang={language ?? undefined}
              dangerouslySetInnerHTML={{ __html: html }}
            />
            {manifest && html && (
              <div className="reader-chapter-end" dir={rtl ? 'rtl' : 'ltr'}>
                {spineIdx < manifest.chapters.length - 1 ? (
                  <button
                    className="btn btn--secondary"
                    onClick={() => gotoChapter(spineIdx + 1, 0, 'seek', undefined, 'progression')}
                  >
                    {/* Spine items are files, not chapters: a cover, a title
                        page and a dedication are each one, and only some are
                        named by the book's own contents. Numbering the rest
                        "Chapter 2, 3, 4" called them something they are not,
                        with numbers that matched nothing in the book. */}
                    {manifest.chapters[spineIdx + 1]?.title
                      ? t('reader.chapterEnd.next', {
                          title: manifest.chapters[spineIdx + 1]!.title,
                        })
                      : t('common.continue')}
                  </button>
                ) : (
                  <button className="btn btn--secondary" onClick={finishBook}>
                    {t('reader.chapterEnd.finish')}
                  </button>
                )}
              </div>
            )}
            {overText}
          </div>
        )}
        {/* A selection carried over a page turn: the way to finish it, at
            the corner the reading is heading for. Yields to the toolbar of
            a selection made in the meantime, and steps aside for the
            bookmark ribbon that hangs at the same corner. */}
        {pendingSel && !toolbarShown && prefs.mode === 'paginated' && !paginationFailed && (
          <div
            className={`continue-pill${pendingSel.armed ? ' is-armed' : ''}${
              currentBookmark ? ' is-beside-ribbon' : ''
            }`}
          >
            <button
              type="button"
              className="continue-pill__go"
              aria-pressed={pendingSel.armed}
              onClick={() => setPendingSel((p) => p && { ...p, armed: !p.armed })}
            >
              <span>
                {t(pendingSel.armed ? 'reader.select.continueArmed' : 'reader.select.continue')}
              </span>
              <span className="continue-pill__arrow" aria-hidden="true">
                <IconBack size={15} />
              </span>
            </button>
            <button
              type="button"
              className="continue-pill__x"
              aria-label={t('common.dismiss')}
              onClick={() => setPendingSel(null)}
            >
              <IconClose size={13} />
            </button>
          </div>
        )}
        {!html && !loadError && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <div className="spinner" role="status" aria-label={t('reader.loadingChapter')} />
          </div>
        )}
      </div>

      {/* Selection actions take precedence; retain the return origin until selection clears. */}
      {returnPoint && !toolbarShown && (
        // Two buttons side by side, not a button inside a button: nesting
        // them is invalid, unreachable by keyboard, and left the dismiss as
        // a 14px target inside a much larger tap area that did the opposite.
        <div className="return-pill">
          <button
            type="button"
            className="return-pill__go"
            onClick={() => {
              const rp = returnPoint.origin;
              setReturnPoint(null);
              gotoChapter(rp.spineIdx, rp.charOffset, 'seek', undefined, 'return');
            }}
          >
            <IconBack size={15} />{' '}
            {t('reader.return.backTo', {
              // A spine item the book never named is called by its number.
              label:
                returnPoint.origin.label ||
                t('common.chapterN', { n: returnPoint.origin.spineIdx + 1 }),
            })}
          </button>
          <button
            type="button"
            className="return-pill__x"
            aria-label={t('common.dismiss')}
            onClick={() => setReturnPoint(null)}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}
      {prefs.brightness < 0.995 && (
        <div className="reader-dim" style={{ opacity: 1 - prefs.brightness }} aria-hidden="true" />
      )}

      {selection && (
        <div
          ref={selMenuRef}
          className="selection-menu"
          style={{
            // The layout effect measures and positions before the first paint.
            visibility: 'hidden',
          }}
          role="toolbar"
          aria-label={t('reader.select.toolbar')}
          // A touch on a button outside the selection collapses the selection
          // before the click arrives, and the toolbar unmounts under the
          // finger. Keeping the default from happening keeps the selection;
          // it touches neither the selectable text nor the native menu.
          onPointerDown={(e) => e.preventDefault()}
        >
          {palette ? (
            // The colours, in place of the icons: picking one is the act.
            <>
              <button
                type="button"
                aria-label={t('common.back')}
                title={t('common.back')}
                onClick={() => setPalette(false)}
              >
                <IconChevronLeft size={18} />
              </button>
              <span className="swatches" role="group" aria-label={t('reader.select.highlight')}>
                {HIGHLIGHT_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`swatch swatch--${c}`}
                    aria-label={t('reader.select.highlightIn', { color: c })}
                    onClick={() => {
                      setPalette(false);
                      void addAnnotation('highlight', undefined, c);
                    }}
                  />
                ))}
              </span>
            </>
          ) : (
            // Icons, so the toolbar fits a phone beside the words; the name
            // is on each for anyone who cannot see the icon.
            <>
              <button
                type="button"
                aria-label={t('reader.select.highlight')}
                title={t('reader.select.highlight')}
                onClick={() => setPalette(true)}
              >
                <IconHighlighter size={19} />
              </button>
              <button
                type="button"
                aria-label={t('reader.select.note')}
                title={t('reader.select.note')}
                onClick={() => {
                  setNoteDraft('');
                  setSheet('note');
                }}
              >
                <IconNotes size={19} />
              </button>
              <button
                type="button"
                aria-label={t('reader.select.bookmark')}
                title={t('reader.select.bookmark')}
                onClick={() => void addAnnotation('bookmark')}
              >
                <IconBookmark size={19} />
              </button>
              <button
                type="button"
                aria-label={t('reader.select.share')}
                title={t('reader.select.share')}
                onClick={() => void shareSelection()}
              >
                <IconShare size={19} />
              </button>
            </>
          )}
        </div>
      )}

      {markPop && (
        <div
          ref={markPopRef}
          className="mark-pop"
          style={{
            left: markPop.x,
            top: markPopTop ?? markPop.y,
            // Hidden for the single frame between mount and measurement, so
            // it never flashes in the wrong place.
            visibility: markPopTop === null ? 'hidden' : undefined,
          }}
          role="dialog"
          aria-label={t('reader.mark.kind', { kind: markPop.a.kind })}
        >
          {markPop.a.selectedText && (
            <p className="mark-pop__quote">
              {t('reader.quoted', { text: markPop.a.selectedText })}
            </p>
          )}
          {markPop.a.note && <p className="mark-pop__note">{markPop.a.note}</p>}
          <div className="mark-pop__row">
            {markPalette ? (
              <>
                <button
                  type="button"
                  className="mark-pop__icon"
                  aria-label={t('common.back')}
                  title={t('common.back')}
                  onClick={() => setMarkPalette(false)}
                >
                  <IconChevronLeft size={18} />
                </button>
                <span className="swatches" role="group" aria-label={t('reader.mark.colour')}>
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`swatch swatch--${c}`}
                      aria-pressed={colorOf(markPop.a) === c}
                      aria-label={t(COLOR_LABELS[c])}
                      onClick={() => {
                        setMarkPalette(false);
                        void recolour(markPop.a.id, c);
                      }}
                    />
                  ))}
                </span>
              </>
            ) : (
              <>
                {markPop.a.kind === 'highlight' && (
                  <button
                    type="button"
                    className="mark-pop__icon"
                    aria-label={t('reader.mark.colour')}
                    title={t('reader.mark.colour')}
                    onClick={() => setMarkPalette(true)}
                  >
                    <IconHighlighter size={18} />
                  </button>
                )}
                {markPop.a.kind === 'note' && (
                  <button
                    type="button"
                    className="mark-pop__icon"
                    aria-label={t('common.edit')}
                    title={t('common.edit')}
                    onClick={() => {
                      setNoteDraft(markPop.a.note ?? '');
                      setEditingNote(markPop.a.id);
                      setMarkPop(null);
                      setSheet('note');
                    }}
                  >
                    <IconNotes size={18} />
                  </button>
                )}
                {markPop.a.selectedText && (
                  <button
                    type="button"
                    className="mark-pop__icon"
                    aria-label={t('reader.select.share')}
                    title={t('reader.select.share')}
                    onClick={() => void shareSelection(markPop.a.selectedText ?? undefined)}
                  >
                    <IconShare size={18} />
                  </button>
                )}
                <button
                  type="button"
                  className="mark-pop__icon mark-pop__icon--remove"
                  aria-label={
                    markPop.a.kind === 'highlight'
                      ? t('reader.mark.removeHighlight')
                      : t('common.remove')
                  }
                  title={
                    markPop.a.kind === 'highlight'
                      ? t('reader.mark.removeHighlight')
                      : t('common.remove')
                  }
                  onClick={() => {
                    const target = markPop.a.id;
                    setMarkPop(null);
                    void deleteAnnotation(target);
                  }}
                >
                  {markPop.a.kind === 'highlight' ? (
                    <IconHighlighterOff size={18} />
                  ) : (
                    <IconTrash size={17} />
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div
        className={`immersive-chrome immersive-chrome--bottom immersive-chrome--bar-${prefs.progressBar}`}
        ref={bottomChromeRef}
      >
        {/* The transport sits inside the bottom chrome so it can never land on
            top of it, and the chrome refuses to hide while it is here: you
            must always be one tap from pausing. */}
        {readAlong && (
          <NarrationBar
            n={narration}
            following={following}
            onResume={returnToVoice}
            onClose={() => {
              detachFollowing();
              setReadAlong(false);
            }}
            autoScroll={prefs.mode === 'paginated' && !paginationFailed ? null : autoScroll}
            onAutoScroll={(enabled) => {
              wantAutoScrollRef.current = enabled;
              const next = { ...prefs, autoScroll: enabled };
              setPrefs(next);
              savePrefs(next);
              if (enabled) {
                if (reduceMotion) toast.show(t('reader.readAlong.reducedMotion'));
                else if (!resumeFollowing(true)) returnToVoice();
              } else {
                autoScrollTargetRef.current = null;
                setAutoScroll(false);
              }
            }}
          />
        )}
        {/* One row: the friends, the bar with its beads, the percentage,
            and the voice. What the bar's other figures used to scatter
            across the row is in one order now, the same on every screen. */}
        {(prefs.progressBar !== 'hidden' || pair || friendsHere.friends.length > 0) && (
          <div className="reader-bar">
            {friendsHere.friends.length > 0 && (
              <FriendsButton
                bookId={id}
                myPct={bookPct}
                friends={friendsHere.friends}
                shownIds={friendsHere.shownIds}
                setShown={friendsHere.setShown}
                open={friendsHere.cardOpen}
                setOpen={friendsHere.setCardOpen}
              />
            )}
            {prefs.progressBar === 'full' && (
              <div className="reader-slider">
                <input
                  className="slider"
                  style={{ color: 'var(--rd-link)' }}
                  type="range"
                  min={0}
                  max={1000}
                  value={Math.round((dragPct ?? bookPct) * 1000)}
                  aria-label={t('reader.progress.position')}
                  onChange={(e) => {
                    if (!manifest) return;
                    const pct = Number(e.target.value) / 1000;
                    setDragPct(pct);
                    if (dragCommitRef.current) clearTimeout(dragCommitRef.current);
                    dragCommitRef.current = setTimeout(() => {
                      dragCommitRef.current = null;
                      const targetChars = pct * manifest.totalChars;
                      let s = 0;
                      for (const c of manifest.chapters) {
                        if (c.cumChars <= targetChars) s = c.idx;
                        else break;
                      }
                      const within = Math.max(
                        0,
                        Math.floor(targetChars - manifest.chapters[s]!.cumChars),
                      );
                      gotoChapter(s, within, 'seek', undefined, 'slider');
                      setDragPct(null);
                    }, 160);
                  }}
                />
                <FriendMarkers
                  friends={friendsHere.friends}
                  shownIds={friendsHere.shownIds}
                  on="slider"
                  onPick={() => friendsHere.setCardOpen(true)}
                />
              </div>
            )}
            {prefs.progressBar === 'compact' && (
              <span
                className="reader-minibar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(bookPct * 100)}
                aria-label={t('reader.progress.position')}
                title={t('reader.progress.miniTitle', {
                  chapter: chapterTitle,
                  pct: f.percent(chapterPct),
                })}
              >
                <span style={{ width: `${bookPct * 100}%` }} />
                <i style={{ insetInlineStart: `${bookPct * 100}%` }} aria-hidden="true" />
                <FriendMarkers
                  friends={friendsHere.friends}
                  shownIds={friendsHere.shownIds}
                  onPick={() => friendsHere.setCardOpen(true)}
                />
              </span>
            )}
            {prefs.progressBar !== 'hidden' && (
              <span className="reader-bar__pct">{f.percent(bookPct)}</span>
            )}
            {pair && (
              <div className="reader-tandem">
                {/* Read along adds the voice to the page; Listen leaves the
                    page for the player. Two things, two round buttons, the
                    one people came for first. */}
                <button
                  className="tandem-btn tandem-btn--lead"
                  onClick={readAlong ? () => setReadAlong(false) : startReadAlong}
                  disabled={!pair.switchable}
                  aria-pressed={readAlong}
                  aria-label={
                    !pair.switchable
                      ? t('reader.tandem.aligning')
                      : readAlong
                        ? t('reader.tandem.readingAlong')
                        : t('reader.tandem.readAlong')
                  }
                  title={
                    pair.switchable
                      ? t('reader.tandem.readAlongHint')
                      : t('reader.tandem.notReadyHint')
                  }
                >
                  <IconReadAlong size={18} />
                </button>
                {pair.switchable && !readAlong && (
                  <button
                    className="tandem-btn"
                    onClick={() => void switchToAudio()}
                    aria-label={t('reader.tandem.listenInstead')}
                    title={t('reader.tandem.listenHint')}
                  >
                    <IconHeadphones size={18} />
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {prefs.progressBar === 'full' && (
          <div className="reader-footer-row">
            <span className="reader-footer-label">
              {prefs.mode !== 'paginated'
                ? chapterTitle
                : paginationFailed
                  ? t('reader.progress.chapterScrolls')
                  : pagesLeft === 0
                    ? pageCount === 1
                      ? t('reader.progress.wholeChapter')
                      : t('reader.progress.lastPage')
                    : t('reader.progress.pagesLeft', { n: pagesLeft })}
            </span>
          </div>
        )}
      </div>

      {sheet === 'toc' && manifest && (
        <Sheet title={t('reader.contents.title')} onClose={() => setSheet('none')}>
          <div className="sheet-tabs" role="tablist" style={{ margin: '-16px -16px 8px' }}>
            <button
              role="tab"
              aria-selected={contentsTab === 'toc'}
              onClick={() => setContentsTab('toc')}
            >
              {t('reader.contents.chaptersTab')}
            </button>
            <button
              role="tab"
              aria-selected={contentsTab === 'marks'}
              onClick={() => setContentsTab('marks')}
            >
              {annotations.length > 0
                ? t('reader.contents.marksTabCount', { n: annotations.length })
                : t('reader.contents.marksTab')}
            </button>
          </div>
          {contentsTab === 'marks' && (
            // The page's own bookmark lives with the marks now, where the
            // ribbon used to be a button in the bar.
            <button
              type="button"
              className={`bm-page${currentBookmark ? ' is-marked' : ''}`}
              aria-pressed={!!currentBookmark}
              onClick={() => void toggleBookmark()}
            >
              <IconBookmark size={17} filled={!!currentBookmark} />
              {currentBookmark
                ? t('reader.chrome.removeBookmark')
                : t('reader.chrome.bookmarkPage')}
            </button>
          )}
          {contentsTab === 'marks' &&
            (annotations.length === 0 ? (
              <p style={{ color: 'var(--rp-text-soft)' }}>{t('reader.contents.noMarks')}</p>
            ) : (
              <ul className="bm-list">
                {[...annotations]
                  .sort((a, b) => a.locator.pct - b.locator.pct)
                  .map((a) => {
                    const kindLabel = t('reader.mark.kind', { kind: a.kind });
                    const chapter =
                      manifest.chapters[a.locator.medium === 'ebook' ? a.locator.spineIdx : 0]
                        ?.title ?? t('common.chapter');
                    const text = a.selectedText ?? a.note ?? t('reader.contents.bookmarkedPage');
                    const pct = f.percent(a.locator.pct);
                    // Two controls, two buttons: the row opens the mark, the
                    // bin removes it. A button nested inside a row that was
                    // itself a button read to a screen reader as one control
                    // whose name ended in "Delete".
                    return (
                      <li key={a.id} className="bm-row">
                        <button
                          type="button"
                          className="bm-row__open"
                          aria-label={t('reader.contents.markLabel', {
                            kind: kindLabel,
                            chapter,
                            pct,
                            text: text.slice(0, 80),
                          })}
                          onClick={() => {
                            if (a.locator.medium !== 'ebook') return;
                            setSheet('none');
                            gotoChapter(
                              a.locator.spineIdx,
                              a.locator.charOffset,
                              'seek',
                              undefined,
                              'bookmark',
                              {
                                sentenceId: a.locator.sentenceId,
                                excerpt: a.selectedText,
                                mark: true,
                              },
                            );
                          }}
                        >
                          <span className="bm-row__icon">
                            <IconBookmark size={16} filled={a.kind === 'bookmark'} />
                          </span>
                          <span className="bm-row__body">
                            <span className="bm-row__where">
                              {t('reader.contents.markWhere', { kind: kindLabel, chapter, pct })}
                            </span>
                            <span className="bm-row__text">
                              {a.kind === 'note' && a.note && a.selectedText
                                ? t('reader.contents.quoteAndNote', { text, note: a.note })
                                : text}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="icon-btn bm-row__delete"
                          aria-label={t('reader.contents.deleteMark', { kind: a.kind })}
                          onClick={() => void deleteAnnotation(a.id)}
                        >
                          <IconTrash size={15} />
                        </button>
                      </li>
                    );
                  })}
              </ul>
            ))}
          {contentsTab === 'toc' && manifest.toc.length === 0 && (
            <p>{t('reader.contents.noToc')}</p>
          )}
          {contentsTab === 'toc' &&
            // Named `entry`, not `t`: the parameter used to shadow the
            // translation function for the whole of this row.
            manifest.toc.map((entry, i) => (
              <button
                key={i}
                className="list-row"
                style={{ paddingInlineStart: 16 + entry.depth * 16 }}
                aria-current={i === currentTocRow ? 'true' : undefined}
                onClick={() => {
                  setSheet('none');
                  gotoChapter(entry.spineIdx, 0, 'seek', entry.fragment ?? undefined, 'toc');
                }}
              >
                <span className="grow">{entry.title}</span>
              </button>
            ))}
        </Sheet>
      )}

      {sheet === 'settings' && (
        <ReaderSettingsSheet
          prefs={prefs}
          onChange={(p) => {
            setPrefs(p);
            savePrefs(p);
            pendingTargetRef.current = { charOffset: currentOffsetRef.current };
          }}
          onClose={() => setSheet('none')}
        />
      )}

      {sheet === 'search' && (
        <SearchSheet
          bookId={id}
          onClose={() => setSheet('none')}
          onJump={(s, off, text) => {
            setSheet('none');
            setFound({ spineIdx: s, charOffset: off, text });
            gotoChapter(s, off, 'seek', undefined, 'search');
          }}
        />
      )}

      {sheet === 'note' && (
        <Sheet
          title={editingNote ? t('reader.note.edit') : t('reader.note.add')}
          onClose={() => {
            // On a phone the way to dismiss the keyboard is to tap outside,
            // which lands on the backdrop and closes the sheet - so an
            // accidental dismissal used to take the note with it silently.
            if (noteDraft.trim() && !window.confirm(t('reader.note.discard'))) return;
            setSheet('none');
            setEditingNote(null);
            setSelection(null);
            document.getSelection()?.removeAllRanges();
          }}
        >
          {selection && !editingNote && (
            <blockquote style={{ color: 'var(--rp-text-soft)', fontSize: 14, margin: '0 0 12px' }}>
              {t('reader.quoted', {
                text: selection.text.slice(0, 160) + (selection.text.length > 160 ? '…' : ''),
              })}
            </blockquote>
          )}
          <div className="field">
            <label htmlFor="note-text">{t('reader.note.label')}</label>
            <textarea
              id="note-text"
              className="input"
              rows={4}
              autoFocus
              style={{ paddingBlock: 10, resize: 'vertical' }}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
            />
          </div>
          <button
            className="btn"
            onClick={() => {
              // Closing regardless discarded the text on any failure - offline,
              // an expired session, a server hiccup - and there is no draft
              // anywhere to recover it from. The toast already says what went
              // wrong; leaving the sheet open makes retrying one tap.
              void (async () => {
                const ok = editingNote
                  ? await editNote(editingNote, noteDraft)
                  : await addAnnotation('note', noteDraft);
                if (!ok) return;
                setSheet('none');
                setEditingNote(null);
                setSelection(null);
                document.getSelection()?.removeAllRanges();
              })();
            }}
          >
            {editingNote ? t('reader.note.saveChanges') : t('reader.note.save')}
          </button>
        </Sheet>
      )}

      {/* The narration itself. Mounted only while reading along, so turning it
          off is the same act as unmounting the element that makes the sound. */}
      {narration.element}
    </div>
  );
}

/* -------------------------------------------------------------- helpers */

function pctFor(manifest: ReaderManifest, spineIdx: number, charOffset: number): number {
  const ch = manifest.chapters[spineIdx];
  if (!ch || manifest.totalChars === 0) return 0;
  return Math.min(1, Math.max(0, (ch.cumChars + charOffset) / manifest.totalChars));
}

function locatorAt(
  manifest: ReaderManifest,
  sentences: SentenceIndexEntry[],
  spineIdx: number,
  charOffset: number,
): EbookLocator {
  const sent = sentences.find((s) => charOffset >= s.start && charOffset < s.end);
  return {
    medium: 'ebook',
    spineIdx,
    charOffset,
    sentenceId: sent?.id,
    pct: pctFor(manifest, spineIdx, charOffset),
  };
}

function interceptLink(
  e: React.MouseEvent,
  manifest: ReaderManifest | null,
  currentSpine: number,
  gotoChapter: (
    s: number,
    off: number,
    intent: 'seek' | 'open',
    fragment: string | undefined,
    reason: JumpReason,
  ) => void,
): void {
  const a = (e.target as Element).closest('a');
  if (!a) return;
  const internal = a.getAttribute('data-rp-href');
  if (internal) {
    e.preventDefault();
    const [file, frag] = internal.split('#');
    // "#fn3" (same document) or "chapter.xhtml#fn3" (cross-chapter).
    const target = file ? manifest?.chapters.find((c) => c.href === file) : undefined;
    const spine = target ? target.idx : file ? -1 : currentSpine;
    if (spine >= 0) gotoChapter(spine, 0, 'seek', frag || undefined, 'link');
  } else if ((a.getAttribute('href') ?? '').startsWith('#')) {
    e.preventDefault();
    const frag = (a.getAttribute('href') ?? '').slice(1);
    if (frag) gotoChapter(currentSpine, 0, 'seek', frag, 'link');
  }
}

/** Character offset of the element with `id` (or `name`) inside the chapter. */
function offsetForFragment(content: HTMLElement, map: TextMap, fragment: string): number | null {
  let el: Element | null = null;
  try {
    el = content.querySelector(`[id="${CSS.escape(fragment)}"], a[name="${CSS.escape(fragment)}"]`);
  } catch {
    el = null;
  }
  if (!el) return null;
  // First text node at or after the element.
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (el.contains(node) || el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const off = domToOffset(map, node, 0);
      if (off !== null) return off;
    }
    node = walker.nextNode();
  }
  return null;
}

const RTL_LANGS = new Set(['he', 'iw', 'ar', 'fa', 'ur', 'yi', 'ps', 'sd', 'ug', 'dv']);
function isRtlLanguage(lang: string | null): boolean {
  if (!lang) return false;
  return RTL_LANGS.has(lang.toLowerCase().split(/[-_]/)[0]!);
}

type HighlightApi = {
  highlights?: Map<string, unknown> & { set(k: string, v: unknown): void; delete(k: string): void };
};

/**
 * Whether a character offset is currently on screen.
 *
 * Asked of geometry rather than of offsets, because a two-page spread shows
 * two ranges that are not contiguous and a scroll view shows a window that no
 * offset arithmetic knows the height of. The paginated container clips, so a
 * range on another page has a rect well outside the box.
 */
/**
 * Whether any element of the chapter runs past the foot of the page box by
 * more than a line: columns that never formed, or one element too tall to
 * fragment. A fragmented block reports the union of its fragments, all of
 * them inside the box, so only trapped content reaches below it.
 */
function trappedContent(el: HTMLElement): boolean {
  const box = el.getBoundingClientRect();
  const limit = box.bottom + Math.max(12, parseFloat(getComputedStyle(el).lineHeight) || 24);
  for (const child of el.querySelectorAll('*')) {
    const r = child.getBoundingClientRect();
    if (r.height > 0 && r.bottom > limit) return true;
  }
  return false;
}

/** Whether a point lies on the selected words, with a little slack for a finger. */
function tapInSelection(sel: Selection, x: number, y: number): boolean {
  if (!sel.rangeCount) return false;
  for (const r of sel.getRangeAt(0).getClientRects())
    if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6) return true;
  return false;
}

/** A host's content origin as a box, for the marker arithmetic that wants one. */
function contentOriginBox(host: HTMLElement): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const o = hostOrigin(host);
  return { ...o, right: o.left + host.scrollWidth, bottom: o.top + host.scrollHeight };
}

function spanOnScreen(
  map: TextMap,
  offset: number,
  box: { left: number; right: number; top: number; bottom: number } | undefined,
): boolean {
  if (!box) return false;
  const range = rangeForSpan(map, offset, offset + 1);
  if (!range) return false;
  const r = range.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  return r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right;
}

/**
 * Where the voice is inside a sentence: the pace estimate, held to the
 * sentence's own span, else the sentence's start. Between sentences the
 * estimate walks the gap, which is not this sentence, so it is clamped.
 */
function spokenOffset(cues: Cue[], cue: Cue, bookMs: number): number {
  const at = paceOffset(cues, bookMs);
  if (at === null) return cue.charStart;
  return Math.min(cue.charEnd - 1, Math.max(cue.charStart, Math.round(at)));
}

/** The same box, moved down the page by `dy`: where a glide will leave it. */
function shifted(b: DOMRect, dy: number) {
  return { left: b.left, right: b.right, top: b.top + dy, bottom: b.bottom + dy };
}

function paintHandoff(map: TextMap, start: number, end: number): () => void {
  const css = CSS as unknown as HighlightApi;
  if (!css.highlights || typeof Highlight === 'undefined') return () => {};
  const r = rangeForSpan(map, start, end);
  if (!r) return () => {};
  css.highlights.set('rp-handoff', new Highlight(r));
  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    setTimeout(() => css.highlights!.delete('rp-handoff'), 400);
  };
  setTimeout(clear, 12000);
  return clear;
}

/* --------------------------------------------------------------- sheets */

function ReaderSettingsSheet({
  prefs,
  onChange,
  onClose,
}: {
  prefs: ReaderPrefs;
  onChange: (p: ReaderPrefs) => void;
  onClose: () => void;
}) {
  const t = useT();
  const set = <K extends keyof ReaderPrefs>(k: K, v: ReaderPrefs[K]) =>
    onChange({ ...prefs, [k]: v });
  const themes: { value: ReaderPrefs['theme']; label: string }[] = [
    { value: 'auto', label: t('reader.theme.auto') },
    { value: 'paper', label: t('reader.theme.paper') },
    { value: 'sepia', label: t('reader.theme.sepia') },
    { value: 'night', label: t('reader.theme.night') },
    { value: 'contrast', label: t('reader.theme.contrast') },
  ];
  return (
    <Sheet title={t('reader.settings.title')} onClose={onClose}>
      <div className="rs-group" role="group" aria-label={t('reader.settings.theme')}>
        <div className="rs-themes">
          {themes.map((th) => (
            <button
              key={th.value}
              className={`rs-swatch rs-swatch--${th.value}`}
              aria-pressed={prefs.theme === th.value}
              aria-label={t('reader.settings.themeLabel', { name: th.label })}
              onClick={() => set('theme', th.value)}
            >
              <span className="rs-swatch__disc" aria-hidden="true">
                Aa
              </span>
              <span className="rs-swatch__label">{th.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="rs-group">
        <div className="rs-size" role="group" aria-label={t('reader.settings.textSize')}>
          <button
            className="rs-size__btn"
            style={{ fontSize: 17 }}
            aria-label={t('reader.settings.smaller')}
            disabled={prefs.size <= SIZE_MIN}
            onClick={() => set('size', Math.max(SIZE_MIN, prefs.size - 1))}
          >
            A
          </button>
          <span className="rs-size__value" aria-live="polite">
            {prefs.size}
            <small>px</small>
          </span>
          <button
            className="rs-size__btn"
            style={{ fontSize: 26 }}
            aria-label={t('reader.settings.larger')}
            disabled={prefs.size >= SIZE_MAX}
            onClick={() => set('size', Math.min(SIZE_MAX, prefs.size + 1))}
          >
            A
          </button>
        </div>
        <label className="rs-slider" htmlFor="rs-dim">
          <IconSun size={16} style={{ opacity: 0.55 }} />
          <input
            id="rs-dim"
            className="slider"
            type="range"
            min={0.35}
            max={1}
            step={0.05}
            value={prefs.brightness}
            aria-label={t('reader.settings.brightness')}
            onChange={(e) => set('brightness', Number(e.target.value))}
          />
          <IconSun size={22} />
        </label>
      </div>

      <div className="rs-group" role="group" aria-label={t('reader.settings.font')}>
        <div className="rs-label">{t('reader.settings.font')}</div>
        <div className="rs-fonts">
          {(Object.keys(FONTS) as (keyof typeof FONTS)[]).map((k) => (
            <button
              key={k}
              className="rs-font"
              aria-pressed={prefs.font === k}
              style={{ fontFamily: FONTS[k].stack }}
              onClick={() => set('font', k)}
            >
              <span className="rs-font__sample" aria-hidden="true">
                Aa
              </span>
              <span className="rs-font__name">
                {t(FONTS[k].label)}
                <small>{t(FONTS[k].note)}</small>
              </span>
              {prefs.font === k && <IconCheck size={18} />}
            </button>
          ))}
        </div>
      </div>

      {/* How the book moves. Choosing Pages or Scroll changes what the rest
          of this group can even mean, so what belongs to each mode is nested
          under it rather than listed beside it - Columns used to sit under
          the heading "Progress bar", which is neither. */}
      <div className="rs-group">
        <div className="rs-label">{t('reader.settings.mode')}</div>
        <div className="segmented" role="group" aria-label={t('reader.settings.mode')}>
          <button
            aria-pressed={prefs.mode === 'paginated'}
            onClick={() => set('mode', 'paginated')}
          >
            {t('reader.mode.paginated')}
          </button>
          <button aria-pressed={prefs.mode === 'scroll'} onClick={() => set('mode', 'scroll')}>
            {t('reader.mode.scroll')}
          </button>
        </div>

        {prefs.mode === 'paginated' ? (
          <>
            <div className="rs-label rs-label--sub">{t('reader.settings.columns')}</div>
            <div className="segmented" role="group" aria-label={t('reader.settings.columns')}>
              {(['auto', 'one', 'two'] as const).map((c) => (
                <button
                  key={c}
                  aria-pressed={prefs.columns === c}
                  onClick={() => set('columns', c)}
                >
                  {t(`reader.columns.${c}` as const)}
                </button>
              ))}
            </div>

            <div className="rs-label rs-label--sub">{t('reader.settings.pageTurn')}</div>
            <div className="segmented" role="group" aria-label={t('reader.settings.pageTurn')}>
              {(['slide', 'fade', 'instant'] as const).map((v) => (
                <button
                  key={v}
                  aria-pressed={prefs.pageTurn === v}
                  onClick={() => set('pageTurn', v)}
                >
                  {t(`reader.pageTurn.${v}` as const)}
                </button>
              ))}
            </div>
            <p className="rs-note">{t('reader.settings.pagesNote')}</p>
          </>
        ) : (
          <p className="rs-note">{t('reader.settings.scrollNote')}</p>
        )}
      </div>

      <div className="rs-group">
        <div className="rs-label">{t('reader.settings.progressBar')}</div>
        <div className="segmented" role="group" aria-label={t('reader.settings.progressBar')}>
          {(['full', 'compact', 'hidden'] as const).map((v) => (
            <button
              key={v}
              aria-pressed={prefs.progressBar === v}
              onClick={() => set('progressBar', v)}
            >
              {t(`reader.progressBar.${v}` as const)}
            </button>
          ))}
        </div>
      </div>

      <div className="rs-group">
        <div className="rs-label">{t('reader.settings.voiceMark')}</div>
        <div className="segmented" role="group" aria-label={t('reader.settings.voiceMark')}>
          {(['margin', 'wash'] as const).map((v) => (
            <button
              key={v}
              aria-pressed={prefs.voiceMark === v}
              onClick={() => set('voiceMark', v)}
            >
              {t(`reader.voiceMark.${v}` as const)}
            </button>
          ))}
        </div>
      </div>

      <div className="rs-group">
        <div className="rs-label">{t('reader.settings.spacing')}</div>
        <label className="rs-slider" htmlFor="rs-leading">
          <span className="rs-slider__name">{t('reader.settings.lines')}</span>
          <input
            id="rs-leading"
            className="slider"
            type="range"
            min={1.3}
            max={2.1}
            step={0.04}
            value={prefs.lineHeight}
            aria-label={t('reader.settings.lineHeight')}
            onChange={(e) => set('lineHeight', Number(e.target.value))}
          />
          <span className="rs-slider__val">{prefs.lineHeight.toFixed(2)}</span>
        </label>
        <label className="rs-slider" htmlFor="rs-weight">
          <span className="rs-slider__name">{t('reader.settings.weight')}</span>
          <input
            id="rs-weight"
            className="slider"
            type="range"
            min={300}
            max={700}
            step={20}
            value={prefs.weight}
            aria-label={t('reader.settings.fontWeight')}
            onChange={(e) => set('weight', Number(e.target.value))}
          />
          <span className="rs-slider__val">{prefs.weight}</span>
        </label>
        <div className="segmented" role="group" aria-label={t('reader.settings.margins')}>
          {(['compact', 'normal', 'wide'] as const).map((m) => (
            <button key={m} aria-pressed={prefs.margin === m} onClick={() => set('margin', m)}>
              {t(`reader.margin.${m}` as const)}
            </button>
          ))}
        </div>
      </div>

      <div className="rs-group">
        <div className="rs-label">{t('reader.settings.text')}</div>
        <div className="segmented" role="group" aria-label={t('reader.settings.alignment')}>
          <button aria-pressed={prefs.align === 'start'} onClick={() => set('align', 'start')}>
            {t('reader.align.start')}
          </button>
          <button aria-pressed={prefs.align === 'justify'} onClick={() => set('align', 'justify')}>
            {t('reader.align.justify')}
          </button>
        </div>
        <label className="rs-toggle">
          <span>{t('reader.settings.hyphenation')}</span>
          <input
            type="checkbox"
            role="switch"
            checked={prefs.hyphens}
            onChange={(e) => set('hyphens', e.target.checked)}
          />
        </label>
      </div>
    </Sheet>
  );
}

interface SearchMatch {
  spineIdx: number;
  charOffset: number;
  matchLength: number;
  before: string;
  match: string;
  after: string;
  chapterTitle: string | null;
}

/**
 * Find in book.
 *
 * The server returns each hit already split into what came before it, the hit
 * itself, and what came after, so the row can mark the words without
 * re-finding them in the excerpt - re-finding would mark the wrong occurrence
 * whenever a word appears twice inside sixty characters.
 */
function SearchSheet({
  bookId,
  onClose,
  onJump,
}: {
  bookId: string;
  onClose: () => void;
  onJump: (spineIdx: number, charOffset: number, text: string) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const t = useT();

  const run = async () => {
    if (q.trim().length < 2) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await api<{ matches: SearchMatch[] }>(
        `/api/books/${bookId}/search?q=${encodeURIComponent(q.trim())}`,
      );
      setResults(res.matches);
    } catch {
      // "No matches" and "the search did not run" are different answers, and
      // telling them apart is the difference between trusting the book and
      // trusting the network.
      setResults([]);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t('reader.search.title')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        style={{ display: 'flex', gap: 8, marginBlockEnd: 12 }}
      >
        <input
          className="input"
          type="search"
          placeholder={t('reader.search.placeholder')}
          aria-label={t('reader.search.input')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <button className="btn" type="submit" disabled={busy || q.trim().length < 2}>
          {busy ? '…' : t('reader.search.go')}
        </button>
      </form>
      {results !== null && (
        <>
          {results.length > 0 && (
            <p className="search-count" role="status">
              {results.length === 100
                ? t('reader.search.firstMatches', { n: 100 })
                : t('reader.search.matches', { n: results.length })}
            </p>
          )}
          {results.length === 0 ? (
            <p style={{ color: 'var(--rp-text-soft)' }}>
              {failed ? t('reader.search.failed') : t('reader.search.none')}
            </p>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.spineIdx}-${r.charOffset}-${i}`}
                className="list-row search-hit"
                onClick={() => onJump(r.spineIdx, r.charOffset, r.match)}
              >
                <span className="grow" style={{ whiteSpace: 'normal' }}>
                  <span className="search-hit__chapter">
                    {r.chapterTitle ?? t('common.chapterN', { n: r.spineIdx + 1 })}
                  </span>
                  <span className="search-hit__text">
                    {r.before}
                    <mark className="search-hit__mark">{r.match}</mark>
                    {r.after}
                  </span>
                </span>
              </button>
            ))
          )}
        </>
      )}
    </Sheet>
  );
}
