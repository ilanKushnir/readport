import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  type FacetGroup,
  type FacetKind,
  type SidebarPrefs,
  sidebarFacetsOf,
} from '@readport/shared';
import { api } from '../api/client';
import { useSession } from './session';

/**
 * The library's own groupings, and which of them this reader wants to see.
 *
 * Fetched once for the app, like the shelves beside them: two Sidebars are
 * mounted whenever the overlay is open, and a per-component fetch would
 * double every request for a list that changes only when the library is
 * rescanned.
 *
 * Two separate things live here on purpose. `groups` is what the library can
 * support - computed by the server from the books themselves, the same for
 * everyone. `prefs` is what one person chose to look at. Conflating them
 * would mean one reader hiding Narrators took it from everyone else.
 */

/**
 * What the library page is currently narrowed by, so the counts in the
 * sidebar can describe the rows in front of the reader rather than the whole
 * library. `ids` is for the one shelf the server cannot see - what this
 * browser downloaded. Null means "the whole library", which needs no request.
 */
export interface FacetScope {
  query?: string;
  kind?: 'ebook' | 'audio';
  filter?: string;
  ids?: string[];
}

interface FacetsCtx {
  /** Every grouping this library supports, with counts. */
  groups: FacetGroup[];
  /**
   * Counts for the current scope, keyed `kind:value`, or null when the whole
   * library is showing. A value absent from the map counts zero here.
   */
  scopedCounts: Map<string, number> | null;
  setScope: (scope: FacetScope | null) => void;
  /** The kinds to show, in order - the reader's choice, or the defaults. */
  shown: FacetKind[];
  /** False until the reader has saved a choice of their own. */
  chosen: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  save: (facets: FacetKind[]) => Promise<void>;
}

const EMPTY: FacetsCtx = {
  groups: [],
  scopedCounts: null,
  setScope: () => {},
  shown: [],
  chosen: false,
  loading: true,
  refresh: async () => {},
  save: async () => {},
};

/** The last groups this browser saw, so Browse survives being offline. */
const CACHE_KEY = 'rp-facets-cache';
function readCachedGroups(): FacetGroup[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as FacetGroup[]) : [];
  } catch {
    return [];
  }
}
function writeCachedGroups(groups: FacetGroup[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(groups));
  } catch {
    /* private mode */
  }
}

function scopeParams(scope: FacetScope): string {
  const params = new URLSearchParams();
  if (scope.query?.trim()) params.set('query', scope.query.trim());
  if (scope.kind) params.set('kind', scope.kind);
  if (scope.filter) params.set('filter', scope.filter);
  if (scope.ids) params.set('ids', scope.ids.slice(0, 400).join(','));
  return params.toString();
}

const Ctx = createContext<FacetsCtx>(EMPTY);
export const useFacets = () => useContext(Ctx);

export function FacetsProvider({ children }: { children: ReactNode }) {
  const { user, phase } = useSession();
  const [groups, setGroups] = useState<FacetGroup[]>(readCachedGroups);
  const [prefs, setPrefs] = useState<SidebarPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [scope, setScopeState] = useState<FacetScope | null>(null);
  const [scopedCounts, setScopedCounts] = useState<Map<string, number> | null>(null);
  const scopeKey = scope ? scopeParams(scope) : '';

  const refresh = useCallback(async () => {
    if (!user) {
      setGroups([]);
      setPrefs(null);
      setLoading(false);
      return;
    }
    try {
      const [f, p] = await Promise.all([
        api<{ groups: FacetGroup[] }>('/api/facets'),
        api<{ sidebar: SidebarPrefs }>('/api/prefs/sidebar'),
      ]);
      setGroups(f.groups);
      writeCachedGroups(f.groups);
      setPrefs(p.sidebar);
    } catch {
      // Offline, or a server one version behind that has neither endpoint.
      // The groups this browser last saw stand in: a genre still leads to
      // the library page, which falls back to what is downloaded.
      setGroups(readCachedGroups());
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Counts for the current view. The whole library needs no second request;
  // a search, a format or a shelf asks the server to count what it shows.
  useEffect(() => {
    if (!user || !scopeKey) {
      setScopedCounts(null);
      return;
    }
    let alive = true;
    void api<{ groups: FacetGroup[] }>(`/api/facets?${scopeKey}`)
      .then((res) => {
        if (!alive) return;
        const counts = new Map<string, number>();
        for (const g of res.groups)
          for (const v of g.values) counts.set(`${g.kind}:${v.value.toLowerCase()}`, v.count);
        setScopedCounts(counts);
      })
      .catch(() => {
        if (alive) setScopedCounts(null);
      });
    return () => {
      alive = false;
    };
  }, [user, scopeKey]);

  const setScope = useCallback((next: FacetScope | null) => {
    setScopeState((cur) => {
      const before = cur ? scopeParams(cur) : '';
      const after = next ? scopeParams(next) : '';
      return before === after ? cur : next;
    });
  }, []);

  useEffect(() => {
    if (phase === 'loading') return;
    void refresh();
  }, [refresh, phase]);

  const save = useCallback(async (facets: FacetKind[]) => {
    const next: SidebarPrefs = { facets, chosen: true };
    setPrefs(next); // optimistic: the sidebar redraws before the round trip
    try {
      await api<{ sidebar: SidebarPrefs }>('/api/prefs/sidebar', { method: 'PUT', body: next });
    } catch {
      // Left as chosen locally rather than snapping back mid-edit; the next
      // load reads the server's answer.
    }
  }, []);

  const value = useMemo<FacetsCtx>(() => {
    // Only kinds this library can actually support, in the reader's order. A
    // stored preference for Narrators survives a library that has none: it is
    // filtered out of the display but stays in the saved list, so it comes
    // back on its own the day an audiobook arrives with a narrator tag.
    const available = groups.map((g) => g.kind);
    return {
      groups,
      scopedCounts,
      setScope,
      shown: sidebarFacetsOf(prefs, available),
      chosen: prefs?.chosen ?? false,
      loading,
      refresh,
      save,
    };
  }, [groups, scopedCounts, setScope, prefs, loading, refresh, save]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
