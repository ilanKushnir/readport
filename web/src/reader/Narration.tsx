import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type TrackInfo } from '@readport/shared';
import { api } from '../api/client';
import { type SentenceIndexEntry } from '../lib/types';
import { recordCheckpoint, resumeLocator } from '../progress/engine';
import { loadPlayback, setBookSpeed, speedFor } from '../player/prefs';
import { formatDuration } from '../lib/format';
import {
  IconClose,
  IconPause,
  IconPlay,
  IconSkipBack,
  IconSpeed,
  IconTarget,
  IconAutoScroll,
} from '../components/icons';
import {
  type AlignedSegment,
  type Cue,
  type FollowState,
  buildCues,
  cueAt,
  cueForOffset,
  leadInFor,
  locateInTracks,
} from './readalong';

/**
 * Read-along: the narration playing while the book stays on screen.
 *
 * This is deliberately not the player. The player is a place you go; read-along
 * is something the reader does, so it owns the smallest transport that can
 * honestly be called one - play, back, speed, stop - and nothing else. Sleep
 * timers, chapter lists and bookmarks already have a home one tap away.
 *
 * The audio element lives here rather than in the reader so that turning
 * read-along off unmounts it, which is the only way to be sure a book stops
 * talking.
 */

const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export interface NarrationApi {
  /** True once the audiobook and this chapter's timings have loaded. */
  ready: boolean;
  /** Nothing in this chapter is timed - read-along has nothing to show. */
  emptyChapter: boolean;
  /** The timings request failed, as opposed to this chapter having none. */
  timingsFailed: boolean;
  /** Walk forward to the next chapter, used to leave an untimed stretch. */
  skipUntimed: () => void;
  playing: boolean;
  /** The sentence being spoken, when there is one to point at. */
  cue: Cue | null;
  /** This chapter's timed sentences - what the pace marker interpolates over. */
  cues: Cue[];
  /** Increments on every deliberate seek; the page follows again when it does. */
  seekNonce: number;
  state: FollowState;
  bookMs: number;
  /** Synchronous lifecycle capture, including time since the last timeupdate. */
  currentBookMs: () => number;
  speed: number;
  error: string | null;
  toggle: () => void;
  setSpeed: (rate: number) => void;
  back: () => void;
  /** Start (or move) the narration at the sentence covering a char offset. */
  playFrom: (charOffset: number) => void;
  /** How far the back button goes, in seconds - the player's own setting. */
  backSeconds: number;
  /** The <audio> element to mount. */
  element: React.ReactNode;
}

export interface NarrationOptions {
  enabled: boolean;
  /** Whether the page is still following the voice; see readalong.shouldFollow. */
  following: boolean;
  pairId: string | null;
  audioBookId: string | null;
  spineIdx: number;
  sentences: SentenceIndexEntry[];
  /** Where the reader is now, used to place the needle when it starts. */
  startOffset: () => number;
  /** The narration has left this chapter; the reader should move. */
  onLeaveChapter: (direction: 'next' | 'prev') => void;
}

/**
 * The read-along engine.
 *
 * Positions are book-absolute milliseconds throughout - the unit the alignment
 * speaks - and turned into a file and an offset only at the moment the audio
 * element is told where to go.
 */
