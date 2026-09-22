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

  return { friends, shownIds, setShown, ready, reload: load };
}

/** Thin markers over the bar, one per drawn friend. Purely decorative;
 *  the card is where the same information is readable. */
export function FriendMarkers({
  friends,
  shownIds,
  on = 'mini',
}: {
  friends: FriendProgress[];
  shownIds: Set<string>;
  /** Which bar the marks sit on; each draws its track at a different height. */
  on?: 'mini' | 'slider' | 'player';
}) {
  const drawn = friends.filter((f) => shownIds.has(f.userId));
  if (drawn.length === 0) return null;
  return (
    <span className={`fbar fbar--${on}`} aria-hidden="true">
      {drawn.map((f) => (
        <span
          key={f.userId}
          className="fbar__mark"
          title={f.displayName}
          style={
            {
              insetInlineStart: `${Math.min(100, Math.max(0, f.pct * 100))}%`,
              ...friendColourStyle(f.colour),
            } as React.CSSProperties
          }
        />
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
}: {
  bookId: string;
  myPct: number;
  friends: FriendProgress[];
  shownIds: Set<string>;
  setShown: (userId: string, on: boolean) => void;
  /** Name the chapter a friend is in, if the surface can. */
  chapterOf?: (locator: Locator) => string | null;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  if (friends.length === 0) return null;
  const drawn = friends.filter((x) => shownIds.has(x.userId));

  return (
    <>
      <button
        type="button"
        className={`fbtn ${className ?? ''}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('friends.bar.button', { n: friends.length })}
        title={t('friends.bar.button', { n: friends.length })}
      >
        <span className="fbtn__dots" aria-hidden="true">
          {(drawn.length ? drawn : friends).slice(0, 3).map((x) => (
            <span key={x.userId} style={friendColourStyle(x.colour) as React.CSSProperties} />
          ))}
        </span>
        <span className="fbtn__n">{friends.length}</span>
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
                />
                <div className="fcard__body">
                  <div className="fcard__name">{x.displayName}</div>
                  <div className="fcard__where">
                    {x.finished
                      ? t('friends.bar.finished')
                      : chapter
                        ? t('friends.bar.atChapter', {
                            chapter,
                            pct: f.percent(x.pct),
                          })
                        : f.percent(x.pct)}
                    {' · '}
                    {f.ago(x.updatedAt)}
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
