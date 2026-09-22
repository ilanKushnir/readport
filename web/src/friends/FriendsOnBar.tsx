import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { friendColourStyle, type Locator } from '@readport/shared';
import { api } from '../api/client';
import { IconClose } from '../components/icons';
import { useFocusTrap } from '../components/ui';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import './friends-bar.css';

/**
 * Friends on the progress bar.
 *
 * The reader's bar gains a small button. It opens a card listing the friends
 * who share their place in THIS book: each with a colour, where they are
 * (chapter, percent, when), how far ahead or behind you they are, and a
 * switch to draw them on your bar. A drawn friend is a thin marker in their
 * colour at their position; tapping the button again is how you find out
 * more. Which friends are drawn is remembered per book, per viewer.
 *
 * Kept out of ReaderPage on purpose: it needs the book id, your own
 * position, and a way to name a chapter, and nothing else the reader knows.
 * The same component serves the audiobook player.
 */

export interface FriendProgress {
  userId: string;
  displayName: string;
  /** A palette name from the shared `FRIEND_COLOURS`, never a hex. */
  colour: string;
  locator: Locator;
  pct: number;
  finished: boolean;
  updatedAt: string;
  /** In the book right now; absent from a server that does not say. */
  live?: boolean;
  chapterTitle?: string | null;
}

interface FriendsPrefs {
  shareProgress: boolean;
  colours: Record<string, string>;
  shown: Record<string, string[]>;
}

const EMPTY_PREFS: FriendsPrefs = { shareProgress: true, colours: {}, shown: {} };