export function useNarration(opts: NarrationOptions): NarrationApi {
  const {
    enabled,
    following,
    pairId,
    audioBookId,
    spineIdx,
    sentences,
    startOffset,
    onLeaveChapter,
  } = opts;

  const audioRef = useRef<HTMLAudioElement>(null);
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [segments, setSegments] = useState<AlignedSegment[] | null>(null);
  const [trackIdx, setTrackIdx] = useState(0);
  const [bookMs, setBookMs] = useState(0);
  /**
   * Bumped on every deliberate seek - the back button, tapping a sentence.
   *
   * Moving the playhead by hand means "take me with you", so the page starts
   * following again even if the reader had wandered off earlier.
   */
  const [seekNonce, setSeekNonce] = useState(0);
  /**
   * The direction the last automatic chapter move went.
   *
   * Without it the walk ping-pongs: stepping forward into a chapter whose
   * timings all sit earlier than the playhead reads as 'before', which steps
   * straight back, which reads as 'after', for as long as the audio plays.
   * A walk may continue in its own direction across any number of untimed
   * chapters, but it may not immediately reverse.
   */
  const lastWalkRef = useRef<'next' | 'prev' | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(() => speedFor(loadPlayback(), audioBookId ?? ''));
  const [error, setError] = useState<string | null>(null);
  /** The timings request failed, as opposed to returning none. */
  const [segmentsFailed, setSegmentsFailed] = useState(false);
  const [backSeconds] = useState(() => loadPlayback().skipBack);

  /** Applied once the target track reports a duration. */
  const pendingSeekRef = useRef<{ trackIdx: number; positionMs: number; play: boolean } | null>(
    null,
  );
  const lastHeartbeatRef = useRef(0);
  const startedRef = useRef(false);

  const totalMs = useMemo(() => tracks.reduce((a, t) => a + t.durationMs, 0), [tracks]);
  const cues = useMemo(() => buildCues(sentences, segments ?? []), [sentences, segments]);
  const lookup = useMemo(() => cueAt(cues, bookMs), [cues, bookMs]);

  /**
   * Adopt the rate this book was last played at, once its id is known.
   *
   * The initial state runs before `audioBookId` arrives, so it could only ever
   * read the global default - a reader who set 1.25x for a slow narrator in
   * the player got 1x every time they read along with the same book. Guarded
   * so it cannot overwrite a rate chosen in this session.
   */
  const userPickedRateRef = useRef(false);
  useEffect(() => {
    if (!audioBookId || userPickedRateRef.current) return;
    setSpeedState(speedFor(loadPlayback(), audioBookId));
  }, [audioBookId]);

  /* ------------------------------------------------------------- loading */

  // The audiobook's own tracks. Read-along needs the file boundaries to turn
  // a book-absolute alignment position into something an element can seek to.
  useEffect(() => {
    if (!enabled || !audioBookId) return;
    let alive = true;
    void Promise.all([
      api<{ tracks: TrackInfo[] }>(`/api/books/${audioBookId}`),
      resumeLocator(audioBookId),
    ])
      .then(([d]) => {
        if (!alive) return;
        setTracks(d.tracks ?? []);
        setError(null);
      })
      .catch(() => {
        if (alive) setError('The audiobook could not be loaded.');
      });
    return () => {
      alive = false;
    };
  }, [enabled, audioBookId]);

  // This chapter's timings. Refetched per chapter: a whole book's segments is
  // megabytes, and the reader only ever needs the page in front of them.
  useEffect(() => {
    if (!enabled || !pairId || spineIdx < 0) return;
    let alive = true;
    setSegments(null);
    setSegmentsFailed(false);
    void api<{ segments: AlignedSegment[] }>(`/api/pairs/${pairId}/segments/${spineIdx}`)
      .then((d) => {
        if (!alive) return;
        setSegments(d.segments ?? []);
        setError(null);
      })
      .catch(() => {
        if (!alive) return;
        // A chapter with no stored alignment is a normal answer - front and
        // end matter are often unnarrated - but a request that never arrived
        // is not, and telling the reader "nothing is timed here" when the
        // truth is "we could not ask" sends them looking for the wrong fault.
        setSegments([]);
        setSegmentsFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [enabled, pairId, spineIdx]);

  /* ------------------------------------------------------------- seeking */

  const applyPendingSeek = useCallback(() => {
    const el = audioRef.current;
    const target = pendingSeekRef.current;
    if (!el || !target || target.trackIdx !== trackIdx || el.readyState < 1) return;
    pendingSeekRef.current = null;
    el.currentTime = target.positionMs / 1000;
    if (target.play) void el.play().catch(() => {});
  }, [trackIdx]);

  const seekTo = useCallback(
    (absMs: number, play: boolean) => {
      const where = locateInTracks(tracks, absMs);
      pendingSeekRef.current = { ...where, play };
      setBookMs(absMs);
      // An explicit seek is not a continuation of a walk.
      //
      // The walker refuses to reverse, which stops it ping-ponging between
      // two chapters. But a rewind that lands before this chapter's first cue
      // makes it step BACK - and if the previous chapter's timings all sit
      // earlier than the playhead, the way forward now counts as a reversal
      // and is refused. The reader is stranded in a chapter the voice is not
      // in, with no cue and nothing to point at. Clearing the direction lets
      // the walk find its way again.
      lastWalkRef.current = null;
      // Tell the page a person moved the playhead, so it can come along.
      setSeekNonce((n) => n + 1);
      if (where.trackIdx !== trackIdx) {
        setTrackIdx(where.trackIdx);
        return; // the src change will load, then applyPendingSeek runs
      }
      const el = audioRef.current;
      if (el && el.readyState >= 1) applyPendingSeek();
    },
    [tracks, trackIdx, applyPendingSeek],
  );

  /**
   * Where the narration is, as the audiobook's own locator.
   *
   * Read-along advances the audiobook as surely as the player does, so it
   * writes the audiobook's progress too - otherwise an hour of reading along
   * leaves the player still at the start. `pct` is real rather than zero
   * because the library's Continue rail and the finished check both read it.
   */
  const audioLocatorAt = useCallback(
    (absMs: number) => ({
      medium: 'audio' as const,
      trackIdx: locateInTracks(tracks, absMs).trackIdx,
      positionMs: locateInTracks(tracks, absMs).positionMs,
      bookMs: absMs,
      pct: totalMs > 0 ? Math.max(0, Math.min(1, absMs / totalMs)) : 0,
    }),
    [tracks, totalMs],
  );

  /* ------------------------------------------------ starting and stopping */

  // On switch-on, put the needle where the reader is looking. Only once: after
  // that the reader may have moved the page and the narration should not jump.
  useEffect(() => {
    if (!enabled) {
      startedRef.current = false;
      return;
    }
    if (startedRef.current || cues.length === 0 || tracks.length === 0) return;
    startedRef.current = true;
    const cue = cueForOffset(cues, startOffset());
    if (!cue) return;
    const lead = leadInFor(segments?.find((s) => s.sentenceId === cue.id)?.uncertaintyMs);
    const at = Math.max(0, cue.startMs - lead);
    // An explicit intent, not a heartbeat: it moves the progress claim to this
    // session, without which every heartbeat below is discarded as coming from
    // a session that lost the claim to another device.
    if (audioBookId) void recordCheckpoint(audioBookId, 'seek', audioLocatorAt(at));
    seekTo(at, true);
  }, [enabled, cues, tracks, segments, startOffset, seekTo, audioBookId, audioLocatorAt]);

  // Stopping means stopping. An element left playing behind a closed bar is
  // the kind of bug people report as "my phone won't shut up".
  useEffect(() => {
    if (enabled) return;
    const el = audioRef.current;
    el?.pause();
    setPlaying(false);
  }, [enabled]);

  /* ------------------------------------------------- crossing the chapter */

  const leaveRef = useRef(onLeaveChapter);
  leaveRef.current = onLeaveChapter;
  /**
   * The direction the last automatic chapter move went.
   *
   * Without it the walk ping-pongs: stepping forward into a chapter whose
   * timings all sit earlier than the playhead reads as 'before', which steps
   * straight back, which reads as 'after', for as long as the audio plays.
   * A walk may continue in its own direction across any number of untimed
   * chapters, but it may not immediately reverse.
   */
  useEffect(() => {
    if (!enabled || !playing || !following || segments === null) return;
    // A chapter with no timings at all - front matter, or one the aligner
    // skipped - would otherwise dead-end the whole feature: the voice plays
    // on, the page never moves, and nothing says why. Walking forward is both
    // the honest guess and self-terminating at the last chapter.
    if (cues.length === 0) {
      if (lastWalkRef.current !== 'prev') {
        lastWalkRef.current = 'next';
        leaveRef.current('next');
      }
      return;
    }
    // Landed somewhere the narration actually is: the walk is over.
    if (lookup.state === 'on' || lookup.state === 'hold') {
      lastWalkRef.current = null;
      return;
    }
    // Only while the narration still has the wheel. A reader who has gone off
    // to a different chapter must not be dragged back to this one.
    const dir = lookup.state === 'after' ? 'next' : lookup.state === 'before' ? 'prev' : null;
    if (!dir) return;
    const reverses =
      (dir === 'next' && lastWalkRef.current === 'prev') ||
      (dir === 'prev' && lastWalkRef.current === 'next');
    if (reverses) return;
    lastWalkRef.current = dir;
    leaveRef.current(dir);
  }, [enabled, playing, following, lookup.state, segments, cues.length]);

  /* --------------------------------------------------------- audio events */

  const onTimeUpdate = () => {
    const el = audioRef.current;
    if (!el) return;
    const abs = (tracks[trackIdx]?.startMsAbsolute ?? 0) + el.currentTime * 1000;
    setBookMs(abs);
    const now = Date.now();
    if (playing && audioBookId && now - lastHeartbeatRef.current > 15_000) {
      lastHeartbeatRef.current = now;
      // The audiobook's own position, so opening the player later resumes
      // where the reading got to rather than where listening last stopped.
      void recordCheckpoint(audioBookId, 'heartbeat', audioLocatorAt(abs));
    }
  };

  const onEnded = () => {
    if (trackIdx + 1 < tracks.length) {
      pendingSeekRef.current = { trackIdx: trackIdx + 1, positionMs: 0, play: true };
      setTrackIdx(trackIdx + 1);
    } else {
      setPlaying(false);
    }
  };

  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = speed;
  }, [speed, trackIdx]);

  /* -------------------------------------------------------- Media Session */

  useEffect(() => {
    if (!enabled || !('mediaSession' in navigator)) return;
    const el = audioRef.current;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    const handlers: [MediaSessionAction, () => void][] = [
      ['play', () => void el?.play().catch(() => {})],
      ['pause', () => el?.pause()],
      ['seekbackward', () => seekTo(Math.max(0, bookMs - backSeconds * 1000), playing)],
      ['seekforward', () => seekTo(bookMs + 30_000, playing)],
    ];
    for (const [action, fn] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {
        /* not every action is supported everywhere */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
  }, [enabled, playing, bookMs, seekTo, backSeconds]);

  /* ------------------------------------------------------------- controls */

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setError('This audio could not be played.'));
    else el.pause();
  }, []);

  const setSpeed = useCallback(
    (rate: number) => {
      userPickedRateRef.current = true;
      setSpeedState(rate);
      // The same store the player writes, so a rate set while reading along is
      // the rate the player opens at - and reaches the reader's other devices.
      if (audioBookId) setBookSpeed(audioBookId, rate);
    },
    [audioBookId],
  );

  const back = useCallback(
    () => seekTo(Math.max(0, bookMs - backSeconds * 1000), playing),
    [seekTo, bookMs, playing, backSeconds],
  );

  const playFrom = useCallback(
    (charOffset: number) => {
      const cue = cueForOffset(cues, charOffset);
      if (!cue) return;
      const lead = leadInFor(segments?.find((s) => s.sentenceId === cue.id)?.uncertaintyMs);
      const at = Math.max(0, cue.startMs - lead);
      if (audioBookId) void recordCheckpoint(audioBookId, 'seek', audioLocatorAt(at));
      seekTo(at, true);
    },
    [cues, segments, seekTo, audioBookId, audioLocatorAt],
  );

  const src =
    enabled && audioBookId && tracks.length > 0
      ? `/api/books/${audioBookId}/track/${trackIdx}`
      : undefined;

  const element = src ? (
    <audio
      ref={audioRef}
      src={src}
      preload="metadata"
      onLoadedMetadata={applyPendingSeek}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onTimeUpdate={onTimeUpdate}
      onEnded={onEnded}
      onError={() => setError('This audio format could not be played by your browser.')}
    />
  ) : null;

  return {
    ready: tracks.length > 0 && segments !== null,
    emptyChapter: segments !== null && cues.length === 0,
    timingsFailed: segmentsFailed,
    skipUntimed: () => {
      lastWalkRef.current = 'next';
      leaveRef.current('next');
    },
    playing,
    cue: lookup.cue,
    cues,
    seekNonce,
    state: lookup.state,
    bookMs,
    speed,
    currentBookMs: () =>
      audioRef.current
        ? (tracks[trackIdx]?.startMsAbsolute ?? 0) + audioRef.current.currentTime * 1000
        : bookMs,
    error,
    backSeconds,
    toggle,
    setSpeed,
    back,
    playFrom,
    element,
  };
}

