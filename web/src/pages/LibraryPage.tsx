import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import {
  AUTO_SHELVES,
  type AutoShelfId,
  type BookSummary,
  type FacetKind,
  facetSpec,
  formatFacet,
  isFacetKind,
} from '@readport/shared';
import { api, ApiError } from '../api/client';
import { useShelves } from '../state/shelves';
import { useFacets } from '../state/facets';
import { languageListName } from '../lib/languageName';
import { ReadingNow } from './ReadingNow';
import { AddToSheet } from '../components/AddToSheet';
import { Cover, EmptyState } from '../components/ui';
import {
  IconAlert,
  IconBookOpen,
  IconDownload,
  IconHeadphones,
  IconLibrary,
  IconLink,
  IconList,
  IconOffline,
  IconPlay,
  IconPlus,
  IconSearch,
  IconShelf,
} from '../components/icons';
import { formatBytes, formatDuration, formatPct } from '../lib/format';
import {
  cachedBookSummary,
  cancelDownload,
  downloadPercent,
  listDownloads,
  startDownload,
  type DownloadState,
} from '../offline/downloads';

type Kind = 'all' | 'ebook' | 'audio';
type Sort = 'title' | 'author' | 'recent' | 'added';

interface LibraryData {
  books: BookSummary[];
  /**
   * The Continue band, most recently touched first. Whole summaries rather
   * than ids into `books`: the grid collapses a pair to one card, and the
   * edition in progress is not always the one the card stands for.
   */
  continueRail: BookSummary[];
  scanActive: boolean;
}

/** Which shelf this page is showing, worked out from the route. */
type Showing =
  | { kind: 'library' }
  | { kind: 'auto'; id: AutoShelfId }
  | { kind: 'device' }
  | { kind: 'user'; id: string }
  /** One value of one of the library's own groupings - a genre, a narrator. */
  | { kind: 'facet'; facet: FacetKind; value: string };

