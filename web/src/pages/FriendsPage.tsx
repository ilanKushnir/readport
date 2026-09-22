import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { type BookSummary, type Locator } from '@readport/shared';
import {
  DEFAULT_FRIENDS_PREFS,
  FRIEND_COLOURS,
  RECOMMENDATION_NOTE_MAX,
  friendColourStyle,
  type FriendColourId,
  type FriendsPrefs,
} from '@readport/shared';
import { api, ApiError, failureMessage } from '../api/client';
import { useSession } from '../state/session';
import { useShelves } from '../state/shelves';
import { Cover, EmptyState, Sheet, useToast } from '../components/ui';
import { IconAlert, IconClose, IconPeople, IconSearch } from '../components/icons';
import { useT } from '../i18n';
import { type MessageValues } from '../i18n/format';
import { useFormat } from '../i18n/useFormat';
import { type MessageKey } from '../i18n/messages/en';

/**
 * Friends: who may see your place in a book, and the books they have put in
 * front of you.
 *
 * Everyone on this server already shares the library, so there is nothing
 * here about access. A friendship is consent, given in both directions by a
 * request and an answer, and what it opens is small: which book, how far
 * along, and a line of recommendation now and then. The page is laid out in
 * the order those things matter - what was recommended to you, then your
 * friends, then what is pending, then who else is here - and ends with the
 * one switch that is about you rather than them.
 */

export interface Person {
  userId: string;
  username: string;
  /** The display name, or the username when there is none: always something to print. */
  displayName: string;
}

export interface Friend extends Person {
  friendshipId: string;
  since: string;
  /** A palette name (see shared/friends.ts), resolved by the server from this viewer's prefs. */
  colour: string;
  /** THEIR setting: whether this viewer may see where they are. */
  sharesProgress: boolean;
  reading: {
    bookId: string;
    title: string;
    kind: 'ebook' | 'audio';
    pct: number;
    updatedAt: string;
  } | null;
}

export interface FriendRequest extends Person {
  id: string;
  createdAt: string;
}

export interface FriendsData {
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  people: Person[];
}

export interface Recommendation {
  id: string;
  book: BookSummary;
  from: Person;
  note: string | null;
  createdAt: string;
  seenAt: string | null;
}

/** One friend's place in one book, as GET /api/friends/progress reports it. */
export interface FriendProgressEntry extends Person {
  colour: string;
  locator: Locator;
  pct: number;
  finished: boolean;
  updatedAt: string;
  chapterTitle: string | null;
}

/* ----------------------------------------------------------- pure helpers */

/** Nobody else on the server: nobody to befriend, nothing pending, nothing put in front of you. */
export function emptyServer(data: FriendsData, inbox: Recommendation[]): boolean {
  return (
    data.friends.length === 0 &&
    data.incoming.length === 0 &&
    data.outgoing.length === 0 &&
    data.people.length === 0 &&
    inbox.length === 0
  );
}

/** The one line under a friend's name: where they are, or why that is not said. */
export function readingLine(
  friend: Pick<Friend, 'sharesProgress' | 'reading'>,
  percent: (pct: number) => string,
): { key: MessageKey; values?: MessageValues } {
  if (!friend.sharesProgress) return { key: 'friends.list.notSharing' };
  if (!friend.reading) return { key: 'friends.list.nothingOnTheGo' };
  return {
    key: 'friends.list.reading',
    values: {
      kind: friend.reading.kind,
      title: friend.reading.title,
      pct: percent(friend.reading.pct),
    },
  };
}

/** One friend's entry on the book page: how far, and the chapter when the book can name it. */
export function bookLine(
  entry: Pick<FriendProgressEntry, 'displayName' | 'pct' | 'finished' | 'chapterTitle'>,
  percent: (pct: number) => string,
): { key: MessageKey; values: MessageValues } {
  const name = entry.displayName;
  if (entry.finished) return { key: 'friends.book.entryFinished', values: { name } };
  const pct = percent(entry.pct);
  if (entry.chapterTitle) {
    return { key: 'friends.book.entryChapter', values: { name, pct, chapter: entry.chapterTitle } };
  }
  return { key: 'friends.book.entry', values: { name, pct } };
}

