import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type TrackInfo } from '@readport/shared';
import { api } from '../api/client';
import { useT } from '../i18n';
import { type MessageKey } from '../i18n/messages/en';
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
  type BeyondText,
  type BeyondTextNow,
  type ChapterBound,
  type Cue,
  type FollowState,
  type SyncingNow,
  beyondTextAt,
  buildCues,
  chapterSyncing,
  cueArriving,
  cueForOffset,
  hasArrived,
  locateInTracks,
  nearestChapter,
  sentenceStep,
  syncEta,
  voiceAheadOfSync,
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

/**
 * How often a book still syncing is asked how far it has got: often while
 * the reader is waiting on it, now and then while the voice is well inside
 * what is synced already.
 */
const SYNC_POLL_WAITING_MS = 4_000;
const SYNC_POLL_MS = 20_000;

/**
 * Read along is waiting on a sync still under way (readalong.SyncingNow):
 * the book has none of it yet, or this part of it is not synced yet.
 */
export interface SyncWait {
  /** Nothing synced yet; `pending`: not this far yet; `stopped`: the sync stopped short of here. */
  kind: 'preparing' | 'pending' | 'stopped';
  /** Roughly how long until it is, when the sync's pace is known. */
  etaMs: number | null;
}

export interface NarrationApi {
  /** True once the audiobook and this chapter's timings have loaded. */
  ready: boolean;
  /** Nothing in this chapter is timed - read-along has nothing to show. */
  emptyChapter: boolean;
  /** The timings request failed, as opposed to this chapter having none. */
  timingsFailed: boolean;
  /**
   * Read along is waiting on a sync still under way - the book was paired a
   * moment ago, or the voice has run ahead of what is synced. Null when
   * nothing is waiting, including when the book is fully synced.
   */
  syncWait: SyncWait | null;
  /** Walk forward to the next chapter, used to leave an untimed stretch. */
  skipUntimed: () => void;
  playing: boolean;
  /** The sentence being spoken, when there is one to point at. */
  cue: Cue | null;
  /** This chapter's timed sentences - what the pace marker interpolates over. */
  cues: Cue[];
  /** The sentence the voice was just sent to, until the clock is in it (readalong.cueArriving). */
  arriving: Cue | null;
  /**
   * The voice is reading a stretch the ebook does not have - where it is in
   * it, and where the text picks up. Null the rest of the time, including
   * while the book's stretches are still loading.
   */
  beyond: BeyondTextNow | null;
  /** Take the voice on to where the text picks up again. */
  skipBeyond: () => void;
  /** Increments on every deliberate seek; the page follows again when it does. */
  seekNonce: number;
  state: FollowState;
  bookMs: number;
  /** Synchronous lifecycle capture, including time since the last timeupdate. */
  currentBookMs: () => number;
  /**
   * The chapter the narration is in, or nearest to, at a moment - from the
   * book's per-chapter timing bounds. Null until they have loaded, or when
   * the alignment timed nothing at all.
   */
  chapterAt: (bookMs: number) => number | null;
  speed: number;
  /** Why the narration cannot play, as a catalog key; null while all is well. */
  error: MessageKey | null;
  toggle: () => void;
  setSpeed: (rate: number) => void;
  back: () => void;
  /**
   * The narration a sentence on, or back - to the start of this one when it
   * is well into it (readalong.sentenceStep) - and across into the next
   * chapter or the one before at the edges. Playing or paused, as it was.
   */
  stepSentence: (dir: 'next' | 'prev') => void;
  /** The narration on (positive) or back by `ms`, playing or paused as it was. */
  skipBy: (ms: number) => void;
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
  /**
   * How far through the whole book the page is, 0-1: where in the narration
   * it roughly falls, for how long a sync still under way needs to get there.
   */
  pagePct?: () => number;
  /**
   * The narration has left this chapter; the reader should move. `target`
   * names the chapter the voice is actually in when that is known, so the
   * reader can go straight there; without it, one step in `direction`.
   */
  onLeaveChapter: (direction: 'next' | 'prev', target?: number) => void;
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
    pagePct,
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
  /** When the last automatic step was taken: a refusal to reverse expires. */
  const lastWalkAtRef = useRef(0);
  /**
   * Where each chapter sits in the narration. One small request per book,
   * and the difference between walking to the voice a chapter at a time -
   * or getting stuck between two chapters that each say the playhead is
   * past their edge - and opening the right chapter in one move.
   */
  const [bounds, setBounds] = useState<ChapterBound[] | null>(null);
  /** The stretches of the narration the ebook does not have (readalong.BeyondText). */
  const [stretches, setStretches] = useState<BeyondText[]>([]);
  /**
   * A sync still under way, and which alignment the timings are from: a
   * book paired a moment ago reads along with as much as its sync has done,
   * and both say when this chapter's timings are worth asking for again.
   */
  const [syncing, setSyncing] = useState<SyncingNow | null>(null);
  const [alignmentId, setAlignmentId] = useState<string | null>(null);
  /** Bumped to ask a book still syncing how far it has got. */
  const [syncPoll, setSyncPoll] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(() => speedFor(loadPlayback(), audioBookId ?? ''));
  const [error, setError] = useState<MessageKey | null>(null);
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
  /**
   * The sentence the voice was just sent to, until the clock is in it
   * (cueArriving): the one tapped shows, not the one before it.
   */
  const [arriving, setArriving] = useState<Cue | null>(null);
  const lookup = useMemo(() => cueArriving(cues, bookMs, arriving), [cues, bookMs, arriving]);
  useEffect(() => {
    if (arriving && hasArrived(arriving, bookMs)) setArriving(null);
  }, [arriving, bookMs]);

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
        if (alive) setError('reader.readAlong.audiobookFailed');
      });
    return () => {
      alive = false;
    };
  }, [enabled, audioBookId]);

  // A different book (or read along switched off) starts from nothing.
  useEffect(() => {
    setBounds(null);
    setStretches([]);
    setSyncing(null);
    setAlignmentId(null);
  }, [enabled, pairId]);

  // The book's chapter bounds - once, or, while its sync is still under way,
  // again every so often, since the bounds grow with it. Absent on a server
  // that predates the route, in which case the walker steps a chapter at a
  // time as before.
  useEffect(() => {
    if (!enabled || !pairId) return;
    let alive = true;
    void api<{
      chapters: ChapterBound[];
      beyondText?: BeyondText[];
      alignmentId?: string | null;
      syncing?: SyncingNow | null;
    }>(`/api/pairs/${pairId}/chapters`)
      .then((d) => {
        if (!alive) return;
        setBounds(d.chapters ?? []);
        // A server that predates them says nothing, and nothing is shown.
        setStretches(
          Array.isArray(d.beyondText)
            ? d.beyondText.filter(
                (b) => Number.isFinite(b?.fromMs) && Number.isFinite(b?.toMs) && b.toMs > b.fromMs,
              )
            : [],
        );
        setSyncing(d.syncing ?? null);
        setAlignmentId(d.alignmentId ?? null);
      })
      .catch(() => {
        if (alive) setBounds((b) => b ?? null);
      });
    return () => {
      alive = false;
    };
  }, [enabled, pairId, syncPoll]);

  const chapterAt = useCallback(
    (at: number): number | null =>
      bounds && bounds.length > 0 ? nearestChapter(bounds, at) : null,
    [bounds],
  );

  const beyond = useMemo(() => beyondTextAt(stretches, bookMs), [stretches, bookMs]);

  /** This chapter is still waiting on the sync (readalong.chapterSyncing). */
  const thisChapterSyncing = chapterSyncing(syncing, spineIdx);
  /**
   * What read along is waiting on, if anything: the sync has settled
   * nothing yet, or not this chapter, or the voice has run on past it.
   */
  const syncWait = useMemo((): SyncWait | null => {
    if (!syncing) return null;
    if (syncing.throughMs <= 0) return syncing.active ? { kind: 'preparing', etaMs: null } : null;
    const ahead = voiceAheadOfSync(syncing, bookMs) && playing;
    const waiting = (thisChapterSyncing && segments !== null && segments.length === 0) || ahead;
    if (!waiting) return null;
    if (!syncing.active) return { kind: 'stopped', etaMs: null };
    // Where the sync has to get to: a little past the voice when it is the
    // voice that is waiting, or about where the page falls in the narration.
    const target = ahead
      ? bookMs + 60_000
      : Math.max(syncing.throughMs, (pagePct?.() ?? 0) * syncing.audioMs);
    return { kind: 'pending', etaMs: syncEta(syncing, target) };
  }, [syncing, bookMs, playing, thisChapterSyncing, segments, pagePct]);

  // While a sync is under way, ask now and then how far it has got - often
  // when read along is waiting on it. A finished or stopped sync is not asked
  // again. Keyed on whether anything waits rather than on the wait itself,
  // which changes with every tick of the clock and would keep restarting
  // the timer before it could fire.
  const waitingOnSync = syncWait !== null;
  useEffect(() => {
    if (!enabled || !pairId || !syncing?.active) return;
    const id = setTimeout(
      () => setSyncPoll((n) => n + 1),
      waitingOnSync ? SYNC_POLL_WAITING_MS : SYNC_POLL_MS,
    );
    return () => clearTimeout(id);
  }, [enabled, pairId, syncing, waitingOnSync]);
  /** The chapter the text picks up in, while the voice reads what the ebook does not have. */
  const resumeSpine = beyond?.stretch.resume?.spineIdx ?? null;

  /**
   * When this chapter's timings are worth asking for again: when a sync under
   * way has got further into it (or past it), and once more when the
   * finished sync takes over from it. A chapter the sync is done with keeps
   * the timings it has.
   */
  const timingsRevision = `${alignmentId ?? ''}|${thisChapterSyncing ? (syncing?.throughMs ?? 0) : 'done'}`;
  /** The chapter the timings on hand belong to, so a refresh can keep them until it lands. */
  const timingsSpineRef = useRef<number | null>(null);

  // This chapter's timings. Refetched per chapter: a whole book's segments is
  // megabytes, and the reader only ever needs the page in front of them.
  useEffect(() => {
    if (!enabled || !pairId || spineIdx < 0) return;
    let alive = true;
    // A new chapter starts from nothing; the same chapter, asked again as a
    // sync goes on, keeps what it has until the update lands - otherwise the
    // highlight would blink off at every step of the sync.
    if (timingsSpineRef.current !== spineIdx) {
      timingsSpineRef.current = spineIdx;
      setSegments(null);
    }
    setSegmentsFailed(false);
    void api<{ segments: AlignedSegment[]; syncing?: SyncingNow | null }>(
      `/api/pairs/${pairId}/segments/${spineIdx}`,
    )
      .then((d) => {
        if (!alive) return;
        setSegments(d.segments ?? []);
        if (d.syncing !== undefined) setSyncing(d.syncing);
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
  }, [enabled, pairId, spineIdx, timingsRevision]);

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
    // The sentence's own start: early is the end of the sentence before.
    const at = Math.max(0, cue.startMs);
    setArriving(cue);
    // An explicit intent, not a heartbeat: it moves the progress claim to this
    // session, without which every heartbeat below is discarded as coming from
    // a session that lost the claim to another device.
    if (audioBookId) void recordCheckpoint(audioBookId, 'seek', audioLocatorAt(at));
    seekTo(at, true);
  }, [enabled, cues, tracks, startOffset, seekTo, audioBookId, audioLocatorAt]);

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
    // A chapter the sync has not got to yet, or the voice run on past what
    // it has: the page waits here for the sync to catch up. Walking on would
    // find nothing timed in the chapters after it either, and leave the
    // reader at the end of the book.
    if (thisChapterSyncing && (cues.length === 0 || voiceAheadOfSync(syncing, bookMs))) return;
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
    // With the chapter bounds known there is nothing to walk: the chapter
    // the voice is in is a lookup, and the page goes there in one move.
    // Narration the ebook does not have is in no chapter at all: the one
    // that matters is where the text picks up, and the page waits there -
    // not wherever the playhead happens to be nearer to, which flipped from
    // the chapter before to the chapter after halfway through.
    const target = resumeSpine ?? chapterAt(bookMs);
    if (target !== null) {
      if (target === spineIdx) return; // an untimed stretch inside this chapter
      lastWalkRef.current = target > spineIdx ? 'next' : 'prev';
      lastWalkAtRef.current = Date.now();
      leaveRef.current(target > spineIdx ? 'next' : 'prev', target);
      return;
    }
    // A refusal to reverse guards against ping-pong between two chapters,
    // and it must expire: a rewind into the untimed stretch between two
    // chapters used to step back, then be refused the step forward the
    // narration soon needed, and the page stayed a chapter behind the voice
    // with nothing to point at.
    const reverses =
      (dir === 'next' && lastWalkRef.current === 'prev') ||
      (dir === 'prev' && lastWalkRef.current === 'next');
    if (reverses && Date.now() - lastWalkAtRef.current < 4000) return;
    lastWalkRef.current = dir;
    lastWalkAtRef.current = Date.now();
    leaveRef.current(dir);
  }, [
    enabled,
    playing,
    following,
    lookup.state,
    segments,
    cues.length,
    chapterAt,
    resumeSpine,
    bookMs,
    spineIdx,
    thisChapterSyncing,
    syncing,
  ]);

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
    if (el.paused) void el.play().catch(() => setError('reader.readAlong.playFailed'));
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

  const back = useCallback(() => {
    setArriving(null);
    seekTo(Math.max(0, bookMs - backSeconds * 1000), playing);
  }, [seekTo, bookMs, playing, backSeconds]);

  /**
   * Where the voice is this instant, between the element's own reports - or,
   * while a seek into another file is still loading it, where it was sent: a
   * second press of an arrow must step on from there, not from the file it
   * is leaving.
   */
  const nowMs = useCallback(
    () =>
      audioRef.current && !pendingSeekRef.current
        ? (tracks[trackIdx]?.startMsAbsolute ?? 0) + audioRef.current.currentTime * 1000
        : bookMs,
    [tracks, trackIdx, bookMs],
  );

  const skipBy = useCallback(
    (ms: number) => {
      setArriving(null);
      seekTo(Math.max(0, Math.min(totalMs || Infinity, nowMs() + ms)), playing);
    },
    [seekTo, nowMs, playing, totalMs],
  );

  const stepSentence = useCallback(
    (dir: 'next' | 'prev') => {
      const now = nowMs();
      const target = sentenceStep(cues, now, dir, arriving);
      if (target) {
        setArriving(target);
        if (audioBookId) void recordCheckpoint(audioBookId, 'seek', audioLocatorAt(target.startMs));
        seekTo(Math.max(0, target.startMs), playing);
        return;
      }
      // Off the edge of this chapter's timings: into the next chapter, at its
      // first timed sentence - the chapter bounds say when that is - or back
      // to the last sentence of the one before, which takes asking for it.
      const chapters = bounds ?? [];
      if (dir === 'next') {
        const next = chapters
          .filter((b) => b.spineIdx > spineIdx && b.firstMs >= now)
          .sort((a, b) => a.spineIdx - b.spineIdx)[0];
        if (!next) return;
        if (audioBookId) void recordCheckpoint(audioBookId, 'seek', audioLocatorAt(next.firstMs));
        seekTo(next.firstMs, playing);
        return;
      }
      const prev = chapters
        .filter((b) => b.spineIdx < spineIdx && b.firstMs < now)
        .sort((a, b) => b.spineIdx - a.spineIdx)[0];
      if (!prev || !pairId) return;
      const wasPlaying = playing;
      void api<{ segments: AlignedSegment[] }>(`/api/pairs/${pairId}/segments/${prev.spineIdx}`)
        .then((d) => {
          const last = (d.segments ?? []).reduce<AlignedSegment | null>(
            (m, seg) => (!m || seg.startMs > m.startMs ? seg : m),
            null,
          );
          if (!last) return;
          if (audioBookId) void recordCheckpoint(audioBookId, 'seek', audioLocatorAt(last.startMs));
          seekTo(last.startMs, wasPlaying);
        })
        .catch(() => {
          /* the step back is a nicety; the voice stays where it is */
        });
    },
    [nowMs, cues, arriving, audioBookId, audioLocatorAt, seekTo, playing, bounds, spineIdx, pairId],
  );

  /**
   * The voice to the sentence at `charOffset`, from the very start of its
   * timing - never ahead of it, which played the end of the sentence before
   * and lit it too - with that sentence shown from the moment it is asked for.
   */
  const playFrom = useCallback(
    (charOffset: number) => {
      const cue = cueForOffset(cues, charOffset);
      if (!cue) return;
      const at = Math.max(0, cue.startMs);
      setArriving(cue);
      if (audioBookId) void recordCheckpoint(audioBookId, 'seek', audioLocatorAt(at));
      seekTo(at, true);
    },
    [cues, seekTo, audioBookId, audioLocatorAt],
  );

  /**
   * On to where the text picks up: the first word of its sentence, lit the
   * moment it is asked for when it is on this chapter's page.
   */
  const skipBeyond = useCallback(() => {
    const stretch = beyond?.stretch;
    if (!stretch?.resume) return;
    const at = stretch.toMs;
    setArriving(cues.find((c) => c.id === stretch.resume!.sentenceId) ?? null);
    if (audioBookId) void recordCheckpoint(audioBookId, 'seek', audioLocatorAt(at));
    seekTo(at, playing);
  }, [beyond, cues, audioBookId, audioLocatorAt, seekTo, playing]);

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
      onError={() => setError('reader.readAlong.formatFailed')}
    />
  ) : null;

  return {
    ready: tracks.length > 0 && segments !== null,
    // A chapter the sync has not reached is not an empty one: it is waiting.
    emptyChapter: segments !== null && cues.length === 0 && !thisChapterSyncing,
    timingsFailed: segmentsFailed,
    syncWait,
    skipUntimed: () => {
      lastWalkRef.current = 'next';
      lastWalkAtRef.current = Date.now();
      const target = chapterAt(bookMs);
      leaveRef.current('next', target !== null && target > spineIdx ? target : undefined);
    },
    playing,
    cue: lookup.cue,
    cues,
    arriving,
    beyond,
    skipBeyond,
    seekNonce,
    state: lookup.state,
    bookMs,
    speed,
    currentBookMs: () =>
      audioRef.current
        ? (tracks[trackIdx]?.startMsAbsolute ?? 0) + audioRef.current.currentTime * 1000
        : bookMs,
    chapterAt,
    error,
    backSeconds,
    toggle,
    setSpeed,
    back,
    stepSentence,
    skipBy,
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
  const t = useT();
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

  /**
   * What read along is waiting on, said plainly: a sync is still working on
   * this part, and roughly how long it will be. Like the time to the text
   * beside "Only in the audiobook", the words may shorten on a narrow bar
   * and the estimate may not - it is the part a listener glances for.
   */
  const syncStatus = (w: SyncWait): React.ReactNode => {
    const minutes =
      w.kind === 'pending' && w.etaMs !== null ? Math.max(1, Math.round(w.etaMs / 60_000)) : null;
    return (
      <>
        <span className="readalong__sync-label">
          {w.kind === 'preparing'
            ? t('reader.readAlong.sync.preparing')
            : w.kind === 'stopped'
              ? t('reader.readAlong.sync.stopped')
              : minutes === null
                ? t('reader.readAlong.sync.pending')
                : t('reader.readAlong.sync.pendingLabel')}
        </span>
        {minutes !== null && (
          <span className="readalong__sync-time">
            {' · '}
            {t('reader.readAlong.sync.eta', { n: minutes })}
          </span>
        )}
      </>
    );
  };

  const status: React.ReactNode = n.error
    ? t(n.error)
    : n.syncWait?.kind === 'preparing'
      ? syncStatus(n.syncWait)
      : !n.ready
        ? t('reader.readAlong.finding')
        : n.timingsFailed
          ? t('reader.readAlong.timingsFailed')
          : n.syncWait
            ? syncStatus(n.syncWait)
            : n.beyond
              ? null
              : n.emptyChapter
                ? t('reader.readAlong.nothingTimed')
                : n.state === 'gap'
                  ? t('reader.readAlong.gap')
                  : formatDuration(n.bookMs);

  return (
    <div className="readalong" role="group" aria-label={t('reader.readAlong.group')}>
      <button
        className="readalong__play"
        onClick={n.toggle}
        // Nothing to play from in a chapter the sync has not reached: the
        // voice would start wherever the audio happens to be, not here.
        disabled={
          !n.ready ||
          (n.emptyChapter && !n.playing) ||
          (!!n.syncWait && n.cues.length === 0 && !n.playing)
        }
        aria-label={n.playing ? t('reader.readAlong.pause') : t('reader.readAlong.play')}
      >
        {n.playing ? <IconPause size={20} /> : <IconPlay size={20} />}
      </button>

      {/* Front matter and unnarrated chapters are ordinary, and a disabled
          play button with no way on is a dead end. This is the way on. */}
      {n.emptyChapter && !n.playing && !n.timingsFailed && (
        <button className="readalong__resume" onClick={n.skipUntimed}>
          <IconTarget size={15} />
          <span>{t('reader.readAlong.find')}</span>
        </button>
      )}

      <button
        className="readalong__btn"
        onClick={n.back}
        disabled={!n.ready}
        aria-label={t('reader.readAlong.back', { n: n.backSeconds })}
        title={t('reader.readAlong.back', { n: n.backSeconds })}
      >
        <IconSkipBack size={18} label={String(n.backSeconds)} />
      </button>

      <span
        className={`readalong__status ${
          n.error
            ? 'is-warn'
            : n.syncWait
              ? 'is-syncing'
              : n.beyond
                ? 'is-beyond'
                : n.state === 'gap'
                  ? 'is-warn'
                  : ''
        }`}
      >
        {status ?? (
          // Only in the audiobook: on a narrow bar the words may shorten, the
          // time to the text may not - it is the part a listener glances for.
          <>
            <span className="readalong__beyond">{t('reader.readAlong.beyond.title')}</span>
            <span className="readalong__beyond-time">
              {' · '}
              {formatDuration(Math.ceil((n.beyond?.remainingMs ?? 0) / 1000) * 1000)}
            </span>
          </>
        )}
      </span>

      {/* Shown whenever the page has stopped following, cue or no cue: the
          moment the reader is MOST lost is when the voice has wandered into a
          chapter they cannot see, which is exactly when there is no cue here
          and the way back used to disappear. */}
      {!following && (
        <button
          className="readalong__resume"
          onClick={onResume}
          aria-label={t('reader.readAlong.backToVoice')}
          title={t('reader.readAlong.backToVoice')}
        >
          <IconTarget size={15} />
          <span>{t('reader.readAlong.backToVoice')}</span>
        </button>
      )}

      {/* Follow the voice down the page by itself. Offered only where it
          means something: in paginated mode the page already turns itself. */}
      {autoScroll !== null && (
        <button
          className="readalong__btn"
          aria-pressed={autoScroll}
          onClick={() => onAutoScroll(!autoScroll)}
          aria-label={
            autoScroll ? t('reader.readAlong.autoScrollOff') : t('reader.readAlong.autoScrollOn')
          }
          title={
            autoScroll ? t('reader.readAlong.autoScrollOff') : t('reader.readAlong.autoScrollOn')
          }
        >
          <IconAutoScroll size={18} />
        </button>
      )}

      <div className="readalong__speed">
        <button
          className="readalong__btn"
          onClick={() => setSpeedOpen((v) => !v)}
          aria-expanded={speedOpen}
          aria-label={t('reader.readAlong.speed', { rate: n.speed })}
        >
          <IconSpeed size={18} />
          <small>{t('reader.readAlong.rate', { rate: n.speed })}</small>
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
                {t('reader.readAlong.rate', { rate: s })}
              </button>
            ))}
          </div>
        )}
      </div>

      <button className="readalong__btn" onClick={onClose} aria-label={t('reader.readAlong.stop')}>
        <IconClose size={18} />
      </button>
    </div>
  );
}