/** Everyone sharing their place in this book, and which of them you draw. */
export function useFriendsOnBook(bookId: string | null) {
  const [friends, setFriends] = useState<FriendProgress[]>([]);
  const [prefs, setPrefs] = useState<FriendsPrefs>(EMPTY_PREFS);
  const [ready, setReady] = useState(false);
  /** The card is one per book, opened from the stack beside the bar or any bead on it. */
  const [cardOpen, setCardOpen] = useState(false);

  const load = useCallback(async () => {
    if (!bookId) return;
    try {
      const [p, f] = await Promise.all([
        api<{ friends: FriendsPrefs | null }>('/api/prefs/friends').catch(() => ({
          friends: null,
        })),
        api<{ friends: FriendProgress[] }>(
          `/api/friends/progress?bookId=${encodeURIComponent(bookId)}`,
        ),
      ]);
      // Shapes are checked, not trusted: a mock, a proxy's error page or an
      // older server answers with something, and the bar must stay quiet.
      const prefsIn = p?.friends;
      setPrefs(
        prefsIn && typeof prefsIn === 'object'
          ? {
              shareProgress: prefsIn.shareProgress !== false,
              colours: prefsIn.colours ?? {},
              shown: prefsIn.shown ?? {},
            }
          : EMPTY_PREFS,
      );
      setFriends(Array.isArray(f?.friends) ? f.friends : []);
    } catch {
      /* offline, no friends, or an older server: the button simply stays away */
      setFriends([]);
    } finally {
      setReady(true);
    }
  }, [bookId]);

  useEffect(() => {
    void load();
  }, [load]);
  // A friend who is here now was not here a minute ago: ask again while
  // the book is open and the tab is in front, and on coming back to it.
  useEffect(() => {
    if (!bookId) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = setInterval(tick, LIVE_REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [bookId, load]);

  // A friend's place moves while you read; ask again now and then, and when
  // the tab comes back. Cheap: one small request.
  useEffect(() => {
    if (!bookId) return;
    const every = setInterval(() => void load(), 90_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(every);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [bookId, load]);

  // A book with no entry draws everyone: a friend appears on your bar the
  // moment they open the same book, and the button explains who they are.
  // The first switch you turn off writes the explicit list.
  const shownIds = useMemo(() => {
    const entry = bookId ? prefs.shown[bookId] : undefined;
    return new Set(entry ?? friends.map((f) => f.userId));
  }, [prefs, bookId, friends]);

  const setShown = useCallback(
    async (userId: string, on: boolean) => {
      if (!bookId) return;
      const current = new Set(prefs.shown[bookId] ?? friends.map((f) => f.userId));
      if (on) current.add(userId);
      else current.delete(userId);
      const next: FriendsPrefs = {
        ...prefs,
        shown: { ...prefs.shown, [bookId]: [...current] },
      };
      setPrefs(next); // optimistic: the marker appears as the switch flips
      try {
        await api('/api/prefs/friends', { method: 'PUT', body: next });
      } catch {
        setPrefs(prefs);
      }
    },
    [bookId, prefs, friends],
  );

  return { friends, shownIds, setShown, ready, reload: load, cardOpen, setCardOpen };
}

/** A bead's diameter on the bar, as friends-bar.css draws it. */
const BEAD_PX = 15;
/** How often the bar asks again who is here: presence lasts minutes, not seconds. */
const LIVE_REFRESH_MS = 60_000;

/** The first letter of a name, as a bead can carry it. */
function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : '·';
}

/**
 * Beads on the bar, one per drawn friend, sitting on the track at their
 * place like beads on a string: the friend's colour, their initial, and a
 * ring in the ground colour so two beads a page apart stay two beads. Two
 * friends at the same place step aside from each other by a bead's width
 * rather than stacking into one. Each bead is a button that opens the card,
 * because the natural question on seeing one is "who is that?".
 */
export function FriendMarkers({
  friends,
  shownIds,
  on = 'mini',
  onPick,
}: {
  friends: FriendProgress[];
  shownIds: Set<string>;
  /** Which bar the beads sit on; each draws its track at a different height. */
  on?: 'mini' | 'slider' | 'player';
  onPick?: () => void;
}) {
  const t = useT();
  const f = useFormat();
  // The bar's width in pixels, so "too close" is measured where the beads
  // are drawn: two friends a page apart overlap on a phone's short track
  // and sit well apart on a desktop's, and only the first should step aside.
  // Measured through a callback ref, because the bar mounts only once the
  // friends have loaded - an effect run on the component's own mount would
  // find nothing to measure and never look again.
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((el: HTMLSpanElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(el.clientWidth);
    observer.current = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.current.observe(el);
  }, []);
  const drawn = friends.filter((x) => shownIds.has(x.userId)).sort((x, y) => x.pct - y.pct);
  if (drawn.length === 0) return null;
  // Where each bead is drawn, in pixels along the bar: at its place, or
  // right after the bead before it when its place is under that bead -
  // judged against where the previous one was DRAWN, since a bead that
  // stepped aside can land on the next one's place.
  const shifts: number[] = [];
  let lastDrawn = -Infinity;
  drawn.forEach((x) => {
    const at = x.pct * width;
    const drawnAt = width > 0 ? Math.max(at, lastDrawn + BEAD_PX + 2) : at;
    shifts.push(drawnAt - at);
    lastDrawn = drawnAt;
  });
  return (
    <span className={`fbar fbar--${on}`} ref={measure}>
      {drawn.map((x, i) => (
        <button
          key={x.userId}
          type="button"
          className={`fbead${x.live ? ' fbead--live' : ''}`}
          style={
            {
              insetInlineStart: `${Math.min(100, Math.max(0, x.pct * 100))}%`,
              '--fbead-shift': `${shifts[i]}px`,
              ...friendColourStyle(x.colour),
            } as React.CSSProperties
          }
          aria-label={t(x.live ? 'friends.bar.beadLive' : 'friends.bar.bead', {
            name: x.displayName,
            pct: f.percent(x.pct),
          })}
          title={`${x.displayName} · ${f.percent(x.pct)}`}
          onClick={(e) => {
            e.stopPropagation();
            onPick?.();
          }}
        >
          <span aria-hidden="true">{initialOf(x.displayName)}</span>
        </button>
      ))}
    </span>
  );
}

/** The button by the bar, and the card it opens. */
export function FriendsButton({
  bookId,
  myPct,
  friends,
  shownIds,
  setShown,
  chapterOf,
  className,
  open,
  setOpen,
}: {
  bookId: string;
  myPct: number;
  friends: FriendProgress[];
  shownIds: Set<string>;
  setShown: (userId: string, on: boolean) => void;
  /** Name the chapter a friend is in, if the surface can. */
  chapterOf?: (locator: Locator) => string | null;
  className?: string;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const t = useT();

  if (friends.length === 0) return null;
  const drawn = friends.filter((x) => shownIds.has(x.userId));
  const shown = (drawn.length ? drawn : friends).slice(0, 3);

  return (
    <>
      {/* The friends in this book as a stack of beads - the same beads that
          sit on the bar - and, past three, how many more. It lives beside
          the percentage, where the bar's other figures are, on every
          screen size. */}
      <button
        type="button"
        className={`fstack ${className ?? ''}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('friends.bar.button', { n: friends.length })}
        title={t('friends.bar.button', { n: friends.length })}
      >
        {shown.map((x) => (
          <span
            key={x.userId}
            className={`fbead fbead--static${x.live ? ' fbead--live' : ''}`}
            style={friendColourStyle(x.colour) as React.CSSProperties}
            aria-hidden="true"
          >
            <span>{initialOf(x.displayName)}</span>
          </span>
        ))}
        {friends.length > 3 && <span className="fstack__more">+{friends.length - 3}</span>}
      </button>
      {open && (
        <FriendsCard
          bookId={bookId}
          myPct={myPct}
          friends={friends}
          shownIds={shownIds}
          setShown={setShown}
          chapterOf={chapterOf}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * The card: its own component so the focus trap, the scroll lock and the
 * key handling exist only while it is on screen.
 */
function FriendsCard({
  bookId,
  myPct,
  friends,
  shownIds,
  setShown,
  chapterOf,
  onClose,
}: {
  bookId: string;
  myPct: number;
  friends: FriendProgress[];
  shownIds: Set<string>;
  setShown: (userId: string, on: boolean) => void;
  chapterOf?: (locator: Locator) => string | null;
  onClose: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);

  // The reader and the player listen to the keyboard on the document: an
  // arrow turns the page, Escape leaves the book. While the card is open
  // those keys are the card's. Caught in the capture phase, so they never
  // reach the surface underneath; Tab is left alone for the focus trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') return;
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <>
      <div className="fcard-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="fcard"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`fcard-${bookId}`}
        tabIndex={-1}
        ref={ref}
      >
        <header className="fcard__head">
          <h2 id={`fcard-${bookId}`}>{t('friends.bar.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <IconClose />
          </button>
        </header>
        <p className="fcard__lede">{t('friends.bar.lede')}</p>
        <ul className="fcard__list">
          {friends.map((x) => {
            const delta = Math.round((x.pct - myPct) * 100);
            const chapter = x.chapterTitle ?? chapterOf?.(x.locator) ?? null;
            const on = shownIds.has(x.userId);
            return (
              <li key={x.userId} className="fcard__row">
                <span
                  className="fcard__dot"
                  style={friendColourStyle(x.colour) as React.CSSProperties}
                  aria-hidden="true"
                >
                  {initialOf(x.displayName)}
                </span>
                <div className="fcard__body">
                  <div className="fcard__name">
                    {x.displayName}
                    {x.live && (
                      <span
                        className="live-chip"
                        title={t('friends.live.here', { name: x.displayName })}
                      >
                        <span className="live-dot" aria-hidden="true" />
                        {t(
                          x.locator.medium === 'audio'
                            ? 'friends.live.listening'
                            : 'friends.live.reading',
                        )}
                      </span>
                    )}
                  </div>
                  <div className="fcard__where">
                    {x.finished
                      ? t('friends.bar.finished')
                      : chapter
                        ? t('friends.bar.atChapter', {
                            chapter,
                            pct: f.percent(x.pct),
                          })
                        : f.percent(x.pct)}
                    {x.live ? '' : ` · ${f.ago(x.updatedAt)}`}
                  </div>
                  <div className="fcard__delta">
                    {x.finished
                      ? ''
                      : Math.abs(delta) < 1
                        ? t('friends.bar.together')
                        : delta > 0
                          ? t('friends.bar.ahead', { pct: delta })
                          : t('friends.bar.behind', { pct: -delta })}
                  </div>
                </div>
                <label className="fcard__switch">
                  <span className="visually-hidden">
                    {t('friends.bar.show', { name: x.displayName })}
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={on}
                    onChange={(e) => setShown(x.userId, e.target.checked)}
                  />
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </>,
    document.body,
  );
}
