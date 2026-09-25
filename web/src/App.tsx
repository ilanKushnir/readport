import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  createBrowserRouter,
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
} from 'react-router-dom';
import { AUTO_SHELVES } from '@readport/shared';
import { SessionProvider, useSession } from './state/session';
import { I18nProvider, useT } from './i18n';
import { WhatsNew } from './whatsnew/WhatsNew';
import { DownloadsPill } from './components/DownloadsPill';
import { UpdateCard } from './components/UpdateCard';
import { resumeInterruptedDownloads } from './offline/downloads';
import { FriendsPage } from './pages/FriendsPage';
import { ShelvesProvider, useShelves } from './state/shelves';
import { FacetsProvider } from './state/facets';
import { Drawer, Sheet, ToastProvider, useSheetClose } from './components/ui';
import { Sidebar } from './components/Sidebar';
import {
  IconChevronRight,
  IconLibrary,
  IconLink,
  IconNotes,
  IconSettings,
  IconStats,
  IconPeople,
  IconShelf,
  ReadPortMark,
} from './components/icons';
import { startProgressLifecycle } from './progress/engine';
import { LoginPage } from './pages/AuthPages';
import { SetupWizard } from './pages/SetupWizard';
import { JoinPage } from './pages/JoinPage';
import { SharePage } from './pages/SharePage';
import { PeoplePage } from './pages/PeoplePage';
import { LibraryPage } from './pages/LibraryPage';
import { ReadingListPage } from './pages/ReadingListPage';
import { BookPage } from './pages/BookPage';
import { ReaderPage } from './reader/ReaderPage';
import { PlayerPage } from './player/PlayerPage';
import { StatsPage } from './pages/StatsPage';
import { NotesPage } from './pages/NotesPage';
import { NotesBookPage } from './pages/NotesBookPage';
import { NotesExportPage } from './pages/NotesExportPage';
import { PairsPage } from './pages/PairsPage';
import { SettingsPage } from './pages/SettingsPage';
import './styles/immersive.css';

/** Whether the rail is showing. Remembered per browser, like the theme. */
function useSidebarCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('rp-sidebar') === 'collapsed',
  );
  const set = useCallback((v: boolean) => {
    setCollapsed(v);
    try {
      localStorage.setItem('rp-sidebar', v ? 'collapsed' : 'shown');
    } catch {
      /* private browsing; the choice just does not persist */
    }
  }, []);
  return [collapsed, set];
}

/**
 * The one breakpoint the shell is built around, shared with base.css: from
 * 744px the rail has a column of its own, below it the shelves come in as an
 * overlay. 744 is an iPad mini held upright, which is a tablet and gets the
 * tablet shell. Keeping the number in one place on each side is what lets the
 * header button know which of the two it is offering.
 */
const RAIL_MQ = '(min-width: 744px)';