/** The dot's colour, as inline custom properties the stylesheet maps per theme. */
const dotStyle = (colour: string | null | undefined) =>
  friendColourStyle(colour) as React.CSSProperties;

/* ------------------------------------------------------------------ page */

export function FriendsPage() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const { user: me, refresh: refreshSession } = useSession();
  const { refresh: refreshShelves } = useShelves();
  const [data, setData] = useState<FriendsData | null>(null);
  const [inbox, setInbox] = useState<Recommendation[] | null>(null);
  const [prefs, setPrefs] = useState<FriendsPrefs | null>(null);
  const [failed, setFailed] = useState(false);
  const [recommendTo, setRecommendTo] = useState<Friend | null>(null);
  // Cards that arrived unseen keep their mark for this visit, even though the
  // server is told they were seen the moment the page showed them.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());

  const load = useCallback(async () => {
    try {
      const [list, box, p] = await Promise.all([
        api<FriendsData>('/api/friends'),
        api<{ recommendations: Recommendation[] }>('/api/friends/inbox'),
        api<{ friends: FriendsPrefs | null }>('/api/prefs/friends'),
      ]);
      setData(list);
      setInbox(box.recommendations);
      setPrefs(p.friends ?? DEFAULT_FRIENDS_PREFS);
      setFailed(false);
      const unseen = box.recommendations.filter((r) => !r.seenAt);
      if (unseen.length === 0) return;
      setFresh((s) => new Set([...s, ...unseen.map((r) => r.id)]));
      // Being shown is being seen: the sender learns it was looked at, and
      // the dot in the nav goes out - which means reading the session's
      // counts again, since they arrive with /api/auth/me.
      await Promise.all(
        unseen.map((r) =>
          api(`/api/friends/inbox/${r.id}/seen`, { method: 'POST' }).catch(() => undefined),
        ),
      );
      void refreshSession();
    } catch {
      setFailed(true);
      setData((d) => d ?? { friends: [], incoming: [], outgoing: [], people: [] });
      setInbox((i) => i ?? []);
    }
  }, [refreshSession]);
  useEffect(() => {
    void load();
  }, [load]);

  /** One action, one toast, one reload; `countsChanged` also refreshes the nav's dots. */
  const act = async (
    run: () => Promise<unknown>,
    ok: string,
    fail: string,
    countsChanged = false,
  ) => {
    try {
      await run();
      toast.show(ok);
      await load();
      if (countsChanged) void refreshSession();
    } catch (err) {
      toast.show(failureMessage(err, fail, t));
    }
  };

  const addFriend = async (p: Person) => {
    try {
      const res = await api<{ status: 'pending' | 'accepted' }>('/api/friends/requests', {
        method: 'POST',
        body: { userId: p.userId },
      });
      // If they had already asked, asking back is the acceptance.
      toast.show(
        res.status === 'accepted'
          ? t('friends.requests.nowFriends', { name: p.displayName })
          : t('friends.people.sent', { name: p.displayName }),
      );
      await load();
      if (res.status === 'accepted') void refreshSession();
    } catch (err) {
      toast.show(failureMessage(err, t('friends.people.addFailed'), t));
    }
  };

  const setColour = async (friend: Friend, colour: FriendColourId) => {
    const base = prefs ?? DEFAULT_FRIENDS_PREFS;
    const next: FriendsPrefs = { ...base, colours: { ...base.colours, [friend.userId]: colour } };
    setPrefs(next);
    setData(
      (d) =>
        d && {
          ...d,
          friends: d.friends.map((x) => (x.userId === friend.userId ? { ...x, colour } : x)),
        },
    );
    try {
      await api('/api/prefs/friends', { method: 'PUT', body: next });
    } catch (err) {
      toast.show(failureMessage(err, t('friends.list.colourFailed'), t));
      void load();
    }
  };

  const setShare = async (on: boolean) => {
    const base = prefs ?? DEFAULT_FRIENDS_PREFS;
    const next: FriendsPrefs = { ...base, shareProgress: on };
    setPrefs(next);
    try {
      await api('/api/prefs/friends', { method: 'PUT', body: next });
    } catch (err) {
      setPrefs(base);
      toast.show(failureMessage(err, t('friends.settings.saveFailed'), t));
    }
  };

  const addToList = async (rec: Recommendation) => {
    try {
      const res = await api<{ added: boolean }>(`/api/reading-list/${rec.book.id}`, {
        method: 'PUT',
        // Credited to the friend who put it in front of them: the list
        // says "Recommended by" under the title, in their colour.
        body: { recommendedBy: rec.from.userId },
      });
      toast.show(res.added ? t('friends.inbox.added') : t('friends.inbox.onList'));
      void refreshShelves();
    } catch (err) {
      toast.show(failureMessage(err, t('friends.inbox.addFailed'), t));
    }
  };

  const dismiss = async (rec: Recommendation) => {
    try {
      await api(`/api/friends/inbox/${rec.id}/dismiss`, { method: 'POST' });
      setInbox((list) => (list ?? []).filter((r) => r.id !== rec.id));
      toast.show(t('friends.inbox.dismissed'));
    } catch (err) {
      toast.show(failureMessage(err, t('friends.inbox.dismissFailed'), t));
    }
  };

  const measure = { '--rp-measure': '820px' } as React.CSSProperties;

  if (!data || !inbox) {
    return (
      <main
        className="app-main friends-page"
        id="main-content"
        tabIndex={-1}
        aria-busy="true"
        style={measure}
      >
        <header className="page-head">
          <h1>{t('friends.title')}</h1>
          <p>{t('friends.lede')}</p>
        </header>
        <div className="skeleton" style={{ height: 160 }} />
      </main>
    );
  }

  const nobody = emptyServer(data, inbox);
  const requests = data.incoming.length + data.outgoing.length;

  return (
    <main className="app-main friends-page" id="main-content" tabIndex={-1} style={measure}>
      <header className="page-head">
        <h1>{t('friends.title')}</h1>
        <p>{t('friends.lede')}</p>
      </header>

      {failed && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} /> {t('friends.loadFailed')}
        </div>
      )}

      {!failed && nobody && (
        <EmptyState
          icon={<IconPeople size={28} />}
          title={t('friends.empty.title')}
          action={
            me?.role === 'admin' ? (
              <Link className="btn btn--secondary" to="/settings/people">
                {t('friends.empty.openPeople')}
              </Link>
            ) : undefined
          }
        >
          {t('friends.empty.body')}
        </EmptyState>
      )}

      {!nobody && (
        <>
          <Section id="friends-inbox-h" title={t('friends.inbox.title')} count={inbox.length}>
            {inbox.length === 0 ? (
              <p className="friends-section__empty">{t('friends.inbox.empty')}</p>
            ) : (
              <ul className="friends-inbox">
                {inbox.map((rec) => (
                  <RecommendationCard
                    key={rec.id}
                    rec={rec}
                    fresh={fresh.has(rec.id)}
                    onAdd={() => void addToList(rec)}
                    onDismiss={() => void dismiss(rec)}
                  />
                ))}
              </ul>
            )}
          </Section>

          <Section id="friends-list-h" title={t('friends.list.title')} count={data.friends.length}>
            {data.friends.length === 0 ? (
              <p className="friends-section__empty">{t('friends.list.empty')}</p>
            ) : (
              <ul className="friends-list">
                {data.friends.map((friend) => (
                  <FriendRow
                    key={friend.userId}
                    friend={friend}
                    onRecommend={() => setRecommendTo(friend)}
                    onColour={(c) => void setColour(friend, c)}
                    onRemove={() =>
                      act(
                        () => api(`/api/friends/${friend.userId}`, { method: 'DELETE' }),
                        t('friends.list.removed', { name: friend.displayName }),
                        t('friends.list.removeFailed'),
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </Section>

          {requests > 0 && (
            <Section id="friends-requests-h" title={t('friends.requests.title')} count={requests}>
              <ul className="friends-list">
                {data.incoming.map((r) => (
                  <PersonRow
                    key={r.id}
                    person={r}
                    line={t('friends.requests.asked', { when: f.ago(r.createdAt) })}
                  >
                    <button
                      className="btn btn--sm"
                      onClick={() =>
                        act(
                          () => api(`/api/friends/requests/${r.id}/accept`, { method: 'POST' }),
                          t('friends.requests.nowFriends', { name: r.displayName }),
                          t('friends.requests.failed'),
                          true,
                        )
                      }
                    >
                      {t('friends.requests.accept')}
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() =>
                        act(
                          () => api(`/api/friends/requests/${r.id}/decline`, { method: 'POST' }),
                          t('friends.requests.declined'),
                          t('friends.requests.failed'),
                          true,
                        )
                      }
                    >
                      {t('friends.requests.decline')}
                    </button>
                  </PersonRow>
                ))}
                {data.outgoing.map((r) => (
                  <PersonRow
                    key={r.id}
                    person={r}
                    line={t('friends.requests.youAsked', { when: f.ago(r.createdAt) })}
                  >
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() =>
                        act(
                          () => api(`/api/friends/requests/${r.id}/decline`, { method: 'POST' }),
                          t('friends.requests.cancelled'),
                          t('friends.requests.failed'),
                        )
                      }
                    >
                      {t('friends.requests.cancel')}
                    </button>
                  </PersonRow>
                ))}
              </ul>
            </Section>
          )}

          {data.people.length > 0 && (
            <Section id="friends-people-h" title={t('friends.people.title')}>
              <ul className="friends-list">
                {data.people.map((p) => (
                  <PersonRow key={p.userId} person={p}>
                    <button
                      className="btn btn--secondary btn--sm"
                      onClick={() => void addFriend(p)}
                    >
                      {t('friends.people.add')}
                    </button>
                  </PersonRow>
                ))}
              </ul>
            </Section>
          )}

          <Section id="friends-sharing-h" title={t('friends.settings.title')}>
            <label className="rs-toggle friends-toggle">
              <span>
                {t('friends.settings.share')}
                <span className="hint">{t('friends.settings.shareHint')}</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={prefs?.shareProgress ?? true}
                disabled={!prefs}
                onChange={(e) => void setShare(e.target.checked)}
              />
            </label>
          </Section>
        </>
      )}

      {recommendTo && (
        <RecommendSheet
          friend={recommendTo}
          onClose={() => setRecommendTo(null)}
          onSent={() => setRecommendTo(null)}
        />
      )}
    </main>
  );
}

function Section({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  children: ReactNode;
}) {
  const f = useFormat();
  return (
    <section className="friends-section" aria-labelledby={id}>
      <h2 id={id}>
        {title}
        {count !== undefined && count > 0 && (
          <>
            {' '}
            <span className="section-title__count">{f.number(count)}</span>
          </>
        )}
      </h2>
      {children}
    </section>
  );
}

/* ----------------------------------------------------------------- rows */

/** A person who is not (yet) a friend: a request either way, or someone to add. */
function PersonRow({
  person,
  line,
  children,
}: {
  person: Person;
  line?: string;
  children: ReactNode;
}) {
  return (
    <li className="friends-row">
      <div className="friends-row__main">
        <span className="friends-dot friends-dot--none" aria-hidden="true" />
        <div className="friends-row__body">
          <span className="friends-row__name">{person.displayName}</span>
          <span className="friends-row__line">
            {line ??
              (person.displayName !== person.username ? (
                <>
                  @<bdi>{person.username}</bdi>
                </>
              ) : null)}
          </span>
        </div>
        <div className="friends-row__actions">{children}</div>
      </div>
    </li>
  );
}

function FriendRow({
  friend,
  onRecommend,
  onColour,
  onRemove,
}: {
  friend: Friend;
  onRecommend: () => void;
  onColour: (colour: FriendColourId) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const [picking, setPicking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const line = readingLine(friend, f.percent);
  const text = t(line.key, line.values);
  return (
    <li className="friends-row">
      <div className="friends-row__main">
        <button
          type="button"
          className="friends-dot friends-dot--pick"
          style={dotStyle(friend.colour)}
          aria-label={t('friends.list.colourFor', { name: friend.displayName })}
          aria-expanded={picking}
          onClick={() => setPicking((p) => !p)}
        />
        <div className="friends-row__body">
          <span className="friends-row__name">{friend.displayName}</span>
          <span className="friends-row__line">
            {friend.sharesProgress && friend.reading ? (
              <Link to={`/book/${friend.reading.bookId}`}>{text}</Link>
            ) : (
              text
            )}
          </span>
        </div>
        <div className="friends-row__actions">
          {confirm ? (
            <>
              <button className="btn btn--danger btn--sm" onClick={onRemove}>
                {t('friends.list.removeYes', { name: friend.displayName })}
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirm(false)}>
                {t('friends.list.keep')}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn--secondary btn--sm" onClick={onRecommend}>
                {t('friends.list.recommend')}
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirm(true)}>
                {t('friends.list.remove')}
              </button>
            </>
          )}
        </div>
      </div>
      {picking && (
        <div
          className="friends-swatches"
          role="group"
          aria-label={t('friends.list.colourFor', { name: friend.displayName })}
        >
          {FRIEND_COLOURS.map((c) => (
            <button
              key={c.id}
              type="button"
              className="friends-dot friends-dot--swatch"
              style={dotStyle(c.id)}
              aria-pressed={c.id === friend.colour}
              aria-label={t('friends.list.colourName', { colour: c.id })}
              onClick={() => {
                onColour(c.id);
                setPicking(false);
              }}
            />
          ))}
        </div>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------- inbox */

function RecommendationCard({
  rec,
  fresh,
  onAdd,
  onDismiss,
}: {
  rec: Recommendation;
  fresh: boolean;
  onAdd: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const to = `/book/${rec.book.id}`;
  return (
    <li className="friends-card">
      <Link to={to} className="friends-card__cover" tabIndex={-1} aria-hidden="true">
        <Cover book={rec.book} className="friends-card__img" />
      </Link>
      <div className="friends-card__body">
        <div className="friends-card__title">
          {fresh && <span className="badge badge--sync">{t('friends.inbox.new')}</span>}
          <Link to={to} dir="auto">
            {rec.book.title}
          </Link>
        </div>
        {rec.book.author && (
          <div className="friends-card__author" dir="auto">
            {rec.book.author}
          </div>
        )}
        <div className="friends-card__from">
          {t('friends.inbox.from', { name: rec.from.displayName })} · {f.ago(rec.createdAt)}
        </div>
        {rec.note && (
          <blockquote className="friends-card__note" dir="auto">
            {rec.note}
          </blockquote>
        )}
        <div className="friends-card__actions">
          <Link className="btn btn--secondary btn--sm" to={to}>
            {t('friends.inbox.openBook')}
          </Link>
          <button className="btn btn--ghost btn--sm" onClick={onAdd}>
            {t('friends.inbox.addToList')}
          </button>
        </div>
      </div>
      <button
        className="icon-btn friends-card__dismiss"
        aria-label={t('friends.inbox.dismiss', { title: rec.book.title })}
        onClick={onDismiss}
      >
        <IconClose size={15} />
      </button>
    </li>
  );
}

/* --------------------------------------------------------------- sheets */

function NoteField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  return (
    <div className="field">
      <label htmlFor="friends-note">{t('friends.recommend.noteLabel')}</label>
      <textarea
        id="friends-note"
        className="input friends-note"
        rows={3}
        maxLength={RECOMMENDATION_NOTE_MAX}
        value={value}
        placeholder={t('friends.recommend.notePlaceholder')}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** How many of the library's rows the picker shows before asking for a narrower search. */
const PICK_LIMIT = 30;

/**
 * "Recommend a book…" from a friend's row: find the book in the library,
 * add a line if there is one, send.
 */
function RecommendSheet({
  friend,
  onClose,
  onSent,
}: {
  friend: Person;
  onClose: () => void;
  onSent: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<BookSummary[] | null>(null);
  const [picked, setPicked] = useState<BookSummary | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The library is searched as the query changes, a beat after typing stops.
  useEffect(() => {
    let alive = true;
    const q = query.trim();
    const timer = setTimeout(
      () => {
        api<{ books: BookSummary[] }>(`/api/library${q ? `?query=${encodeURIComponent(q)}` : ''}`)
          .then((res) => {
            if (alive) setResults(res.books);
          })
          .catch(() => {
            if (alive) setResults([]);
          });
      },
      q ? 200 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  const send = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/friends/recommend', {
        method: 'POST',
        body: { toUserId: friend.userId, bookId: picked.id, note: note.trim() || undefined },
      });
      toast.show(t('friends.recommend.sent', { title: picked.title, name: friend.displayName }));
      onSent();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'already-recommended'
          ? t('friends.recommend.already', { name: friend.displayName })
          : failureMessage(err, t('friends.recommend.failed'), t),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t('friends.recommend.title', { name: friend.displayName })} onClose={onClose}>
      {error && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} /> <bdi>{error}</bdi>
        </div>
      )}
      {!picked ? (
        <>
          <div className="friends-search">
            <IconSearch size={16} />
            <input
              className="input"
              type="search"
              value={query}
              placeholder={t('friends.recommend.search')}
              aria-label={t('friends.recommend.searchLabel')}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {results === null ? (
            <div className="skeleton" style={{ height: 120 }} />
          ) : results.length === 0 ? (
            <p className="friends-section__empty">{t('friends.recommend.noMatch')}</p>
          ) : (
            <>
              <ul className="friends-picklist">
                {results.slice(0, PICK_LIMIT).map((b) => (
                  <li key={b.id}>
                    <button type="button" className="friends-pick" onClick={() => setPicked(b)}>
                      <BookThumb book={b} />
                    </button>
                  </li>
                ))}
              </ul>
              {results.length > PICK_LIMIT && (
                <p className="hint friends-hint">
                  {t('friends.recommend.moreHint', { n: PICK_LIMIT })}
                </p>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div className="friends-pick friends-pick--chosen">
            <BookThumb book={picked} />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setPicked(null)}
            >
              {t('friends.recommend.change')}
            </button>
          </div>
          <NoteField value={note} onChange={setNote} />
          <button
            className="btn"
            style={{ width: '100%' }}
            disabled={busy}
            onClick={() => void send()}
          >
            {busy ? t('friends.recommend.sending') : t('friends.recommend.send')}
          </button>
        </>
      )}
    </Sheet>
  );
}

function BookThumb({ book }: { book: BookSummary }) {
  return (
    <>
      <span className="friends-pick__coverwrap" aria-hidden="true">
        <Cover book={book} className="friends-pick__cover" />
      </span>
      <span className="friends-pick__body">
        <span className="friends-pick__title" dir="auto">
          {book.title}
        </span>
        {book.author && (
          <span className="friends-pick__author" dir="auto">
            {book.author}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * "Recommend to a friend" from the book page: the book is known, so this
 * only asks who, and for a line to go with it.
 */
export function RecommendToFriendSheet({
  book,
  onClose,
}: {
  book: Pick<BookSummary, 'id' | 'title'>;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [to, setTo] = useState<Friend | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<FriendsData>('/api/friends')
      .then((d) => {
        if (!alive) return;
        setFriends(d.friends);
        // One friend is not a choice.
        if (d.friends.length === 1) setTo(d.friends[0]!);
      })
      .catch(() => {
        if (alive) setFriends([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const send = async () => {
    if (!to) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/friends/recommend', {
        method: 'POST',
        body: { toUserId: to.userId, bookId: book.id, note: note.trim() || undefined },
      });
      toast.show(t('friends.recommend.sent', { title: book.title, name: to.displayName }));
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'already-recommended'
          ? t('friends.recommend.already', { name: to.displayName })
          : failureMessage(err, t('friends.recommend.failed'), t),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t('friends.book.sheetTitle', { title: book.title })} onClose={onClose}>
      {error && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} /> <bdi>{error}</bdi>
        </div>
      )}
      {friends === null ? (
        <div className="skeleton" style={{ height: 96 }} />
      ) : friends.length === 0 ? (
        <>
          <p className="sheet__lede">{t('friends.book.noFriends')}</p>
          <Link className="btn btn--secondary" to="/friends" onClick={onClose}>
            {t('friends.book.openFriends')}
          </Link>
        </>
      ) : (
        <>
          <div className="field">
            <label id="friends-to-label">{t('friends.book.to')}</label>
            <ul className="friends-picklist" role="radiogroup" aria-labelledby="friends-to-label">
              {friends.map((fr) => (
                <li key={fr.userId}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={to?.userId === fr.userId}
                    className="friends-pick"
                    onClick={() => setTo(fr)}
                  >
                    <span className="friends-dot" style={dotStyle(fr.colour)} aria-hidden="true" />
                    <span className="friends-pick__body">
                      <span className="friends-pick__title">{fr.displayName}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <NoteField value={note} onChange={setNote} />
          <button
            className="btn"
            style={{ width: '100%' }}
            disabled={!to || busy}
            onClick={() => void send()}
          >
            {busy ? t('friends.recommend.sending') : t('friends.recommend.send')}
          </button>
        </>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------ book page */

/**
 * One quiet row under a book's hero: where friends are in it, and a way to
 * put it in front of one. Nothing at all for a reader with no friends -
 * this is the book's page, not a feed.
 */
export function BookFriendsRow({ book }: { book: Pick<BookSummary, 'id' | 'title'> }) {
  const t = useT();
  const f = useFormat();
  const [state, setState] = useState<{
    friends: FriendProgressEntry[];
    friendCount: number;
  } | null>(null);
  const [sheet, setSheet] = useState(false);

  useEffect(() => {
    let alive = true;
    setState(null);
    api<{ friends: FriendProgressEntry[]; friendCount: number }>(
      `/api/friends/progress?bookId=${encodeURIComponent(book.id)}`,
    )
      .then((r) => {
        if (alive) setState(r);
      })
      .catch(() => {
        // Offline, or a server without friends yet: the page is simply
        // without the row.
      });
    return () => {
      alive = false;
    };
  }, [book.id]);

  if (!state || (state.friends.length === 0 && state.friendCount === 0)) return null;
  return (
    <div className="friends-strip" role="group" aria-label={t('friends.book.label')}>
      <span className="friends-strip__label">{t('friends.book.label')}</span>
      {state.friends.map((e) => {
        const line = bookLine(e, f.percent);
        return (
          <span key={e.userId} className="friends-strip__entry">
            <span
              className="friends-dot friends-dot--sm"
              style={dotStyle(e.colour)}
              aria-hidden="true"
            />
            {t(line.key, line.values)}
          </span>
        );
      })}
      <button
        type="button"
        className="btn btn--ghost btn--sm friends-strip__cta"
        onClick={() => setSheet(true)}
      >
        {t('friends.book.recommend')}
      </button>
      {sheet && <RecommendToFriendSheet book={book} onClose={() => setSheet(false)} />}
    </div>
  );
}