/**
 * The read-along bar: a strip along the bottom of the reader.
 *
 * It says what is happening in words as well as controls, because the states
 * that matter most are the ones where the highlight is *absent* - an unaligned
 * stretch, or a chapter the narrator skipped - and a bar that only ever shows
 * a play button leaves the reader wondering what broke.
 */
export function NarrationBar({
  n,
  following,
  onResume,
  onClose,
  autoScroll,
  onAutoScroll,
}: {
  n: NarrationApi;
  following: boolean;
  onResume: () => void;
  onClose: () => void;
  /** Null when the page turns itself - auto-scroll is a scrolling idea. */
  autoScroll: boolean | null;
  onAutoScroll: (on: boolean) => void;
}) {
  const [speedOpen, setSpeedOpen] = useState(false);

  /**
   * A menu that only closes by pressing the same button again is a menu you
   * are stuck in - especially on a phone, where the instinct is to tap away
   * from it. Escape closes it too, and does not reach the reader behind.
   */
  useEffect(() => {
    if (!speedOpen) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest('.readalong__speed')) setSpeedOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setSpeedOpen(false);
    };
    document.addEventListener('pointerdown', away);
    // Capture, so this runs before the reader's own Escape handler.
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key, true);
    };
  }, [speedOpen]);

  const status = n.error
    ? n.error
    : !n.ready
      ? 'Finding the narration…'
      : n.timingsFailed
        ? 'Could not load this chapter’s timings'
        : n.emptyChapter
          ? 'Nothing timed in this chapter'
          : n.state === 'gap'
            ? 'No timed text here'
            : formatDuration(n.bookMs);

  return (
    <div className="readalong" role="group" aria-label="Read along">
      <button
        className="readalong__play"
        onClick={n.toggle}
        disabled={!n.ready || (n.emptyChapter && !n.playing)}
        aria-label={n.playing ? 'Pause narration' : 'Play narration'}
      >
        {n.playing ? <IconPause size={20} /> : <IconPlay size={20} />}
      </button>

      {/* Front matter and unnarrated chapters are ordinary, and a disabled
          play button with no way on is a dead end. This is the way on. */}
      {n.emptyChapter && !n.playing && !n.timingsFailed && (
        <button className="readalong__resume" onClick={n.skipUntimed}>
          <IconTarget size={15} />
          <span>Find the narration</span>
        </button>
      )}

      <button
        className="readalong__btn"
        onClick={n.back}
        disabled={!n.ready}
        aria-label={`Back ${n.backSeconds} seconds`}
        title={`Back ${n.backSeconds} seconds`}
      >
        <IconSkipBack size={18} label={String(n.backSeconds)} />
      </button>

      <span className={`readalong__status ${n.state === 'gap' || n.error ? 'is-warn' : ''}`}>
        {status}
      </span>

      {/* Shown whenever the page has stopped following, cue or no cue: the
          moment the reader is MOST lost is when the voice has wandered into a
          chapter they cannot see, which is exactly when there is no cue here
          and the way back used to disappear. */}
      {!following && (
        <button className="readalong__resume" onClick={onResume}>
          <IconTarget size={15} />
          <span>Back to the voice</span>
        </button>
      )}

      {/* Follow the voice down the page by itself. Offered only where it
          means something: in paginated mode the page already turns itself. */}
      {autoScroll !== null && (
        <button
          className="readalong__btn"
          aria-pressed={autoScroll}
          onClick={() => onAutoScroll(!autoScroll)}
          aria-label={autoScroll ? 'Stop scrolling with the voice' : 'Scroll with the voice'}
          title={autoScroll ? 'Stop scrolling with the voice' : 'Scroll with the voice'}
        >
          <IconAutoScroll size={18} />
        </button>
      )}

      <div className="readalong__speed">
        <button
          className="readalong__btn"
          onClick={() => setSpeedOpen((v) => !v)}
          aria-expanded={speedOpen}
          aria-label={`Speed ${n.speed}×`}
        >
          <IconSpeed size={18} />
          <small>{n.speed}×</small>
        </button>
        {speedOpen && (
          <div className="readalong__speeds" role="menu">
            {SPEEDS.map((s) => (
              <button
                key={s}
                role="menuitemradio"
                aria-checked={s === n.speed}
                className={s === n.speed ? 'is-on' : ''}
                onClick={() => {
                  n.setSpeed(s);
                  setSpeedOpen(false);
                }}
              >
                {s}×
              </button>
            ))}
          </div>
        )}
      </div>

      <button className="readalong__btn" onClick={onClose} aria-label="Stop reading along">
        <IconClose size={18} />
      </button>
    </div>
  );
}