const AUTO_IDS = AUTO_SHELVES.map((s) => s.id) as string[];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function LibraryPage() {
  const params = useParams();
  const { overview, refresh, refreshDownloads } = useShelves();
  const { setScope } = useFacets();
  const showing = useMemo<Showing>(() => {
    if (params.shelfId) return { kind: 'user', id: params.shelfId };
    if (params.facetKind && params.facetValue && isFacetKind(params.facetKind)) {
      return { kind: 'facet', facet: params.facetKind, value: params.facetValue };
    }
    if (params.autoShelf === 'on-this-device') return { kind: 'device' };
    if (params.autoShelf && AUTO_IDS.includes(params.autoShelf)) {
      return { kind: 'auto', id: params.autoShelf as AutoShelfId };
    }
    return { kind: 'library' };
  }, [params.shelfId, params.autoShelf, params.facetKind, params.facetValue]);

  const [data, setData] = useState<LibraryData | null>(null);
  const [shelfName, setShelfName] = useState<string | null>(null);
  const [missingCount, setMissingCount] = useState(0);
  /** This shelf answered 404: it was removed, here or on another device. */
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offlineBooks, setOfflineBooks] = useState<BookSummary[] | null>(null);
  /** What this device is fetching right now - shown on the On-this-device shelf. */
  const [active, setActive] = useState<DownloadState[]>([]);
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 220);
  const [kind, setKind] = useState<Kind>('all');
  const [sort, setSort] = useState<Sort>('title');
  const [addTo, setAddTo] = useState<BookSummary | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestSeq = useRef(0);
  const chipsRef = useRef<HTMLElement>(null);

  const shelfKey =
    showing.kind === 'library'
      ? 'library'
      : showing.kind === 'facet'
        ? `facet:${showing.facet}:${showing.value}`
        : `${showing.kind}:${'id' in showing ? showing.id : ''}`;

  // Arriving at a different shelf starts fresh. Inside "Recently added" the
  // point IS recency, and Reading Now is defined as most recent first, so
  // those two start on their own order rather than on the alphabet.
  useEffect(() => {
    setData(null);
    setOfflineBooks(null);
    setSort(
      shelfKey === 'auto:recently-added'
        ? 'added'
        : shelfKey === 'auto:reading-now'
          ? 'recent'
          : 'title',
    );
    setQuery('');
    setKind('all');
  }, [shelfKey]);

  // The chip you are on must be the chip you can see; a row that scrolls
  // sideways can otherwise hide the answer to "where am I".
  useEffect(() => {
    chipsRef.current
      ?.querySelector('.is-current')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [shelfKey, overview?.shelves.length]);

  const loadDownloads = useCallback(async () => {
    const list = await listDownloads();
    setDownloaded(new Set(list.filter((d) => d.status === 'done').map((d) => d.bookId)));
    setActive(
      list
        .filter((d) => d.status === 'downloading' || d.status === 'error')
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    );
    return list;
  }, []);

  // The sidebar's counts describe this view: a search, a format, a progress
  // shelf, or - for the one shelf the server cannot see - the downloads here.
  useEffect(() => {
    const q = debouncedQuery.trim();
    const k = kind === 'all' ? undefined : kind;
    if (showing.kind === 'device') {
      setScope({ query: q || undefined, kind: k, ids: [...downloaded] });
      return;
    }
    if (showing.kind === 'auto' || q || k) {
      setScope({
        query: q || undefined,
        kind: k,
        filter: showing.kind === 'auto' ? showing.id : undefined,
      });
      return;
    }
    setScope(null);
  }, [showing, debouncedQuery, kind, downloaded, setScope]);
  useEffect(() => () => setScope(null), [setScope]);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      setGone(false);
      if (showing.kind === 'user') {
        const res = await api<{
          shelf: { name: string };
          books: BookSummary[];
          missingCount: number;
        }>(`/api/shelves/${showing.id}/books?sort=${sort === 'recent' ? 'manual' : sort}`);
        if (seq !== requestSeq.current) return;
        setShelfName(res.shelf.name);
        setMissingCount(res.missingCount);
        setData({ books: res.books, continueRail: [], scanActive: false });
        setError(null);
        setOfflineBooks(null);
        return;
      }
      const params = new URLSearchParams();
      if (debouncedQuery.trim()) params.set('query', debouncedQuery.trim());
      if (kind !== 'all') params.set('kind', kind);
      if (showing.kind === 'auto') params.set('filter', showing.id);
      if (showing.kind === 'facet') params.set('facet', formatFacet(showing.facet, showing.value));
      // What this browser downloaded is decided here, not by the server, and
      // a downloaded audiobook must not vanish behind its undownloaded ebook.
      if (showing.kind === 'device') params.set('collapse', 'none');
      params.set('sort', sort);
      const res = await api<LibraryData>(`/api/library?${params}`);
      if (seq !== requestSeq.current) return;
      setData(res);
      setShelfName(null);
      setMissingCount(0);
      setError(null);
      setOfflineBooks(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      if (showing.kind === 'auto' && showing.id === 'reading-now') {
        // An unavailable filtered shelf must never masquerade as the whole library.
        setData(null);
        setOfflineBooks([]);
        setError(
          'Reading Now could not be refreshed. Reconnect and retry; your progress is kept on this device.',
        );
        return;
      }
      // A shelf that is not there is not a connection problem. Deleting a
      // shelf on another device used to leave this page telling you to check
      // the server.
      if (showing.kind === 'user' && err instanceof ApiError && err.status === 404) {
        setGone(true);
        setData({ books: [], continueRail: [], scanActive: false });
        setShelfName(null);
        setMissingCount(0);
        setError(null);
        setOfflineBooks(null);
        return;
      }
      // Offline (or server down): fall back to the titles downloaded into
      // this browser, read entirely from local storage.
      const list = await loadDownloads();
      const summaries = await Promise.all(
        list.filter((d) => d.status === 'done').map((d) => cachedBookSummary(d.bookId)),
      );
      const books = summaries.filter((b): b is BookSummary => !!b);
      setOfflineBooks(books);
      setError(
        books.length > 0
          ? 'You appear to be offline. Showing the titles downloaded to this device.'
          : 'Could not load the library. Check the server connection.',
      );
    }
  }, [debouncedQuery, kind, sort, showing, loadDownloads]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadDownloads();
  }, [loadDownloads]);

  // A download writes its progress to IndexedDB as each chunk lands, but it is
  // usually started from another page (or another tab), so nothing here is
  // told about it. Poll while any download is running - and once after it
  // stops, to pick up the finished state - then go quiet.
  useEffect(() => {
    if (active.length === 0) return;
    const t = setInterval(() => void loadDownloads(), 1000);
    return () => clearInterval(t);
  }, [active.length, loadDownloads]);

  // Poll while a scan is active so states progress live.
  useEffect(() => {
    if (data?.scanActive && !pollRef.current) {
      pollRef.current = setInterval(() => void load(), 2500);
    } else if (!data?.scanActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [data?.scanActive, load]);

  // A download in flight is not in any list yet, so its title has to come
  // from whatever is already loaded, or from the copy the download itself has
  // just cached. Until either exists the row still shows, unnamed - knowing
  // something is downloading matters more than knowing what.
  const [cachedTitles, setCachedTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    void (async () => {
      const found: Record<string, string> = {};
      for (const d of active) {
        if (cachedTitles[d.bookId]) continue;
        const b = await cachedBookSummary(d.bookId);
        if (b) found[d.bookId] = b.title;
      }
      if (alive && Object.keys(found).length) setCachedTitles((t) => ({ ...t, ...found }));
    })();
    return () => {
      alive = false;
    };
  }, [active, cachedTitles]);

  const titleFor = useCallback(
    (bookId: string) =>
      data?.books.find((b) => b.id === bookId)?.title ??
      offlineBooks?.find((b) => b.id === bookId)?.title ??
      cachedTitles[bookId] ??
      null,
    [data, offlineBooks, cachedTitles],
  );

  const books = useMemo(() => {
    let source = data?.books ?? offlineBooks ?? [];
    // The one shelf the server cannot answer: what is downloaded lives in
    // this browser, so the filtering happens here and nowhere else.
    if (showing.kind === 'device') source = source.filter((b) => downloaded.has(b.id));
    if (showing.kind === 'user' || showing.kind === 'device') {
      const needle = debouncedQuery.trim().toLowerCase();
      if (needle) {
        source = source.filter(
          (b) =>
            b.title.toLowerCase().includes(needle) ||
            (b.author ?? '').toLowerCase().includes(needle) ||
            (b.series ?? '').toLowerCase().includes(needle),
        );
      }
      if (kind !== 'all') source = source.filter((b) => b.kind === kind);
    }
    return source;
  }, [data, offlineBooks, showing, downloaded, debouncedQuery, kind]);

  const continueBooks = data?.continueRail ?? [];
  const hero = continueBooks[0] ?? null;
  const rail = continueBooks.slice(1);
  const showContinue =
    showing.kind === 'library' && kind === 'all' && !query && continueBooks.length > 0;
  // The band shows the eight most recent; the number beside "All in progress"
  // is how many there are, which is what the sidebar already counts.
  const readingNowCount =
    overview?.auto.find((a) => a.id === 'reading-now')?.count ?? continueBooks.length;

  const stats = useMemo(() => {
    const all = data?.books ?? [];
    return {
      ebooks: all.filter((b) => b.kind === 'ebook').length,
      audio: all.filter((b) => b.kind === 'audio').length,
      paired: all.filter((b) => b.pair && b.pair.status !== 'candidate').length / 2,
    };
  }, [data]);

  const heading =
    showing.kind === 'user'
      ? gone
        ? 'Shelf removed'
        : (shelfName ?? 'Shelf')
      : showing.kind === 'device'
        ? 'On this device'
        : showing.kind === 'auto'
          ? AUTO_SHELVES.find((s) => s.id === showing.id)!.label
          : showing.kind === 'facet'
            ? showing.facet === 'language'
              ? languageListName(showing.value)
              : showing.value
            : 'Library';

  const showChips = showing.kind !== 'library' || (overview?.shelves.length ?? 0) > 0;
  const chips = [
    { to: '/', label: 'Library', end: true },
    { to: '/reading-list', label: 'Reading list', end: false },
    ...AUTO_SHELVES.map((s) => ({ to: `/shelf/${s.id}`, label: s.label, end: false })),
    { to: '/shelf/on-this-device', label: 'On this device', end: false },
    ...(overview?.shelves ?? []).map((s) => ({
      to: `/shelf/u/${s.id}`,
      label: s.name,
      end: false,
    })),
  ];

  return (
    <main className="app-main" id="main-content" tabIndex={-1}>
      <h1 className="visually-hidden">{heading}</h1>

      {/* Moving between shelves on a narrow screen: a swipe and a tap, no
          sheet. A reader with no shelves is not taxed with a control that
          does nothing yet. */}
      {showChips && (
        <nav className="shelf-chips chip-row" aria-label="Shelves" ref={chipsRef}>
          {chips.map((c) => (
            <NavLink
              key={c.to}
              to={c.to}
              end={c.end}
              className={({ isActive }) => `chip${isActive ? ' is-current' : ''}`}
            >
              {c.label}
            </NavLink>
          ))}
        </nav>
      )}

      {error && (
        <div className={`banner ${offlineBooks ? '' : 'banner--error'}`} role="alert">
          {offlineBooks ? <IconOffline size={18} /> : <IconAlert size={18} />}
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn--ghost btn--tight" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {missingCount > 0 && (
        <div className="banner" role="note">
          <IconAlert size={16} />
          {missingCount === 1
            ? '1 book on this shelf is on a drive that is not mounted.'
            : `${missingCount} books on this shelf are on a drive that is not mounted.`}
        </div>
      )}

      {showContinue && hero && (
        <section className="band band--continue" aria-labelledby="continue-h">
          <div className="band__head">
            <h2 id="continue-h" className="band__title">
              Continue
            </h2>
            {readingNowCount > 1 && (
              <Link className="band__more" to="/shelf/reading-now">
                All in progress · {readingNowCount}
              </Link>
            )}
          </div>
          <HeroCard book={hero} />
          {rail.length > 0 && (
            <div className="continue-rail">
              {rail.map((b) => (
                <ContinueCard key={b.id} book={b} />
              ))}
            </div>
          )}
        </section>
      )}

      <section className="band band--library" aria-labelledby="library-h">
        <div className="band__head">
          <h2 id="library-h" className="band__title">
            {heading}
            {books.length > 0 && <span className="section-title__count">{books.length}</span>}
          </h2>
          {showing.kind === 'library' && kind === 'all' && !query && data && (
            <span className="band__stats">
              {stats.ebooks} ebooks · {stats.audio} audiobooks
              {stats.paired > 0 ? ` · ${Math.round(stats.paired)} paired` : ''}
            </span>
          )}
        </div>
        {/* Nothing to search, filter or sort on a shelf that is not there. */}
        {gone ? null : (
          <div className="toolbar">
            <div className="searchbox">
              <IconSearch size={17} />
              <input
                className="input"
                type="search"
                placeholder="Search title, author, series"
                aria-label="Search this shelf"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="segmented segmented--inline" role="group" aria-label="Library type">
              <button aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
                All
              </button>
              <button aria-pressed={kind === 'ebook'} onClick={() => setKind('ebook')}>
                <IconBookOpen size={15} /> Ebooks
              </button>
              <button aria-pressed={kind === 'audio'} onClick={() => setKind('audio')}>
                <IconHeadphones size={15} /> Audiobooks
              </button>
            </div>
            <label className="visually-hidden" htmlFor="lib-sort">
              Sort by
            </label>
            <select
              id="lib-sort"
              className="input input--select"
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
            >
              <option value="title">By title</option>
              <option value="author">By author</option>
              <option value="recent">
                {showing.kind === 'user' ? 'Shelf order' : 'Recently active'}
              </option>
              <option value="added">Recently added</option>
            </select>
          </div>
        )}

        {data?.scanActive && (
          <div className="banner" role="status" style={{ marginBlockStart: 'var(--sp-4)' }}>
            <div className="spinner" style={{ width: 16, height: 16 }} />
            Scanning your libraries - new books appear as they are indexed.
          </div>
        )}

        {showing.kind === 'device' && active.length > 0 && (
          <DownloadsInProgress
            active={active}
            titleFor={titleFor}
            onChanged={() => void loadDownloads()}
          />
        )}

        {!data && !offlineBooks ? (
          <div className="book-grid" aria-busy="true" style={{ marginBlockStart: 'var(--sp-5)' }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i}>
                <div className="skeleton" style={{ aspectRatio: '2/3' }} />
              </div>
            ))}
          </div>
        ) : showing.kind === 'auto' && showing.id === 'reading-now' && !data ? (
          // The one shelf the server has to answer: what is in progress is
          // progress state, and the downloaded titles this browser holds
          // are not the same list. Saying "nothing here yet" under a banner
          // that says the shelf could not be fetched contradicted itself.
          <EmptyState icon={<IconOffline size={40} />} title="Reading Now needs the server">
            Your place in every book is kept on this device and will sync when you are back online.
            Downloaded titles are on the On this device shelf.
          </EmptyState>
        ) : books.length === 0 ? (
          <ShelfEmpty
            showing={showing}
            filtered={!!query || kind !== 'all'}
            gone={gone}
            scanning={data?.scanActive ?? false}
          />
        ) : showing.kind === 'auto' && showing.id === 'reading-now' ? (
          <ReadingNow
            books={books}
            onReset={(id) => {
              requestSeq.current++;
              setData((current) =>
                current
                  ? { ...current, books: current.books.filter((book) => book.id !== id) }
                  : current,
              );
              void refresh();
            }}
          />
        ) : (
          <div className="book-grid">
            {books.map((b) => (
              <BookCard
                key={b.id}
                book={b}
                offline={downloaded.has(b.id)}
                onAddTo={() => setAddTo(b)}
              />
            ))}
          </div>
        )}
      </section>

      {addTo && (
        <AddToSheet
          bookId={addTo.id}
          title={addTo.title}
          onClose={() => setAddTo(null)}
          onChanged={() => {
            void refreshDownloads();
            if (showing.kind === 'user') void load();
          }}
        />
      )}
    </main>
  );
}

