import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { LanguagesSheet } from '../translations/LanguagesSheet';
import { type AudioLocator, type EbookLocator } from '@readport/shared';
import { api, ApiError, failureMessage, isOffline } from '../api/client';
import { cachedSwitch, removeDownload } from '../offline/downloads';
import { type Annotation, type BookDetail, type ResolveResponse } from '../lib/types';
import { recordCheckpoint, resumeLocator, setActiveLocatorProvider } from '../progress/engine';
import {
  audioReturnAfterJump,
  audioContinued,
  type AudioReturnPoint,
  type JumpReason,
} from '../reader/continuity';
import { bookAudioSupport } from '../lib/audioSupport';
import { Cover, Sheet, useToast } from '../components/ui';
import { useProgressNotices } from '../progress/notices';
import { FriendMarkers, FriendsButton, useFriendsOnBook } from '../friends/FriendsOnBar';
import {
  IconBack,
  IconClose,
  IconTrash,
  IconBookmark,
  IconChevronDown,
  IconBookOpen,
  IconChapterNext,
  IconChapterPrev,
  IconMoon,
  IconPause,
  IconPlay,
  IconSkipBack,
  IconSkipFwd,
  IconSpeed,
  IconToc,
  IconLanguages,
} from '../components/icons';
import { formatDuration } from '../lib/format';
import { ambientColorFromImage } from '../lib/ambient';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { type MessageKey } from '../i18n/messages/en';
import { loadPlayback, savePlayback, setBookSpeed, speedFor, syncPlayback } from './prefs';

const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SKIP_CHOICES = [10, 15, 30, 45, 60];
/** Labels are catalog keys, translated where the chips are drawn; `n` is the number the label shows. */
const SLEEP_OPTIONS: { key: MessageKey; minutes: number; n?: number }[] = [
  { key: 'player.sleep.off', minutes: 0 },
  { key: 'player.sleep.minutes', minutes: 15, n: 15 },
  { key: 'player.sleep.minutes', minutes: 30, n: 30 },
  { key: 'player.sleep.minutes', minutes: 45, n: 45 },
  { key: 'player.sleep.hours', minutes: 60, n: 1 },
  { key: 'player.sleep.endOfChapter', minutes: -1 },
];

type SheetKind = 'none' | 'chapters' | 'playback' | 'sleep' | 'bookmarks' | 'languages';

interface SkipPrefs {
  back: number;
  fwd: number;
}