function useWideShell(): boolean {
  const [wide, setWide] = useState(
    () => typeof matchMedia === 'function' && matchMedia(RAIL_MQ).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(RAIL_MQ);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

/**
 * The shelf list, in whichever container this width calls for: the rail is
 * rendered in the layout grid, and this is the overlay the header button
 * opens - a drawer with room for it, a bottom sheet on a phone, which is the
 * object this app already uses for everything that slides in.
 */
function ShelfOverlay({
  onClose,
  closeRef,
  host,
}: {
  onClose: () => void;
  closeRef: React.RefObject<(() => void) | null>;
  /** The app's frame, which the tab bar is in too. */
  host: Element | null;
}) {
  const t = useT();
  const narrow = !useWideShell();
  return narrow ? (
    <Sheet title={t('nav.shelves')} onClose={onClose} docked closeRef={closeRef} host={host}>
      <SheetShelves />
    </Sheet>
  ) : (
    <Drawer title={t('nav.shelves')} onClose={onClose}>
      <Sidebar onNavigate={onClose} />
    </Drawer>
  );
}

/** The shelves in the phone's sheet: choosing one slides the sheet away as the shelf opens behind it. */
function SheetShelves() {
  const close = useSheetClose();
  return <Sidebar onNavigate={close ?? undefined} />;
}

/**
 * On a phone this opens the shelves as an overlay, because there is nowhere
 * to dock them. On a wide screen it only appears once the rail has been
 * hidden, and then it puts the rail BACK - the same place "Hide shelves"
 * took it from - rather than floating a copy over the library. Opening an
 * overlay there left the rail with no way home except a keyboard shortcut,
 * which an iPad does not have.
 */
function ShelfHeaderButton({
  wide,
  onOpen,
  onDock,
}: {
  wide: boolean;
  onOpen: () => void;
  onDock: () => void;
}) {
  const t = useT();
  const { overview } = useShelves();
  const location = useLocation();
  // The button doubles as a "you are here": on a phone the header is the only
  // place with room to say which shelf the grid belongs to.
  const current = (() => {
    const user = /^\/shelf\/u\/(.+)$/.exec(location.pathname);
    if (user) return overview?.shelves.find((s) => s.id === user[1])?.name ?? null;
    if (location.pathname === '/reading-list') return t('shelves.readingList');
    if (location.pathname === '/shelf/on-this-device') return t('shelves.on-this-device');
    if (location.pathname === '/shelf/hidden') return t('shelves.hidden');
    const facet = /^\/browse\/[a-z]+\/(.+)$/.exec(location.pathname);
    if (facet) return decodeURIComponent(facet[1]!);
    const auto = /^\/shelf\/([a-z-]+)$/.exec(location.pathname);
    const shelf = AUTO_SHELVES.find((s) => s.id === auto?.[1]);
    return shelf ? t(`shelves.${shelf.id}` as const) : null;
  })();
  if (wide) {
    return (
      <button
        className="btn btn--ghost app-header__shelves"
        onClick={onDock}
        title={t('nav.shelvesShortcut', { label: t('nav.showShelves') })}
      >
        <IconChevronRight size={17} />
        <span className="app-header__shelvesname">{t('nav.showShelves')}</span>
      </button>
    );
  }
  // On the plain library the tab bar's own Shelves entry is the way in; a
  // second "Shelves" in the header, a thumb's reach above it, said nothing.
  if (!current) return null;
  return (
    <button className="btn btn--ghost app-header__shelves" onClick={onOpen} aria-haspopup="dialog">
      <IconShelf size={18} />
      <span className="app-header__shelvesname">{current}</span>
    </button>
  );
}

function Shell() {
  const t = useT();
  const { phase, needsLibraries, friendsAttention, joinRequests } = useSession();
  // Pair suggestions waiting on a decision; counted for curators and admins only.
  const pairsToReview = useShelves().overview?.pairsToReview ?? 0;
  const location = useLocation();
  const [setupSkipped, setSetupSkipped] = useState(
    () => localStorage.getItem('rp-setup-libraries-skipped') === '1',
  );
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const [overlay, setOverlay] = useState(false);
  // The shelves sheet's own animated close, for the tab that opened it.
  const closeShelves = useRef<(() => void) | null>(null);
  const tabbar = useRef<HTMLElement>(null);
  const wide = useWideShell();
  const shell = useRef<HTMLDivElement>(null);
  const immersive = /^\/(read|listen)\//.test(location.pathname);

  // dvh follows browser chrome, but not every keyboard/visual viewport change.
  // Measure only the library shell; never resize the reader or fight pinch zoom.
  useLayoutEffect(() => {
    const el = shell.current;
    const viewport = window.visualViewport;
    if (!el || immersive || !viewport) return;
    // Set on the shell AND the root: sheets, drawers and toasts are
    // portaled to the body, outside the shell, and could not see a value
    // set only there - so the keyboard covered the bottom of the shelves
    // sheet and the list's last rows were unreachable until it closed.
    const root = document.documentElement;
    const update = () => {
      if (viewport.scale !== 1) {
        for (const node of [el, root]) {
          node.style.removeProperty('--app-viewport-height');
          node.style.removeProperty('--app-viewport-top');
        }
        return;
      }
      for (const node of [el, root]) {
        node.style.setProperty('--app-viewport-height', `${viewport.height}px`);
        node.style.setProperty('--app-viewport-top', `${viewport.offsetTop}px`);
      }
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      for (const node of [el, root]) {
        node.style.removeProperty('--app-viewport-height');
        node.style.removeProperty('--app-viewport-top');
      }
    };
  }, [immersive, phase, needsLibraries, setupSkipped]);

  useEffect(() => startProgressLifecycle(), []);

  // The tab bar's height, for the shelves sheet that stands on it.
  useLayoutEffect(() => {
    const bar = tabbar.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const set = () => root.style.setProperty('--tabbar-h', `${bar.offsetHeight}px`);
    set();
    const watch = new ResizeObserver(set);
    watch.observe(bar);
    return () => watch.disconnect();
  }, [immersive, phase, needsLibraries, setupSkipped]);

  // Going somewhere else - a tab, now within reach under the open shelves -
  // takes the shelves away with it.
  const shownAt = useRef(location.key);
  useEffect(() => {
    if (shownAt.current === location.key) return;
    shownAt.current = location.key;
    closeShelves.current?.();
  }, [location.key]);

  // A tab tapped on the page it opens takes that page back to its top, the
  // way a phone's tab bar does. Tapped from anywhere else, the page starts
  // at its top: the library, its shelves and its groupings are one page, and
  // the scroll used to carry over from whichever of them was open before.
  const topNext = useRef(false);
  const pane = () => shell.current?.querySelector<HTMLElement>('.app-body > .app-main') ?? null;
  const tabClick = (to: string) => () => {
    if (location.pathname !== to) {
      topNext.current = true;
      return;
    }
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    pane()?.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
  };
  useLayoutEffect(() => {
    if (!topNext.current) return;
    topNext.current = false;
    pane()?.scrollTo({ top: 0 });
  }, [location.key]);

  // What was being saved offline when the app was last closed carries on,
  // once there is a signed-in reader for it to belong to.
  useEffect(() => {
    if (phase === 'ready') void resumeInterruptedDownloads();
  }, [phase]);

  // `[` toggles the rail, which is why the collapse button says so.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLElement &&
        (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
      if (typing) return;
      setCollapsed(!collapsed);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [collapsed, setCollapsed]);

  if (phase === 'loading') {
    return (
      <div className="auth-page" aria-busy="true">
        <div className="spinner" role="status" aria-label={t('common.loading')} />
      </div>
    );
  }
  if (phase === 'setup') return <SetupWizard onDone={() => setSetupSkipped(true)} />;
  const join = /^\/join\/([A-Za-z0-9_-]+)$/.exec(location.pathname);
  // A share link opened without an account is the one page a stranger may
  // see: the book and the ways in, rather than the sign-in form.
  const share = /^\/s\/([A-Za-z0-9_-]+)$/.exec(location.pathname);
  if (phase === 'login') {
    if (join) return <JoinPage token={join[1]!} />;
    if (share) return <SharePage token={share[1]!} />;
    return <LoginPage />;
  }
  // Signed in as an admin with no libraries configured - finish setup. Behind
  // reverse-proxy SSO this is the first thing the first user ever sees.
  if (phase === 'ready' && needsLibraries && !setupSkipped) {
    return <SetupWizard mode="libraries" onDone={() => setSetupSkipped(true)} />;
  }
  // 'offline' still renders the app: downloaded titles remain readable, and
  // privileged actions surface their own errors until reconnect.

  const nav = (
    <>
      <NavLink to="/" end onClick={tabClick('/')}>
        <IconLibrary size={18} /> {t('nav.library')}
      </NavLink>
      <NavLink to="/notes" onClick={tabClick('/notes')}>
        <IconNotes size={18} /> {t('nav.notes')}
      </NavLink>
      {/* Stats and Pairing sit out of the phone tab bar: five tabs is what a
          narrow screen holds, and a phone has both at the top of the Shelves
          sheet instead. */}
      <NavLink to="/stats" className="nav-wide" onClick={tabClick('/stats')}>
        <IconStats size={18} /> {t('nav.stats')}
      </NavLink>
      <NavLink to="/friends" onClick={tabClick('/friends')}>
        <span className="nav-mark">
          <IconPeople size={18} />
          {friendsAttention > 0 && (
            <span className="nav-mark__dot" aria-label={t('nav.friendsAttention')} />
          )}
        </span>{' '}
        {t('nav.friends')}
      </NavLink>
      <NavLink to="/pairs" className="nav-wide" onClick={tabClick('/pairs')}>
        <span className="nav-mark">
          <IconLink size={18} />
          {pairsToReview > 0 && (
            <span
              className="nav-mark__dot"
              aria-label={t('nav.pairsToReview', { n: pairsToReview })}
            />
          )}
        </span>{' '}
        {t('nav.pairing')}
      </NavLink>
      <NavLink to="/settings" onClick={tabClick('/settings')}>
        <span className="nav-mark">
          <IconSettings size={18} />
          {joinRequests > 0 && (
            <span className="nav-mark__dot" aria-label={t('nav.joinRequests')} />
          )}
        </span>{' '}
        {t('nav.settings')}
      </NavLink>
    </>
  );

  return (
    <div ref={shell} className={`app-shell${collapsed ? ' is-railhidden' : ''}`}>
      {!immersive && (
        <>
          <a className="skip-link" href="#main-content">
            {t('common.skipToContent')}
          </a>
          <header className="app-header">
            <Link to="/" className="brand" aria-label={t('nav.home')}>
              <ReadPortMark size={26} style={{ color: 'var(--rp-primary)' }} />
              <span className="brand__name">{t('common.appName')}</span>
            </Link>
            <ShelfHeaderButton
              wide={wide}
              onOpen={() => setOverlay(true)}
              onDock={() => setCollapsed(false)}
            />
            <nav className="app-nav" aria-label={t('nav.primary')}>
              {nav}
            </nav>
          </header>
        </>
      )}
      {immersive ? (
        <Outlet />
      ) : (
        <div className="app-body">
          <div className="app-rail">
            <Sidebar onCollapse={() => setCollapsed(true)} />
          </div>
          <Outlet />
        </div>
      )}
      {overlay && !immersive && (
        <ShelfOverlay
          onClose={() => setOverlay(false)}
          closeRef={closeShelves}
          host={shell.current}
        />
      )}
      {/* Never over a book: an interruption is tolerable on the way in, and
          not at all once somebody is reading or listening. */}
      {!immersive && <WhatsNew />}
      {!immersive && <DownloadsPill />}
      {!immersive && <UpdateCard />}
      {!immersive && (
        <nav className="tabbar" aria-label={t('nav.primary')} ref={tabbar}>
          {/* Shelves is a button rather than a link because it opens the same
              overlay the header button does. On a phone the rail is not on
              screen, so without this the whole sidebar - shelves, the reading
              list, browsing by genre - has no way in. */}
          <button
            type="button"
            className="tabbar__shelves"
            // The same button closes them: on a phone the tab bar stays in
            // reach under the open shelves.
            onClick={() => {
              if (!overlay) setOverlay(true);
              else if (closeShelves.current) closeShelves.current();
              else setOverlay(false);
            }}
            aria-haspopup="dialog"
            aria-expanded={overlay}
          >
            <span className="tabbar__tile">
              <IconShelf size={18} />
            </span>{' '}
            {t('nav.shelves')}
          </button>
          {nav}
        </nav>
      )}
    </div>
  );
}

/**
 * A book's page, reader or player, made fresh for each book.
 *
 * The router keeps an element mounted when only its `:id` changes, so going
 * from one book straight to another - carrying on in the other language,
 * following a link between editions - kept everything the page held about
 * the first: an open sheet, a way back to one of its chapters, the paired
 * edition it had looked up. Keyed by the book, each is a new page.
 */
function PerBook({ page: Page }: { page: () => React.ReactNode }) {
  const { id = '' } = useParams();
  return <Page key={id} />;
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <LibraryPage /> },
      // The automatic shelves and the user's own shelves are both the library
      // page with a different source, so search, the format control and the
      // sort keep working inside a shelf.
      { path: '/shelf/u/:shelfId', element: <LibraryPage /> },
      { path: '/shelf/:autoShelf', element: <LibraryPage /> },
      // One value of one of the library's own groupings. Same page, same
      // search and sort - a genre is a shelf the library already had.
      { path: '/browse/:facetKind/:facetValue', element: <LibraryPage /> },
      { path: '/reading-list', element: <ReadingListPage /> },
      { path: '/book/:id', element: <PerBook page={BookPage} /> },
      { path: '/read/:id', element: <PerBook page={ReaderPage} /> },
      { path: '/listen/:id', element: <PerBook page={PlayerPage} /> },
      { path: '/notes', element: <NotesPage /> },
      { path: '/notes/:bookId', element: <NotesBookPage /> },
      { path: '/notes/:bookId/export', element: <NotesExportPage /> },
      { path: '/stats', element: <StatsPage /> },
      { path: '/friends', element: <FriendsPage /> },
      { path: '/pairs', element: <PairsPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/settings/people', element: <PeoplePage /> },
      { path: '/s/:token', element: <SharePage /> },
      { path: '*', element: <LibraryPage /> },
    ],
  },
]);

export function App() {
  return (
    <SessionProvider>
      <I18nProvider>
        <ToastProvider>
          <ShelvesProvider>
            <FacetsProvider>
              <RouterProvider router={router} />
            </FacetsProvider>
          </ShelvesProvider>
        </ToastProvider>
      </I18nProvider>
    </SessionProvider>
  );
}