function ShelfEmpty({
  showing,
  filtered,
  gone,
  scanning,
}: {
  showing: Showing;
  filtered: boolean;
  gone: boolean;
  scanning: boolean;
}) {
  if (scanning) {
    // The first screen after setup. Telling the operator to go and configure
    // the folders they configured thirty seconds ago reads as though the
    // wizard did not work.
    return (
      <EmptyState icon={<IconLibrary size={44} />} title="Reading your shelves">
        ReadPort is going through your folders. Books appear here as it finds them.
      </EmptyState>
    );
  }
  if (gone) {
    return (
      <EmptyState
        icon={<IconShelf size={40} />}
        title="That shelf is no longer here"
        action={
          <Link className="btn" to="/">
            Back to the library
          </Link>
        }
      >
        It was removed - on this device or another one. The books that were on it are all still in
        your library.
      </EmptyState>
    );
  }
  if (filtered) {
    return (
      <EmptyState icon={<IconSearch size={40} />} title="No matches">
        Nothing here matches this search or filter.
      </EmptyState>
    );
  }
  if (showing.kind === 'device') {
    return (
      <EmptyState icon={<IconOffline size={40} />} title="Nothing downloaded in this browser">
        Downloads stay on the device that made them and are removed when you sign out. Open a book
        and choose Download to keep it here.
      </EmptyState>
    );
  }
  if (showing.kind === 'user') {
    return (
      <EmptyState
        icon={<IconShelf size={40} />}
        title="This shelf is empty"
        action={
          <Link className="btn" to="/">
            Browse the library
          </Link>
        }
      >
        Press the + on any cover in the library, then pick this shelf.
      </EmptyState>
    );
  }
  if (showing.kind === 'facet') {
    return (
      <EmptyState
        icon={<IconLibrary size={40} />}
        title={`Nothing under ${showing.facet === 'language' ? languageListName(showing.value) : showing.value}`}
        action={
          <Link className="btn" to="/">
            Browse the library
          </Link>
        }
      >
        {facetSpec(showing.facet).label} come from the books themselves, so this one goes away when
        the last book carrying it does.
      </EmptyState>
    );
  }
  if (showing.kind === 'auto') {
    const copy: Record<AutoShelfId, string> = {
      'reading-now':
        'Start reading or listening and that edition appears here until you finish it.',
      finished: 'Books you read to the end collect here on their own.',
      'both-formats':
        'This fills up as ReadPort matches an ebook to its audiobook. The Pairing page shows what it is considering.',
      'recently-added': 'Nothing new has turned up in the last month.',
    };
    return (
      <EmptyState
        icon={showing.id === 'both-formats' ? <IconLink size={40} /> : <IconList size={40} />}
        title="Nothing here yet"
      >
        {copy[showing.id]}
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={<IconLibrary size={44} />} title="Your library is empty">
      ReadPort reads ebook and audiobook folders you already have, and never writes to them. Choose
      those folders in Settings → Libraries; each one is tested before it is saved.
    </EmptyState>
  );
}

function HeroCard({ book }: { book: BookSummary }) {
  const pct = book.progress?.pct ?? 0;
  const isEbook = book.kind === 'ebook';
  const primaryTo = isEbook ? `/read/${book.id}` : `/listen/${book.id}`;
  const pair = book.pair && book.pair.status !== 'candidate' ? book.pair : null;
  return (
    <div className="hero-card">
      <Link
        to={`/book/${book.id}`}
        className="hero-card__cover"
        aria-label={`${book.title} details`}
      >
        <Cover book={book} className="hero-card__img" />
      </Link>
      <div className="hero-card__body">
        <div className="hero-card__eyebrow">
          {isEbook ? <IconBookOpen size={14} /> : <IconHeadphones size={14} />}
          {isEbook ? 'Continue reading' : 'Continue listening'}
        </div>
        <h2 className="hero-card__title">{book.title}</h2>
        {book.author && <div className="hero-card__author">{book.author}</div>}
        <div className="hero-card__progress">
          <span className="progressbar" aria-hidden="true">
            <span style={{ width: `${pct * 100}%` }} />
          </span>
          <span className="hero-card__pct">
            {formatPct(pct)}
            {!isEbook && book.durationMs
              ? ` · ${formatDuration(book.durationMs * (1 - pct))} left`
              : ''}
          </span>
        </div>
        <div className="hero-card__actions">
          <Link className="btn" to={primaryTo}>
            {isEbook ? <IconBookOpen size={18} /> : <IconPlay size={18} />}
            {isEbook ? 'Resume reading' : 'Resume listening'}
          </Link>
          {pair && (
            <Link
              className="btn btn--secondary"
              to={`/book/${book.id}?switch=1`}
              title={
                pair.switchable
                  ? 'Continue in the other edition at the same place'
                  : 'The other edition of this book'
              }
            >
              {isEbook ? <IconHeadphones size={17} /> : <IconBookOpen size={17} />}
              {isEbook ? 'Listen instead' : 'Read instead'}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function ContinueCard({ book }: { book: BookSummary }) {
  const pct = book.progress?.pct ?? 0;
  return (
    <Link
      className="continue-card"
      to={book.kind === 'ebook' ? `/read/${book.id}` : `/listen/${book.id}`}
    >
      <span className="continue-card__cover">
        <Cover book={book} className="continue-card__img" />
      </span>
      <span className="continue-card__body">
        <span className="continue-card__title">{book.title}</span>
        <span className="continue-card__meta">
          {book.kind === 'ebook' ? <IconBookOpen size={12} /> : <IconHeadphones size={12} />}
          {formatPct(pct)}
          {book.kind === 'audio' && book.durationMs
            ? ` · ${formatDuration(book.durationMs * (1 - pct))} left`
            : ''}
        </span>
        <span className="progressbar" aria-hidden="true">
          <span style={{ width: `${pct * 100}%` }} />
        </span>
      </span>
    </Link>
  );
}

/**
 * The card is a positioned wrapper with the link and the shelf button as
 * SIBLINGS. A button inside an anchor is invalid and swallows the keyboard,
 * so the plus cannot live inside the Link no matter how convenient that is.
 */
/**
 * What this device is fetching, on the shelf that claims to show what is on
 * this device.
 *
 * A download runs for minutes over a phone connection and there was nowhere to
 * watch it: the only sign was a ring on the book's own page, so leaving that
 * page meant losing sight of it entirely. Progress is in bytes, which is the
 * only measure that moves steadily on an audiobook of three enormous tracks.
 */
function DownloadsInProgress({
  active,
  titleFor,
  onChanged,
}: {
  active: DownloadState[];
  titleFor: (bookId: string) => string | null;
  onChanged: () => void;
}) {
  return (
    <section className="dls" aria-label="Downloads in progress">
      <h2 className="dls__h">
        <IconDownload size={15} />
        {active.some((d) => d.status === 'downloading')
          ? `Downloading ${active.filter((d) => d.status === 'downloading').length}`
          : 'Downloads'}
      </h2>
      <ul className="dls__list">
        {active.map((d) => {
          const failed = d.status === 'error';
          const pct = downloadPercent(d);
          return (
            <li key={d.bookId} className={`dls__row ${failed ? 'is-bad' : ''}`}>
              <div className="dls__meta">
                <Link className="dls__title" to={`/book/${d.bookId}`}>
                  {titleFor(d.bookId) ?? (failed ? 'Interrupted download' : 'Starting…')}
                </Link>
                <span className="dls__sub">
                  {failed
                    ? (d.error ?? 'Download failed')
                    : d.estimatedBytes > 0
                      ? `${formatBytes(d.storedBytes)} of ${formatBytes(d.estimatedBytes)} · ${pct}%`
                      : 'Starting…'}
                </span>
                {!failed && (
                  <div
                    className="progressbar dls__bar"
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span style={{ width: `${Math.max(2, pct)}%` }} />
                  </div>
                )}
              </div>
              <button
                className="btn btn--ghost dls__act"
                onClick={() => {
                  if (failed) void startDownload(d.bookId, () => onChanged()).then(onChanged);
                  else {
                    cancelDownload(d.bookId);
                    onChanged();
                  }
                }}
              >
                {failed ? 'Retry' : 'Stop'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One format inside the badge: EPUB, M4B, MP3, or AUDIO for a folder of files. */
function FormatPart({ kind, format }: { kind: BookSummary['kind']; format: string }) {
  const label =
    kind === 'ebook'
      ? (format || 'epub').toUpperCase()
      : !format || format === 'multi'
        ? 'AUDIO'
        : format.toUpperCase();
  return (
    <>
      {kind === 'ebook' ? <IconBookOpen size={11} /> : <IconHeadphones size={11} />}
      {label}
    </>
  );
}

function BookCard({
  book,
  offline,
  onAddTo,
}: {
  book: BookSummary;
  offline: boolean;
  onAddTo: () => void;
}) {
  const stateNote =
    book.scanState === 'error'
      ? 'Indexing failed'
      : book.scanState === 'indexing' || book.scanState === 'discovered'
        ? 'Indexing…'
        : null;
  const pair = book.pair && book.pair.status !== 'candidate' ? book.pair : null;
  return (
    // Two format badges wrap to a second row on a phone-width cover, which
    // lands on top of the placeholder title. Only these cards need the extra
    // clearance, so only these cards pay for it.
    <div className={`book-card ${pair ? 'book-card--multiformat' : ''}`}>
      <Link className="book-card__link" to={`/book/${book.id}`}>
        <span className="book-card__coverwrap">
          <Cover book={book} className="book-card__cover" />
          <span className="book-card__badges">
            {/* One card per title, so one badge naming every format it is
                owned in. Two separate pills read as two books - which is the
                thing this card exists to stop - and stacked on a phone they
                cover the artwork twice over. */}
            <span className={`badge ${!pair && book.kind === 'audio' ? 'badge--audio' : ''}`}>
              <FormatPart kind={book.kind} format={book.format} />
              {pair && (
                <>
                  <span className="badge__sep" aria-hidden="true" />
                  <FormatPart kind={pair.otherKind} format={pair.otherFormat} />
                </>
              )}
            </span>
            {pair?.switchable && (
              <span
                className="badge badge--paired badge--sync"
                title="Synced - switching lands in the same place"
              >
                <IconLink size={11} />
                SYNC
              </span>
            )}
          </span>
          {offline && (
            <span className="book-card__offline" title="Downloaded to this device">
              <IconDownload size={12} />
            </span>
          )}
          {book.progress && book.progress.pct > 0.001 && !book.progress.finished && (
            <span className="book-card__progress" aria-hidden="true">
              <span style={{ width: `${book.progress.pct * 100}%` }} />
            </span>
          )}
          {book.progress?.finished && <span className="book-card__done">Finished</span>}
        </span>
        <span>
          <span className="book-card__title">{book.title}</span>
          <span className="book-card__author" style={{ display: 'block' }}>
            {stateNote ?? book.author ?? ' '}
          </span>
        </span>
      </Link>
      <button
        className="book-card__add"
        onClick={onAddTo}
        aria-label={`Add ${book.title} to a shelf or your reading list`}
        title="Add to…"
      >
        <IconPlus size={17} />
      </button>
    </div>
  );
}