export function PlayerPage() {
  const { id = '' } = useParams();
  const friendsHere = useFriendsOnBook(id || null);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT();
  const f = useFormat();

  const audioRef = useRef<HTMLAudioElement>(null);
  const [detail, setDetail] = useState<BookDetail | null>(null);
  /** A catalog key, so the message follows a language switch. */
  const [error, setError] = useState<MessageKey | null>(null);
  const [trackIdx, setTrackIdx] = useState(0);
  const [positionMs, setPositionMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [speed, setSpeed] = useState(() => speedFor(loadPlayback(), id));
  const [skip, setSkip] = useState<SkipPrefs>(() => {
    const p = loadPlayback();
    return { back: p.skipBack, fwd: p.skipForward };
  });
  const [sheet, setSheet] = useState<SheetKind>('none');
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
  const [sleepChapterEnd, setSleepChapterEnd] = useState(false);
  const [sleepTick, setSleepTick] = useState(0);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  /** Position before a deliberate jump (bookmark, chapter list, scrubber drag). */
  const [returnPoint, setReturnPoint] = useState<AudioReturnPoint | null>(null);
  const [handoffMarkerPct, setHandoffMarkerPct] = useState<number | null>(null);
  const [ambient, setAmbient] = useState<string | null>(null);

  /**
   * Seek to apply once the current track's metadata is loaded. Read at
   * event time (never snapshotted into an effect closure): the resume
   * position arrives after the element has already loaded track 0, so the
   * seek must be applied whenever it appears, not only on src changes.
   */
  const pendingSeekRef = useRef<{ trackIdx: number; positionMs: number; autoplay: boolean } | null>(
    null,
  );
  const [seekVersion, setSeekVersion] = useState(0);
  const lastHeartbeatRef = useRef(0);
  const lastPositionStateRef = useRef(0);
  const scrubbing = useRef(false);
  /**
   * Where the thumb is while a drag is in progress.
   *
   * Dragging fires an input event per pixel, and each one used to seek the
   * audio element and queue a progress write - hundreds of seeks and hundreds
   * of writes for one gesture, on a phone, over a network. The thumb follows
   * the finger from here, and the audio is moved once, when the finger lifts.
   */
  const [dragMs, setDragMs] = useState<number | null>(null);

  const tracks = detail?.tracks ?? [];
  const totalMs = useMemo(() => tracks.reduce((a, t) => a + t.durationMs, 0), [tracks]);
  const bookMs = (tracks[trackIdx]?.startMsAbsolute ?? 0) + positionMs;
  const bookMsRef = useRef(bookMs);
  bookMsRef.current = bookMs;

  const chapters = detail?.chapters ?? [];
  const chapterIndex = useMemo(() => {
    let found = -1;
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i]!;
      if (c.startMs != null && c.startMs <= bookMs + 250) found = i;
      else break;
    }
    return found;
  }, [chapters, bookMs]);
  const currentChapter = chapterIndex >= 0 ? chapters[chapterIndex]! : null;
  const chapterEndMs = currentChapter?.endMs ?? chapters[chapterIndex + 1]?.startMs ?? totalMs;
  const chapterStartMs = currentChapter?.startMs ?? 0;
  const chapterPct =
    chapterEndMs > chapterStartMs
      ? Math.min(1, Math.max(0, (bookMs - chapterStartMs) / (chapterEndMs - chapterStartMs)))
      : 0;

  const locatorNow = useCallback((): AudioLocator => {
    const pending = pendingSeekRef.current;
    const index = pending?.trackIdx ?? trackIdx;
    const track = tracks[index];
    const live = audioRef.current?.currentTime;
    // A queued seek belongs to the next track, not the old element clock.
    const within =
      pending?.positionMs ?? (live != null && Number.isFinite(live) ? live * 1000 : positionMs);
    const duration = track?.durationMs ?? 0;
    const position = Math.round(
      Math.min(Math.max(0, duration), Math.max(0, Number.isFinite(within) ? within : 0)),
    );
    const absolute = Math.round(
      Math.min(totalMs, Math.max(0, (track?.startMsAbsolute ?? 0) + position)),
    );
    return {
      medium: 'audio',
      trackIdx: index,
      positionMs: position,
      bookMs: absolute,
      pct: totalMs > 0 ? absolute / totalMs : 0,
    };
  }, [trackIdx, positionMs, tracks, totalMs]);
  /**
   * The current locator, readable from a cleanup that must not re-run.
   *
   * `locatorNow` is rebuilt on every position change - four times a second
   * while playing - so an effect that depends on it tears down that often. A
   * checkpoint in such a cleanup would write four times a second; a ref lets
   * the mount-only effect below read the latest value and write exactly once.
   */
  const locatorNowRef = useRef<(() => AudioLocator) | null>(null);
  locatorNowRef.current = detail ? locatorNow : null;
  useProgressNotices(id, () => locatorNowRef.current?.() ?? null);

  /**
   * Leaving the player records where you got to.
   *
   * Heartbeats are fifteen seconds apart and Back is a route change, not a
   * pause event, so closing the player mid-chapter could drop a quarter of a
   * minute of listening - and on a phone, Back is how everyone leaves.
   */
  useLayoutEffect(() => {
    return () => {
      // Layout cleanup runs before React clears the audio DOM ref. Passive
      // cleanup would lose the live clock even with a capture function.
      const at = locatorNowRef.current?.();
      if (at) void recordCheckpoint(id, 'pause', at);
    };
  }, [id]);

  const locatorFor = useCallback(
    (t: number, within: number): AudioLocator => {
      const abs = (tracks[t]?.startMsAbsolute ?? 0) + within;
      return {
        medium: 'audio',
        trackIdx: t,
        positionMs: Math.max(0, Math.round(within)),
        bookMs: Math.max(0, Math.round(abs)),
        pct: totalMs > 0 ? Math.min(1, Math.max(0, abs / totalMs)) : 0,
      };
    },
    [tracks, totalMs],
  );

  // Honest format support: detected-but-unplayable formats (e.g. FLAC/OGG on
  // Safari) get a clear explanation instead of a player that fails later.
  const support = useMemo(
    () =>
      bookAudioSupport(
        tracks.length > 0 ? tracks.map((t) => t.format) : detail ? [detail.book.format] : [],
      ),
    [tracks, detail],
  );

  // Lifecycle persistence: expose the LIVE playback position so
  // backgrounding records it even inside the 15s heartbeat window.
  useEffect(() => {
    if (!detail) return;
    return setActiveLocatorProvider(() => ({ bookId: id, locator: locatorNow() }));
  }, [detail, id, locatorNow]);

  /* ------------------------------------------------------------ loading */

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await api<BookDetail>(`/api/books/${id}`);
        if (!alive) return;
        setDetail(d);
        const total = d.tracks.reduce((a, x) => a + x.durationMs, 0);
        const pctOf = (t: number, p: number) =>
          total > 0
            ? Math.min(1, Math.max(0, ((d.tracks[t]?.startMsAbsolute ?? 0) + p) / total))
            : 0;
        const anns = await api<{ annotations: Annotation[] }>(`/api/books/${id}/annotations`).catch(
          () => ({ annotations: [] as Annotation[] }),
        );
        if (alive) setAnnotations(anns.annotations);

        const trackParam = searchParams.get('track');
        const resume = await resumeLocator(id);
        if (!alive) return;
        const posParam = searchParams.get('pos');
        const handoff = searchParams.get('handoff') === '1';
        if (posParam !== null) {
          let track = trackParam !== null ? Number(trackParam) || 0 : -1;
          let p = Math.max(0, Number(posParam) || 0);
          if (track < 0) {
            // pos interpreted as absolute bookMs (chapter links).
            track = 0;
            for (let i = 0; i < d.tracks.length; i++) {
              if (p >= d.tracks[i]!.startMsAbsolute) track = i;
            }
            p = p - d.tracks[track]!.startMsAbsolute;
          }
          track = Math.min(Math.max(0, track), Math.max(0, d.tracks.length - 1));
          pendingSeekRef.current = { trackIdx: track, positionMs: p, autoplay: handoff };
          if (handoff) {
            const abs = (d.tracks[track]?.startMsAbsolute ?? 0) + p;
            setHandoffMarkerPct(total > 0 ? abs / total : null);
            const gran = searchParams.get('granularity');
            // A handoff aims deliberately behind the reader, so an unexplained
            // rewind would read as a bug rather than as the safeguard it is.
            const back = Math.round(Number(searchParams.get('back') ?? 0) / 1000);
            if (searchParams.get('via') === 'translation') {
              // From the same book in another language: say which, and how close.
              const name = f.languageName(searchParams.get('fromLang') || null);
              toast.show(
                gran === 'paragraph'
                  ? t('translations.handoff.from', { language: name })
                  : t('translations.handoff.near', { language: name }),
              );
            } else {
              toast.show(
                back >= 3
                  ? t('player.handoff.startingBefore', { n: back })
                  : gran === 'sentence'
                    ? t('player.handoff.fromPosition')
                    : t('player.handoff.nearPosition'),
              );
            }
          }
          void recordCheckpoint(id, handoff ? 'switch' : 'seek', {
            medium: 'audio',
            trackIdx: track,
            positionMs: Math.round(p),
            bookMs: Math.round((d.tracks[track]?.startMsAbsolute ?? 0) + p),
            pct: pctOf(track, p),
          });
        } else {
          if (resume && resume.locator.medium === 'audio') {
            pendingSeekRef.current = {
              trackIdx: Math.min(resume.locator.trackIdx, Math.max(0, d.tracks.length - 1)),
              positionMs: resume.locator.positionMs,
              autoplay: false,
            };
          } else {
            pendingSeekRef.current = { trackIdx: 0, positionMs: 0, autoplay: false };
          }
          const target = pendingSeekRef.current;
          void recordCheckpoint(id, 'open', {
            medium: 'audio',
            trackIdx: target.trackIdx,
            positionMs: Math.round(target.positionMs),
            bookMs: Math.round(
              (d.tracks[target.trackIdx]?.startMsAbsolute ?? 0) + target.positionMs,
            ),
            pct: pctOf(target.trackIdx, target.positionMs),
          });
        }
        const target = pendingSeekRef.current;
        if (target) {
          setTrackIdx(target.trackIdx);
          setPositionMs(target.positionMs);
          setSeekVersion((v) => v + 1);
        }
      } catch (err) {
        // Gone, or hidden from this listener: an offline copy is not theirs
        // to keep playing either (see the book page).
        if (err instanceof ApiError && err.status === 404) void removeDownload(id).catch(() => {});
        if (alive) setError('player.couldNotLoad');
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  // Ambient background tint from the cover.
  useEffect(() => {
    if (!detail?.book.hasCover) return;
    let cancelled = false;
    ambientColorFromImage(`/api/books/${id}/cover`).then((c) => {
      if (!cancelled && c) setAmbient(c);
    });
    return () => {
      cancelled = true;
    };
  }, [detail, id]);

  /* -------------------------------------------------------- audio wiring */

  const src = tracks.length > 0 ? `/api/books/${id}/track/${trackIdx}` : undefined;

  /** Apply the pending seek if it targets the loaded track. */
  const applyPendingSeek = useCallback(() => {
    const el = audioRef.current;
    const target = pendingSeekRef.current;
    if (!el || !target || target.trackIdx !== trackIdx || el.readyState < 1) return;
    pendingSeekRef.current = null;
    el.currentTime = target.positionMs / 1000;
    setPositionMs(target.positionMs);
    if (target.autoplay) void el.play().catch(() => {});
  }, [trackIdx]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !src) return;
    el.playbackRate = speed;
    el.preservesPitch = true;
    // Metadata may already be loaded (resume arrived after track 0 loaded):
    // apply now, and otherwise as soon as it loads.
    applyPendingSeek();
    el.addEventListener('loadedmetadata', applyPendingSeek);
    return () => el.removeEventListener('loadedmetadata', applyPendingSeek);
  }, [src, trackIdx, seekVersion, applyPendingSeek]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = speed;
    el.preservesPitch = true;
    // Remembered against this book, and synced: a rate chosen for a narrator
    // is about the narrator, so it should be waiting on the phone too.
    setBookSpeed(id, speed);
  }, [speed, id]);

  useEffect(() => {
    const p = loadPlayback();
    savePlayback({ ...p, skipBack: skip.back, skipForward: skip.fwd });
  }, [skip]);

  /**
   * Pick up playback settings changed on another device, once, on open.
   * Applied only where this session has not already made a choice of its own -
   * a rate the listener just set here must not be undone by a slower answer.
   */
  useEffect(() => {
    let alive = true;
    void syncPlayback().then((p) => {
      if (!alive) return;
      setSkip({ back: p.skipBack, fwd: p.skipForward });
      setSpeed(speedFor(p, id));
    });
    return () => {
      alive = false;
    };
  }, [id]);

  // Sleep countdown needs a clock even while paused/scrubbing.
  useEffect(() => {
    if (!sleepUntil) return;
    const t = setInterval(() => setSleepTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [sleepUntil]);

  const publishPositionState = useCallback(() => {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const el = audioRef.current;
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: el.duration,
        playbackRate: el.playbackRate,
        position: Math.min(el.duration, Math.max(0, el.currentTime)),
      });
    } catch {
      /* unsupported values */
    }
  }, []);

  const onTimeUpdate = () => {
    const el = audioRef.current;
    if (!el) return;
    const ms = el.currentTime * 1000;
    if (!scrubbing.current) setPositionMs(ms);
    const now = Date.now();
    if (now - lastPositionStateRef.current > 1000) {
      lastPositionStateRef.current = now;
      publishPositionState();
    }
    if (playing && now - lastHeartbeatRef.current > 15_000) {
      lastHeartbeatRef.current = now;
      void recordCheckpoint(id, 'heartbeat', locatorFor(trackIdx, ms));
    }
    // Sleep timer.
    if (sleepUntil && now >= sleepUntil) {
      el.pause();
      setSleepUntil(null);
      toast.show(t('player.sleep.pausedTimer'));
    }
    const abs = (tracks[trackIdx]?.startMsAbsolute ?? 0) + ms;
    if (!scrubbing.current && !pendingSeekRef.current)
      setReturnPoint((point) => (point && audioContinued(point, abs) ? null : point));
    if (sleepChapterEnd && currentChapter && abs >= chapterEndMs - 400) {
      el.pause();
      setSleepChapterEnd(false);
      toast.show(t('player.sleep.pausedChapterEnd'));
    }
  };

  const onEnded = () => {
    if (trackIdx < tracks.length - 1) {
      pendingSeekRef.current = { trackIdx: trackIdx + 1, positionMs: 0, autoplay: true };
      setTrackIdx(trackIdx + 1);
      setPositionMs(0);
      setSeekVersion((v) => v + 1);
    } else {
      setPlaying(false);
      void recordCheckpoint(id, 'finish', { ...locatorNow(), pct: 1 });
      toast.show(t('player.toast.finished'));
    }
  };

  const seekTo = useCallback(
    (absMs: number, reason: JumpReason) => {
      if (tracks.length === 0) return;
      const clamped = Math.max(0, Math.min(absMs, Math.max(0, totalMs - 200)));
      setReturnPoint(audioReturnAfterJump(bookMsRef.current, clamped, reason));
      bookMsRef.current = clamped;
      let t = 0;
      for (let i = 0; i < tracks.length; i++) {
        if (clamped >= tracks[i]!.startMsAbsolute) t = i;
      }
      const within = clamped - tracks[t]!.startMsAbsolute;
      const el = audioRef.current;
      if (t === trackIdx && el && el.readyState >= 1) {
        el.currentTime = within / 1000;
      } else {
        pendingSeekRef.current = { trackIdx: t, positionMs: within, autoplay: playing };
        setTrackIdx(t);
        setSeekVersion((v) => v + 1);
      }
      setPositionMs(within);
      void recordCheckpoint(id, 'seek', locatorFor(t, within));
    },
    [tracks, totalMs, trackIdx, playing, id, locatorFor],
  );
  const seekToRef = useRef(seekTo);
  seekToRef.current = seekTo;

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => toast.show(t('player.toast.playbackBlocked')));
    else el.pause();
  }, [toast, t]);

  // Play → durable checkpoint with explicit intent. Pressing play is a
  // deliberate act, so it takes the progress claim back for this session:
  // without it, a tab that lost the claim to another device only emits
  // heartbeats, which are recorded and never applied - a whole listening
  // session would vanish if the tab is killed before it can pause.
  const onPlay = () => {
    setPlaying(true);
    lastHeartbeatRef.current = Date.now();
    const el = audioRef.current;
    const ms = el && Number.isFinite(el.currentTime) ? el.currentTime * 1000 : positionMs;
    void recordCheckpoint(id, 'seek', locatorFor(trackIdx, ms));
  };

  // Pause → durable checkpoint with explicit intent.
  const onPause = () => {
    setPlaying(false);
    publishPositionState();
    void recordCheckpoint(id, 'pause', locatorNow());
  };

  const goChapter = useCallback(
    (delta: number) => {
      if (chapters.length === 0) return;
      // "Previous" within the first few seconds of a chapter goes to the
      // chapter before; otherwise it restarts the current one.
      let target = chapterIndex + delta;
      if (delta < 0 && currentChapter && bookMs - chapterStartMs > 4000) target = chapterIndex;
      target = Math.max(0, Math.min(chapters.length - 1, target));
      const c = chapters[target];
      if (c?.startMs != null) seekTo(c.startMs, 'progression');
    },
    [chapters, chapterIndex, currentChapter, bookMs, chapterStartMs, seekTo],
  );
  const goChapterRef = useRef(goChapter);
  goChapterRef.current = goChapter;

  /* -------------------------------------------------------- MediaSession */

  useEffect(() => {
    if (!('mediaSession' in navigator) || !detail) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentChapter?.title ?? detail.book.title,
      artist: detail.book.author ?? 'ReadPort',
      album: detail.book.title,
      artwork: detail.book.hasCover
        ? [{ src: `${location.origin}/api/books/${id}/cover`, sizes: '512x512' }]
        : [],
    });
  }, [detail, currentChapter, id]);

  useEffect(() => {
    if (!('mediaSession' in navigator) || !detail) return;
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* action unsupported on this platform */
      }
    };
    set('play', () => void audioRef.current?.play());
    set('pause', () => audioRef.current?.pause());
    set('seekbackward', (d) =>
      seekToRef.current(bookMsRef.current - (d.seekOffset ?? skip.back) * 1000, 'progression'),
    );
    set('seekforward', (d) =>
      seekToRef.current(bookMsRef.current + (d.seekOffset ?? skip.fwd) * 1000, 'progression'),
    );
    set('previoustrack', () => goChapterRef.current(-1));
    set('nexttrack', () => goChapterRef.current(1));
    set('seekto', (d) => {
      if (d.seekTime != null) {
        const start = tracks[trackIdx]?.startMsAbsolute ?? 0;
        seekToRef.current(start + d.seekTime * 1000, 'slider');
      }
    });
    return () => {
      for (const a of [
        'play',
        'pause',
        'seekbackward',
        'seekforward',
        'previoustrack',
        'nexttrack',
        'seekto',
      ] as MediaSessionAction[]) {
        set(a, null);
      }
    };
  }, [detail, skip.back, skip.fwd, tracks, trackIdx]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }, [playing]);

  useEffect(publishPositionState, [speed, trackIdx, publishPositionState]);

  // Keyboard controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet !== 'none') return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'j') {
        seekTo(bookMs - skip.back * 1000, 'progression');
      } else if (e.key === 'ArrowRight' || e.key === 'l') {
        seekTo(bookMs + skip.fwd * 1000, 'progression');
      } else if (e.key === 'Escape') {
        navigate(`/book/${id}`);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [togglePlay, seekTo, bookMs, sheet, navigate, id, skip]);

  const switchToText = useCallback(async () => {
    if (!detail?.book.pair) return;
    const from = locatorNow();
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
          toast.show(t('player.handoff.notStoredOffline'));
          return;
        }
        res = stored;
      }
      if (!res.to || res.to.medium !== 'ebook') {
        // Never silently cross an alignment gap: explain, and point at the
        // nearest verified aligned passage instead. The server's reason is
        // shown as it comes.
        const anchor = res.anchors?.before ?? res.anchors?.after;
        const reason = res.resolution.reason ?? t('player.handoff.noAlignedText');
        toast.show(
          anchor && anchor.to.medium === 'ebook'
            ? t('player.handoff.noAlignedNearest', { reason, pct: f.percent(anchor.to.pct) })
            : reason,
        );
        return;
      }
      audioRef.current?.pause();
      void recordCheckpoint(id, 'switch', from);
      const to = res.to as EbookLocator;
      navigate(
        `/read/${detail.book.pair.otherBookId}?spine=${to.spineIdx}&char=${to.charOffset ?? 0}${
          to.sentenceId ? `&sentence=${to.sentenceId}` : ''
        }&handoff=1&granularity=${res.resolution.granularity}`,
      );
    } catch {
      toast.show(t('player.handoff.switchFailed'));
    }
  }, [detail, locatorNow, id, navigate, toast, t, f]);

  const audioBookmarks = annotations.filter((a) => a.locator.medium === 'audio');
  const bookmarkAbsMs = (a: Annotation): number =>
    a.locator.medium === 'audio'
      ? (tracks[a.locator.trackIdx]?.startMsAbsolute ?? 0) + a.locator.positionMs
      : 0;
  /** A bookmark within 20 s of the playhead counts as "this moment". */
  const nearBookmark =
    audioBookmarks.find((a) => Math.abs(bookmarkAbsMs(a) - bookMs) < 20_000) ?? null;

  const deleteBookmark = async (annId: string) => {
    try {
      await api(`/api/annotations/${annId}`, { method: 'DELETE' });
      setAnnotations((a) => a.filter((x) => x.id !== annId));
    } catch (err) {
      toast.show(failureMessage(err, t('player.bookmarks.couldNotDelete'), t));
    }
  };

  const toggleBookmark = async () => {
    if (nearBookmark) {
      await deleteBookmark(nearBookmark.id);
      toast.show(t('player.bookmarks.removed'));
      return;
    }
    try {
      const chapterTitle = currentChapter?.title ?? null;
      const res = await api<{ annotation: Annotation }>(`/api/books/${id}/annotations`, {
        method: 'POST',
        body: {
          kind: 'bookmark',
          locator: locatorNow(),
          selectedText: chapterTitle ? `${chapterTitle} · ${formatDuration(bookMs)}` : null,
        },
      });
      setAnnotations((a) => [...a, res.annotation]);
      toast.show(t('player.bookmarks.addedAt', { time: formatDuration(bookMs) }), {
        label: t('player.bookmarks.title'),
        onClick: () => setSheet('bookmarks'),
      });
    } catch (err) {
      toast.show(failureMessage(err, t('player.bookmarks.couldNotSave'), t));
    }
  };

  /* -------------------------------------------------------------- render */

  if (error) {
    return (
      <div className="player-page">
        <div className="empty-state" style={{ margin: 'auto' }}>
          <h2>{t('player.error.title')}</h2>
          <p>{t(error)}</p>
          <Link className="btn btn--secondary" to={`/book/${id}`}>
            {t('player.backToDetails')}
          </Link>
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="player-page" aria-busy="true">
        <div
          style={{ margin: 'auto' }}
          className="spinner"
          role="status"
          aria-label={t('common.loading')}
        />
      </div>
    );
  }
  if (!support.supported) {
    return (
      <div className="player-page">
        <div className="empty-state" style={{ margin: 'auto' }}>
          <h2>{t('player.error.formatTitle')}</h2>
          {support.reason && <p>{t(support.reason, { format: support.format })}</p>}
          <Link className="btn btn--secondary" to={`/book/${id}`}>
            {t('player.backToDetails')}
          </Link>
        </div>
      </div>
    );
  }

  const remainingMs = Math.max(0, totalMs - bookMs);

  /** End of a drag: move the audio once, to where the finger left the thumb. */
  const commitScrub = () => {
    scrubbing.current = false;
    if (dragMs === null) return;
    setPositionMs(dragMs - (tracks[trackIdx]?.startMsAbsolute ?? 0));
    seekTo(dragMs, 'slider');
    setDragMs(null);
  };
  const chapterLeftMs = Math.max(0, chapterEndMs - bookMs);
  void sleepTick;
  const sleepLabel = sleepChapterEnd
    ? t('player.sleep.chipChapterEnd')
    : sleepUntil
      ? formatDuration(Math.max(0, sleepUntil - Date.now()))
      : null;
  const pair =
    detail.book.pair && detail.book.pair.status !== 'candidate' ? detail.book.pair : null;

  return (
    <div
      className="player-page"
      style={ambient ? ({ '--pl-ambient': ambient } as React.CSSProperties) : undefined}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={onPlay}
        onPause={onPause}
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onRateChange={publishPositionState}
        onError={() => setError('player.error.formatUnplayable')}
      />
      <div className="player-top">
        <button
          className="icon-btn"
          onClick={() => navigate(`/book/${id}`)}
          aria-label={t('player.backToBook')}
        >
          <IconBack />
        </button>
        <span className="player-top__label">
          {chapters.length > 0 && chapterIndex >= 0 ? (
            t('player.top.chapterOf', { n: chapterIndex + 1, total: chapters.length })
          ) : tracks.length > 1 ? (
            t('player.top.partOf', { n: trackIdx + 1, total: tracks.length })
          ) : (
            <bdi>{detail.book.format.toUpperCase()}</bdi>
          )}
        </span>
        {(detail.translations?.length ?? 0) > 0 && (
          <button
            className="icon-btn"
            onClick={() => setSheet('languages')}
            aria-label={t('translations.continue.title')}
            title={t('translations.continue.title')}
          >
            <IconLanguages />
          </button>
        )}
        {/* Same split control as the reader: the ribbon marks this moment, and
            the caret beside it opens the list - shown only once there is a
            list to open. */}
        <div className="bm-split">
          <button
            className={`icon-btn ${nearBookmark ? 'is-marked' : ''}`}
            onClick={() => void toggleBookmark()}
            aria-pressed={!!nearBookmark}
            aria-label={
              nearBookmark ? t('player.bookmarks.removeHere') : t('player.bookmarks.markHere')
            }
          >
            <IconBookmark filled={!!nearBookmark} />
          </button>
          {audioBookmarks.length > 0 && (
            <button
              className="icon-btn bm-split__more"
              onClick={() => setSheet('bookmarks')}
              aria-haspopup="dialog"
              aria-label={t('player.bookmarks.countLabel', { n: audioBookmarks.length })}
            >
              <IconChevronDown size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="player-main">
        <div className={`player-coverwrap ${playing ? 'is-playing' : ''}`}>
          <Cover
            book={detail.book}
            className={detail.book.hasCover ? 'player-cover' : 'player-cover player-cover--book'}
          />
        </div>
        <div className="player-titles">
          <h1>{detail.book.title}</h1>
          <div className="player-titles__author">{detail.book.author ?? ''}</div>
          <div className="chapter">
            {buffering
              ? currentChapter
                ? t('player.chapterBuffering', { title: currentChapter.title })
                : t('player.buffering')
              : (currentChapter?.title ?? '')}
          </div>
        </div>

        <div className="player-scrub">
          <div className="player-scrub__track" aria-hidden="true">
            {chapters.length > 1 &&
              totalMs > 0 &&
              chapters.map((c) =>
                c.startMs != null && c.startMs > 0 ? (
                  <span
                    key={c.idx}
                    className="player-scrub__tick"
                    style={{ insetInlineStart: `${(c.startMs / totalMs) * 100}%` }}
                  />
                ) : null,
              )}
            {totalMs > 0 && audioBookmarks.length > 0 && (
              <span className="player-scrub__bookmarks">
                {audioBookmarks.map((a) => (
                  <span
                    key={a.id}
                    className={`player-scrub__bookmark ${nearBookmark?.id === a.id ? 'is-near' : ''}`}
                    style={{ insetInlineStart: `${(bookmarkAbsMs(a) / totalMs) * 100}%` }}
                  />
                ))}
              </span>
            )}
            {handoffMarkerPct != null && (
              <span
                className="handoff-marker"
                style={{ insetInlineStart: `${handoffMarkerPct * 100}%` }}
                title={t('player.handoff.marker')}
              />
            )}
            <FriendMarkers
              friends={friendsHere.friends}
              shownIds={friendsHere.shownIds}
              on="player"
              onPick={() => friendsHere.setCardOpen(true)}
            />
          </div>
          <input
            className="slider slider--player"
            type="range"
            min={0}
            max={Math.max(1, totalMs)}
            step={1000}
            value={Math.round(dragMs ?? bookMs)}
            aria-label={t('player.transport.position')}
            aria-valuetext={t('player.transport.positionOf', {
              position: formatDuration(dragMs ?? bookMs),
              total: formatDuration(totalMs),
            })}
            onPointerDown={() => (scrubbing.current = true)}
            onPointerUp={commitScrub}
            onPointerCancel={commitScrub}
            onLostPointerCapture={commitScrub}
            onChange={(e) => {
              const v = Number(e.target.value);
              // Mid-drag: move the thumb only. A keyboard user gets no
              // pointer events, so for them this IS the commit.
              if (scrubbing.current) setDragMs(v);
              else {
                setPositionMs(v - (tracks[trackIdx]?.startMsAbsolute ?? 0));
                seekTo(v, 'slider');
              }
            }}
          />
          <div className="player-times">
            <span>{formatDuration(bookMs)}</span>
            <span className="player-times__chapter">
              {currentChapter
                ? t('player.transport.leftInChapter', { time: formatDuration(chapterLeftMs) })
                : ''}
            </span>
            <span className="player-times__end">
              <FriendsButton
                bookId={id}
                myPct={totalMs > 0 ? bookMs / totalMs : 0}
                friends={friendsHere.friends}
                shownIds={friendsHere.shownIds}
                setShown={friendsHere.setShown}
                open={friendsHere.cardOpen}
                setOpen={friendsHere.setCardOpen}
              />
              <span dir="ltr">-{formatDuration(remainingMs)}</span>
            </span>
          </div>
          {currentChapter && (
            <div className="player-chapterbar" aria-hidden="true">
              <span style={{ width: `${chapterPct * 100}%` }} />
            </div>
          )}
        </div>

        <div className="player-controls">
          <button
            className="icon-btn icon-btn--small"
            onClick={() => goChapter(-1)}
            aria-label={t('player.transport.previousChapter')}
            disabled={chapters.length === 0}
          >
            <IconChapterPrev size={26} />
          </button>
          <button
            className="icon-btn"
            onClick={() => seekTo(bookMs - skip.back * 1000, 'progression')}
            aria-label={t('player.transport.backSeconds', { n: skip.back })}
          >
            <IconSkipBack size={36} label={String(skip.back)} />
          </button>
          <button
            className="play-btn"
            onClick={togglePlay}
            aria-label={playing ? t('player.transport.pause') : t('player.transport.play')}
          >
            {playing ? <IconPause size={38} /> : <IconPlay size={40} />}
          </button>
          <button
            className="icon-btn"
            onClick={() => seekTo(bookMs + skip.fwd * 1000, 'progression')}
            aria-label={t('player.transport.forwardSeconds', { n: skip.fwd })}
          >
            <IconSkipFwd size={36} label={String(skip.fwd)} />
          </button>
          <button
            className="icon-btn icon-btn--small"
            onClick={() => goChapter(1)}
            aria-label={t('player.transport.nextChapter')}
            disabled={chapters.length === 0}
          >
            <IconChapterNext size={26} />
          </button>
        </div>

        <div className="player-secondary">
          <button
            className="chip"
            onClick={() => setSheet('playback')}
            aria-label={t('player.speed.label')}
          >
            <IconSpeed size={15} /> {t('player.speed.rate', { rate: speed })}
          </button>
          <button
            className="chip"
            onClick={() => setSheet('sleep')}
            aria-pressed={sleepLabel != null}
          >
            <IconMoon size={15} /> {sleepLabel ?? t('player.sleep.chip')}
          </button>
          {chapters.length > 0 && (
            <button className="chip" onClick={() => setSheet('chapters')}>
              <IconToc size={15} /> {t('player.chapters.title')}
            </button>
          )}
          <button
            className="chip"
            onClick={() => setSheet('bookmarks')}
            aria-label={t('player.bookmarks.countLabel', { n: audioBookmarks.length })}
          >
            <IconBookmark size={15} />{' '}
            {audioBookmarks.length ? f.number(audioBookmarks.length) : ''}
          </button>
        </div>

        {pair && (
          <button
            className="tandem-pill"
            onClick={() => void switchToText()}
            disabled={!pair.switchable}
            title={
              pair.switchable ? t('player.tandem.openEbookTitle') : t('player.tandem.notReadyTitle')
            }
          >
            <IconBookOpen size={18} />
            <span>
              {pair.switchable ? t('player.tandem.readFromHere') : t('player.tandem.aligning')}
              <small>
                {pair.switchable
                  ? t('player.tandem.readFromHereHint')
                  : t('player.tandem.aligningHint')}
              </small>
            </span>
          </button>
        )}
      </div>

      {sheet === 'languages' && (
        <LanguagesSheet
          bookId={id}
          language={detail.book.language}
          titles={detail.translations ?? []}
          here={locatorNow}
          onClose={() => setSheet('none')}
        />
      )}
      {sheet === 'chapters' && (
        <Sheet title={t('player.chapters.title')} onClose={() => setSheet('none')}>
          {chapters.map((c, i) => (
            <button
              key={c.idx}
              className="list-row"
              aria-current={i === chapterIndex ? 'true' : undefined}
              onClick={() => {
                setSheet('none');
                if (c.startMs != null) seekTo(c.startMs, 'toc');
              }}
            >
              <span className="soft" style={{ width: 24, textAlign: 'end' }}>
                {f.number(i + 1)}
              </span>
              <span className="grow">{c.title}</span>
              <span className="soft">
                {c.startMs != null && c.endMs != null
                  ? formatDuration(c.endMs - c.startMs)
                  : c.startMs != null
                    ? formatDuration(c.startMs)
                    : ''}
              </span>
            </button>
          ))}
        </Sheet>
      )}
      {sheet === 'playback' && (
        <Sheet title={t('player.speed.sheetTitle')} onClose={() => setSheet('none')}>
          <div className="rs-group">
            <div className="rs-label">{t('player.speed.current', { rate: speed })}</div>
            <input
              className="slider"
              style={{ color: 'var(--rp-interactive)' }}
              type="range"
              min={0.5}
              max={3}
              step={0.05}
              value={speed}
              aria-label={t('player.speed.label')}
              onChange={(e) => setSpeed(Number(e.target.value))}
            />
            <div className="chip-row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  className="chip"
                  aria-pressed={Math.abs(speed - s) < 0.001}
                  onClick={() => setSpeed(s)}
                >
                  {t('player.speed.rate', { rate: s })}
                </button>
              ))}
            </div>
            <p style={{ fontSize: 13, color: 'var(--rp-text-soft)', margin: '8px 0 0' }}>
              {t('player.speed.note')}
            </p>
          </div>
          <div className="rs-group">
            <div className="rs-label">{t('player.skip.back')}</div>
            <div className="segmented" role="group" aria-label={t('player.skip.backSeconds')}>
              {SKIP_CHOICES.map((s) => (
                <button
                  key={s}
                  aria-pressed={skip.back === s}
                  onClick={() => setSkip({ ...skip, back: s })}
                >
                  {t('player.skip.seconds', { n: s })}
                </button>
              ))}
            </div>
            <div className="rs-label" style={{ marginTop: 12 }}>
              {t('player.skip.forward')}
            </div>
            <div className="segmented" role="group" aria-label={t('player.skip.forwardSeconds')}>
              {SKIP_CHOICES.map((s) => (
                <button
                  key={s}
                  aria-pressed={skip.fwd === s}
                  onClick={() => setSkip({ ...skip, fwd: s })}
                >
                  {t('player.skip.seconds', { n: s })}
                </button>
              ))}
            </div>
          </div>
        </Sheet>
      )}
      {sheet === 'sleep' && (
        <Sheet title={t('player.sleep.title')} onClose={() => setSheet('none')}>
          <div className="chip-row" style={{ flexWrap: 'wrap' }}>
            {SLEEP_OPTIONS.filter((o) => o.minutes !== -1 || chapters.length > 0).map((o) => (
              <button
                key={o.minutes}
                className="chip"
                aria-pressed={
                  o.minutes === 0
                    ? sleepUntil === null && !sleepChapterEnd
                    : o.minutes === -1
                      ? sleepChapterEnd
                      : false
                }
                onClick={() => {
                  if (o.minutes === 0) {
                    setSleepUntil(null);
                    setSleepChapterEnd(false);
                  } else if (o.minutes === -1) {
                    setSleepChapterEnd(true);
                    setSleepUntil(null);
                  } else {
                    setSleepUntil(Date.now() + o.minutes * 60_000);
                    setSleepChapterEnd(false);
                  }
                  setSheet('none');
                }}
              >
                {t(o.key, { n: o.n })}
              </button>
            ))}
          </div>
          {sleepUntil && (
            <button
              className="btn btn--secondary"
              style={{ marginTop: 12 }}
              onClick={() => setSleepUntil((s) => (s ?? Date.now()) + 15 * 60_000)}
            >
              {t('player.sleep.addMinutes', { n: 15 })}
            </button>
          )}
        </Sheet>
      )}
      {returnPoint && (
        <div className="return-pill">
          <button
            className="return-pill__go"
            onClick={() => {
              const rp = returnPoint;
              setReturnPoint(null);
              seekTo(rp.originMs, 'return');
            }}
          >
            <IconBack size={15} />{' '}
            {t('player.return.backTo', { time: formatDuration(returnPoint.originMs) })}
          </button>
          <button
            className="return-pill__x"
            aria-label={t('common.dismiss')}
            onClick={(e) => {
              e.stopPropagation();
              setReturnPoint(null);
            }}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}
      {sheet === 'bookmarks' && (
        <Sheet title={t('player.bookmarks.title')} onClose={() => setSheet('none')}>
          {audioBookmarks.length === 0 && (
            <p style={{ color: 'var(--rp-text-soft)', margin: 0 }}>{t('player.bookmarks.empty')}</p>
          )}
          {[...audioBookmarks]
            .sort((a, b) => bookmarkAbsMs(a) - bookmarkAbsMs(b))
            .map((a) => (
              <div
                key={a.id}
                className="bm-row"
                role="button"
                tabIndex={0}
                onClick={() => {
                  setSheet('none');
                  seekTo(bookmarkAbsMs(a), 'bookmark');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    setSheet('none');
                    seekTo(bookmarkAbsMs(a), 'bookmark');
                  }
                }}
              >
                <span className="bm-row__icon">
                  <IconBookmark size={16} filled />
                </span>
                <span className="bm-row__body">
                  <span className="bm-row__where">
                    {nearBookmark?.id === a.id
                      ? t('player.bookmarks.atHere', { time: formatDuration(bookmarkAbsMs(a)) })
                      : formatDuration(bookmarkAbsMs(a))}
                  </span>
                  <span className="bm-row__text">
                    {a.note ?? a.selectedText ?? t('player.bookmarks.untitled')}
                  </span>
                </span>
                <button
                  className="icon-btn bm-row__delete"
                  aria-label={t('player.bookmarks.delete')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteBookmark(a.id);
                  }}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            ))}
        </Sheet>
      )}
    </div>
  );
}
