import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LANGUAGES, type Settings } from '@readport/shared';
import { api, failureMessage } from '../api/client';
import { type BookSummary, type PairDto, type ProcessingSummary } from '../lib/types';
import { Cover, EmptyState, Sheet, useToast } from '../components/ui';
import { useSession } from '../state/session';
import {
  IconAlert,
  IconBookOpen,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconDownload,
  IconHeadphones,
  IconLink,
  IconSearch,
  IconSwitch,
} from '../components/icons';
import { formatDuration } from '../lib/format';
import { PipelineDiagram, ProcessingQueue } from '../components/Processing';
import { bucketCoverage } from '../lib/coverageBars';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { type MessageKey } from '../i18n/messages/en';
import './pairs.css';

/**
 * The Pairing page.
 *
 * Four tabs, because a pair is in one of four situations and each asks a
 * different question of the reader: Suggested wants a yes or no, Linked
 * shows where alignment stands and offers to start it, Unpaired lists the
 * books still without a partner, Dismissed keeps the noes in case of a
 * change of mind. Within a tab, one compact row per pair - covers, title,
 * its state in a chip, the coverage strip once aligned, and only the one
 * action that state calls for. Everything else - evidence, narration
 * language, the full alignment report, unlinking - opens under the row.
 */

type PairAction = 'confirm' | 'reject' | 'unlink' | 'align';
type Tab = 'suggested' | 'linked' | 'unpaired' | 'dismissed';
type LinkedFilter = 'all' | 'attention' | 'ready' | 'aligned';

/** Where a pair is, said once, in the order a reader has to care about. */
type RowState =
  'aligning' | 'queued' | 'model' | 'failed' | 'ready' | 'aligned' | 'suggested' | 'dismissed';

const STATE_ORDER: Record<RowState, number> = {
  aligning: 0,
  queued: 1,
  model: 2,
  failed: 3,
  ready: 4,
  aligned: 5,
  suggested: 6,
  dismissed: 7,
};

const TABS: Tab[] = ['suggested', 'linked', 'unpaired', 'dismissed'];
const FILTERS: LinkedFilter[] = ['all', 'attention', 'ready', 'aligned'];

/**
 * Two outcomes, not two settings - the same pair of choices Settings offers,
 * worded for the moment you are about to start a queue.
 */
const ACCURACY: [Settings['alignPrecision'], MessageKey, MessageKey][] = [
  ['standard', 'pairs.work.precision.standard', 'pairs.work.precision.standardBlurb'],
  ['exact', 'pairs.work.precision.exact', 'pairs.work.precision.exactBlurb'],
];

function stateOf(p: PairDto): RowState {
  if (p.status === 'candidate') return 'suggested';
  if (p.status === 'rejected') return 'dismissed';
  const job = p.lastAlignJob;
  if (job?.state === 'running') return 'aligning';
  if (job?.state === 'queued') return 'queued';
  if (p.alignment) return 'aligned';
  if (job?.state === 'failed' && job.modelMissing) return 'model';
  if (job?.state === 'failed') return 'failed';
  return 'ready';
}

function isLinked(p: PairDto): boolean {
  return p.status === 'auto' || p.status === 'confirmed';
}

/** How many of the evidence signals point the same way, over how many exist. */
function signals(p: PairDto): { good: number; total: number } {
  const e = p.evidence;
  const checks: (boolean | null | undefined)[] = [
    e.titleScore === undefined ? undefined : e.titleScore > 0.85,
    e.authorScore === undefined ? undefined : e.authorScore > 0.85,
    e.identifierMatch ? true : undefined,
    e.languageMatch ?? undefined,
    e.durationPagesRatio == null
      ? undefined
      : e.durationPagesRatio > 0.55 && e.durationPagesRatio < 1.9,
    e.contentScore == null ? undefined : e.contentScore > 0.6,
  ];
  const present = checks.filter((c) => c !== undefined && c !== null);
  return { good: present.filter(Boolean).length, total: present.length };
}

function titleOf(p: PairDto, unknown: string): string {
  return p.ebook?.title ?? p.audio?.title ?? unknown;
}

export function PairsPage() {
  const t = useT();
  const f = useFormat();
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const [pairs, setPairs] = useState<PairDto[] | null>(null);
  const [summary, setSummary] = useState<ProcessingSummary | null>(null);
  const [unpaired, setUnpaired] = useState<BookSummary[] | null>(null);
  /** Multi-select for bulk "align these". */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<LinkedFilter>('all');
  const [error, setError] = useState<MessageKey | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [link, setLink] = useState<{ ebookId?: string; audioId?: string } | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  /**
   * The two alignment choices, editable here rather than only in Settings.
   * This is the page where someone is looking at the queue and deciding how
   * much of it to run and how well - sending them elsewhere to answer that,
   * then back again, is the wrong shape for the decision.
   */
  const [settings, setSettings] = useState<Pick<Settings, 'autoAlign' | 'alignPrecision'> | null>(
    null,
  );
  const toast = useToast();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isAdmin = user?.role === 'admin' || user?.role === 'curator';

  const load = useCallback(async () => {
    try {
      const res = await api<{ pairs: PairDto[]; summary?: ProcessingSummary }>('/api/pairs');
      setPairs(res.pairs);
      setSummary(res.summary ?? null);
      setError(null);
    } catch {
      setError('pairs.loadFailed');
    }
    try {
      const r = await api<{ books: BookSummary[] }>('/api/library?filter=unpaired');
      setUnpaired(Array.isArray(r?.books) ? r.books : []);
    } catch {
      setUnpaired([]);
    }
    try {
      const s = await api<{ settings: Settings }>('/api/settings');
      setSettings({ autoAlign: s.settings.autoAlign, alignPrecision: s.settings.alignPrecision });
    } catch {
      /* the controls simply do not appear */
    }
  }, []);

  const saveSetting = async (patch: Partial<Settings>) => {
    const previous = settings;
    setSettings((s) => (s ? { ...s, ...patch } : s)); // optimistic: a toggle must feel instant
    try {
      await api('/api/settings', { method: 'PUT', body: patch });
    } catch (err) {
      setSettings(previous);
      toast.show(failureMessage(err, t('pairs.toast.couldNotSave'), t));
    }
  };
  useEffect(() => {
    void load();
  }, [load]);

  // Live progress while any alignment runs.
  const active = pairs?.some(
    (p) => p.lastAlignJob && ['queued', 'running'].includes(p.lastAlignJob.state),
  );
  useEffect(() => {
    if (active && !pollRef.current) pollRef.current = setInterval(() => void load(), 3000);
    if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [active, load]);

  const act = async (pairId: string, action: PairAction) => {
    setBusyId(pairId);
    try {
      await api(`/api/pairs/${pairId}/${action}`, { method: 'POST' });
      toast.show(t('pairs.toast.acted', { action }));
      await load();
    } catch {
      toast.show(t('pairs.toast.actionFailed'));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Say yes to every suggestion at once.
   *
   * A library owned mostly in both formats produces dozens of candidates,
   * and each one was a separate tap - on the page whose whole purpose is to
   * get them linked and aligned.
   */
  const confirmAll = async (ids: string[]) => {
    if (ids.length === 0) return;
    setConfirmingAll(true);
    try {
      const res = await api<{ confirmed: number; skipped: number }>('/api/pairs/confirm-many', {
        method: 'POST',
        body: { pairIds: ids },
      });
      toast.show(
        res.confirmed > 0
          ? t('pairs.toast.linkedMany', { n: res.confirmed })
          : t('pairs.toast.nothingToLink'),
      );
      await load();
    } catch (err) {
      toast.show(failureMessage(err, t('pairs.toast.couldNotLink'), t));
    } finally {
      setConfirmingAll(false);
    }
  };

  const setLanguage = async (pairId: string, language: string | null) => {
    try {
      await api(`/api/pairs/${pairId}/language`, { method: 'POST', body: { language } });
      toast.show(
        language
          ? t('pairs.toast.languageSet', { name: f.languageName(language) })
          : t('pairs.toast.languageReset'),
      );
      await load();
    } catch (err) {
      toast.show(failureMessage(err, t('pairs.toast.couldNotChangeLanguage'), t));
    }
  };

  const downloadModel = async (modelId: string) => {
    try {
      await api(`/api/models/${modelId}/download`, { method: 'POST' });
      // One model, every language: there is nothing to name here.
      toast.show(t('pairs.toast.modelDownloading'), {
        label: t('pairs.toast.watchProgress'),
        onClick: () => {
          location.assign('/settings#alignment');
        },
      });
      await load();
    } catch (err) {
      toast.show(failureMessage(err, t('pairs.toast.couldNotDownload'), t));
    }
  };

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const startMany = async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      const res = await api<{ queued: number; skipped: number }>('/api/pairs/align-many', {
        method: 'POST',
        body: { pairIds: ids },
      });
      toast.show(
        res.queued > 0
          ? t('pairs.toast.queuedMany', { n: res.queued })
          : t('pairs.toast.nothingToQueue'),
      );
      setSelected(new Set());
      await load();
    } catch {
      toast.show(t('pairs.toast.couldNotQueue'));
    }
  };

  // ---------------------------------------------------------------- derived
  const all = useMemo(() => pairs ?? [], [pairs]);
  const candidates = useMemo(() => all.filter((p) => p.status === 'candidate'), [all]);
  const linked = useMemo(
    () =>
      all
        .filter(isLinked)
        .map((p) => ({ pair: p, state: stateOf(p) }))
        .sort(
          (a, b) =>
            STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
            titleOf(a.pair, '').localeCompare(titleOf(b.pair, '')),
        ),
    [all],
  );
  const rejected = useMemo(() => all.filter((p) => p.status === 'rejected'), [all]);
  /** Linked, not aligned yet, and not already queued: what Start acts on. */
  const startable = useMemo(
    () => linked.filter((r) => r.state === 'ready').map((r) => r.pair),
    [linked],
  );
  /** Books in a suggestion are spoken for under Suggested; the rest are unpaired. */
  const unpairedBooks = useMemo(() => {
    const spoken = new Set<string>();
    for (const p of candidates) {
      if (p.ebook) spoken.add(p.ebook.id);
      if (p.audio) spoken.add(p.audio.id);
    }
    return (unpaired ?? []).filter((b) => !spoken.has(b.id));
  }, [unpaired, candidates]);

  const counts: Record<Tab, number> = {
    suggested: candidates.length,
    linked: linked.length,
    unpaired: unpairedBooks.length,
    dismissed: rejected.length,
  };
  const filterCounts: Record<LinkedFilter, number> = {
    all: linked.length,
    attention: linked.filter((r) => r.state === 'model' || r.state === 'failed').length,
    ready: startable.length,
    aligned: linked.filter((r) => r.state === 'aligned').length,
  };
  const shownLinked = linked.filter((r) => {
    if (filter === 'attention') return r.state === 'model' || r.state === 'failed';
    if (filter === 'ready') return r.state === 'ready';
    if (filter === 'aligned') return r.state === 'aligned';
    return true;
  });

  // The tab is in the URL so Back and a reload land where you were. With
  // no choice made, open on what needs an answer, else on the pairs.
  const requested = params.get('tab');
  const tab: Tab = (TABS as string[]).includes(requested ?? '')
    ? (requested as Tab)
    : candidates.length > 0
      ? 'suggested'
      : 'linked';
  const selectTab = (next: Tab) => {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    setParams(p, { replace: true });
  };
  const onTabKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = TABS.indexOf(tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
    selectTab(next);
    (e.currentTarget.querySelector(`#ptab-${next}`) as HTMLElement | null)?.focus();
  };

  if (error) {
    return (
      <main className="app-main" id="main-content" tabIndex={-1}>
        <div className="banner banner--error" role="alert">
          <IconAlert size={18} /> {t(error)}
        </div>
      </main>
    );
  }

  const rowProps = {
    isAdmin,
    speedRatio: summary?.speedRatio ?? 0,
    busyId,
    onAction: act,
    onLanguage: setLanguage,
    onDownloadModel: downloadModel,
    onToggleOpen: toggleOpen,
  };

  return (
    <main className="app-main" id="main-content" tabIndex={-1}>
      <header className="page-head page-head--row">
        <div>
          <h1>{t('nav.pairing')}</h1>
          <p>{t('pairs.lede')}</p>
        </div>
        <div className="page-head__actions">
          <button
            className="btn btn--ghost"
            onClick={() => setHowOpen((v) => !v)}
            aria-expanded={howOpen}
          >
            {t('pairs.howItWorks')}
          </button>
          {isAdmin && (
            <button className="btn btn--secondary" onClick={() => setLink({})}>
              <IconLink size={16} /> {t('pairs.linkManually')}
            </button>
          )}
        </div>
      </header>
      {howOpen && (
        <section className="panel panel--soft" aria-label={t('pairs.howItWorksLabel')}>
          <PipelineDiagram />
        </section>
      )}
      <ProcessingQueue canManage={isAdmin} onChange={() => void load()} quietWhenIdle />

      <div className="ptabs" role="tablist" aria-label={t('pairs.tabsLabel')} onKeyDown={onTabKey}>
        {TABS.map((k) => (
          <button
            key={k}
            id={`ptab-${k}`}
            role="tab"
            type="button"
            aria-selected={tab === k}
            aria-controls={`ppanel-${k}`}
            tabIndex={tab === k ? 0 : -1}
            className={`ptabs__tab ${tab === k ? 'is-on' : ''} ${counts[k] === 0 ? 'is-empty' : ''}`}
            onClick={() => selectTab(k)}
          >
            {t(`pairs.tab.${k}` as MessageKey)}
            <span className="ptabs__count">{pairs ? f.number(counts[k]) : '·'}</span>
          </button>
        ))}
      </div>

      <section
        id={`ppanel-${tab}`}
        role="tabpanel"
        aria-labelledby={`ptab-${tab}`}
        className="ppanel"
      >
        <p className="ppanel__lede">{t('pairs.tab.lede', { tab })}</p>

        {!pairs ? (
          <div aria-busy="true">
            <div className="skeleton" style={{ height: 64, marginBlockEnd: 10 }} />
            <div className="skeleton" style={{ height: 64, marginBlockEnd: 10 }} />
            <div className="skeleton" style={{ height: 64 }} />
          </div>
        ) : tab === 'suggested' ? (
          candidates.length === 0 ? (
            <EmptyState icon={<IconLink size={42} />} title={t('pairs.empty.suggested')}>
              {t('pairs.empty.suggestedBody')}
            </EmptyState>
          ) : (
            <>
              {isAdmin && candidates.length > 1 && (
                <div className="ppanel__bar">
                  <button
                    className="btn btn--secondary"
                    disabled={confirmingAll}
                    onClick={() => void confirmAll(candidates.map((p) => p.id))}
                  >
                    <IconCheck size={16} />{' '}
                    {confirmingAll
                      ? t('pairs.section.linking')
                      : t('pairs.section.linkAll', { n: candidates.length })}
                  </button>
                </div>
              )}
              <ul className="prs">
                {candidates.map((p) => (
                  <PairRow
                    key={p.id}
                    pair={p}
                    state="suggested"
                    open={open.has(p.id)}
                    {...rowProps}
                  />
                ))}
              </ul>
            </>
          )
        ) : tab === 'linked' ? (
          linked.length === 0 ? (
            <EmptyState icon={<IconLink size={42} />} title={t('pairs.empty.linked')}>
              {t('pairs.empty.linkedBody')}
            </EmptyState>
          ) : (
            <>
              {isAdmin && summary && startable.length > 0 && (
                <section className="worksum" aria-label={t('pairs.work.label')}>
                  <div className="worksum__body">
                    <h2 className="worksum__title">
                      {t('pairs.work.ready', { n: startable.length })}
                    </h2>
                    <p className="worksum__lede">
                      {summary.estimatedMs != null
                        ? t('pairs.work.estimate', {
                            computing: f.span(summary.estimatedMs),
                            audio: formatDuration(summary.pendingAudioMs),
                          })
                        : t('pairs.work.noEstimate', {
                            audio: formatDuration(summary.pendingAudioMs),
                          })}{' '}
                      {t('pairs.work.marked')}
                    </p>
                  </div>
                  <div className="worksum__actions">
                    {selected.size > 0 && (
                      <button className="btn btn--ghost" onClick={() => setSelected(new Set())}>
                        {t('pairs.work.clearSelection', { n: selected.size })}
                      </button>
                    )}
                    <button
                      className="btn"
                      onClick={() =>
                        void startMany(
                          selected.size > 0 ? [...selected] : startable.map((p) => p.id),
                        )
                      }
                    >
                      {selected.size > 0
                        ? t('pairs.work.startSelected', { n: selected.size })
                        : t('pairs.work.startAll', { n: startable.length })}
                    </button>
                  </div>
                  {settings && (
                    <>
                      <button
                        type="button"
                        className="worksum__more"
                        aria-expanded={optionsOpen}
                        onClick={() => setOptionsOpen((v) => !v)}
                      >
                        <IconChevronDown size={15} />
                        {optionsOpen ? t('pairs.work.optionsHide') : t('pairs.work.options')}
                      </button>
                      {optionsOpen && (
                        <div className="worksum__choices">
                          <label className="rs-toggle rs-toggle--tight">
                            <span>
                              {t('pairs.work.autoAlign')}
                              <span className="hint" style={{ display: 'block' }}>
                                {settings.autoAlign
                                  ? t('pairs.work.autoAlignOn')
                                  : t('pairs.work.autoAlignOff')}
                              </span>
                            </span>
                            <input
                              type="checkbox"
                              role="switch"
                              checked={settings.autoAlign}
                              onChange={(e) => void saveSetting({ autoAlign: e.target.checked })}
                            />
                          </label>
                          <div
                            className="seg"
                            role="radiogroup"
                            aria-label={t('pairs.work.precisionLabel')}
                            title={t('pairs.work.precisionTitle')}
                          >
                            {ACCURACY.map(([value, label, blurb]) => (
                              <button
                                key={value}
                                type="button"
                                role="radio"
                                aria-checked={settings.alignPrecision === value}
                                className={`seg__opt ${settings.alignPrecision === value ? 'is-on' : ''}`}
                                onClick={() => void saveSetting({ alignPrecision: value })}
                              >
                                <strong>{t(label)}</strong>
                                <span>{t(blurb)}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}
              {linked.length > 1 && (
                <div className="chip-row pfilters" role="group" aria-label={t('pairs.filterLabel')}>
                  {FILTERS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className="chip chip--small"
                      aria-pressed={filter === k}
                      disabled={k !== 'all' && filterCounts[k] === 0}
                      onClick={() => setFilter(k)}
                    >
                      {t(`pairs.filter.${k}` as MessageKey)}
                      <span className="pfilters__n">{f.number(filterCounts[k])}</span>
                    </button>
                  ))}
                </div>
              )}
              <ul className="prs">
                {shownLinked.map(({ pair, state }) => (
                  <PairRow
                    key={pair.id}
                    pair={pair}
                    state={state}
                    open={open.has(pair.id)}
                    selectable={isAdmin && state === 'ready'}
                    selected={selected.has(pair.id)}
                    onSelect={toggleSelected}
                    {...rowProps}
                  />
                ))}
              </ul>
            </>
          )
        ) : tab === 'unpaired' ? (
          <UnpairedList
            books={unpaired === null ? null : unpairedBooks}
            canLink={isAdmin}
            onLink={(b) => setLink(b.kind === 'ebook' ? { ebookId: b.id } : { audioId: b.id })}
          />
        ) : rejected.length === 0 ? (
          <EmptyState icon={<IconLink size={42} />} title={t('pairs.empty.dismissed')}>
            {t('pairs.empty.dismissedBody')}
          </EmptyState>
        ) : (
          <ul className="prs">
            {rejected.map((p) => (
              <PairRow key={p.id} pair={p} state="dismissed" open={open.has(p.id)} {...rowProps} />
            ))}
          </ul>
        )}
      </section>

      {link && (
        <ManualLinkSheet
          preset={link}
          onClose={() => setLink(null)}
          onLinked={() => {
            setLink(null);
            toast.show(t('pairs.toast.manualLinked'));
            void load();
          }}
        />
      )}
    </main>
  );
}

// ------------------------------------------------------------------ rows

interface RowHandlers {
  isAdmin: boolean;
  /** Seconds of audio aligned per second of wall clock; 0 = not yet measured. */
  speedRatio: number;
  busyId: string | null;
  onAction: (id: string, a: PairAction) => void;
  onLanguage: (id: string, language: string | null) => void;
  onDownloadModel: (modelId: string) => void;
  onToggleOpen: (id: string) => void;
}

function PairRow({
  pair,
  state,
  open,
  selectable,
  selected,
  onSelect,
  isAdmin,
  speedRatio,
  busyId,
  onAction,
  onLanguage,
  onDownloadModel,
  onToggleOpen,
}: RowHandlers & {
  pair: PairDto;
  state: RowState;
  open: boolean;
  /** Ready to align: offer it for bulk starting. */
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (id: string) => void;
}) {
  const t = useT();
  const f = useFormat();
  const title = titleOf(pair, t('common.unknown'));
  const author = pair.ebook?.author ?? pair.audio?.author ?? null;
  const busy = busyId === pair.id;
  const job = pair.lastAlignJob;
  const detailsId = `pair-details-${pair.id}`;

  // One line under the chip: the number that matters in this state.
  let caption: string | null = null;
  if (state === 'suggested') {
    const s = signals(pair);
    caption =
      `${t('pairs.card.match', { pct: f.percent(pair.score) })}` +
      (s.total > 0 ? ` · ${t('pairs.row.signals', { good: s.good, total: s.total })}` : '');
  } else if (state === 'aligned' && pair.alignment) {
    caption = pair.handoff?.available
      ? `${t('pairs.row.exact', { pct: f.percent(pair.alignment.exactSentenceCoverage) })} · ${t('pairs.row.switchReady')}`
      : t('pairs.row.coverage', { pct: f.percent(pair.alignment.coverage) });
  } else if (state === 'aligning' && job) {
    caption = job.detail ?? t('pairs.row.progress', { pct: f.percent(job.progress) });
  } else if (state === 'queued') {
    caption = t('pairs.row.queuedHint');
  } else if (state === 'ready') {
    caption =
      speedRatio > 0 && pair.audio?.durationMs
        ? t('pairs.card.timeToAlign', { span: f.span(pair.audio.durationMs / speedRatio) })
        : null;
  } else if (state === 'model') {
    caption = t('pairs.row.modelHint');
  } else if (state === 'failed') {
    caption = t('pairs.row.failedHint');
  } else if (state === 'dismissed') {
    caption = t('pairs.row.dismissedHint');
  }

  return (
    <li
      id={`pair-${pair.id}`}
      className={`pr pr--${state} ${open ? 'is-open' : ''} ${selected ? 'is-selected' : ''}`}
    >
      <div className="pr__main">
        {selectable && onSelect ? (
          <input
            type="checkbox"
            className="pr__pick"
            checked={!!selected}
            onChange={() => onSelect(pair.id)}
            aria-label={t('pairs.card.selectForAlignment', { title })}
          />
        ) : (
          <span className="pr__pick pr__pick--none" aria-hidden="true" />
        )}
        <button
          type="button"
          className="pr__summary"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => onToggleOpen(pair.id)}
        >
          <span className="pr__covers" aria-hidden="true">
            {pair.audio && (
              <span className="pr__slot pr__slot--audio">
                <Cover
                  book={{
                    id: pair.audio.id,
                    title: pair.audio.title,
                    author: pair.audio.author,
                    hasCover: true,
                    kind: 'audio',
                  }}
                  className="pr__cover"
                />
              </span>
            )}
            {pair.ebook && (
              <span className="pr__slot pr__slot--ebook">
                <Cover
                  book={{
                    id: pair.ebook.id,
                    title: pair.ebook.title,
                    author: pair.ebook.author,
                    hasCover: true,
                    kind: 'ebook',
                  }}
                  className="pr__cover"
                />
              </span>
            )}
          </span>
          <span className="pr__text">
            <span className="pr__title">
              <bdi>{title}</bdi>
            </span>
            <span className="pr__meta">
              {author && <bdi>{author}</bdi>}
              {author && pair.audio?.durationMs ? ' · ' : ''}
              {pair.audio?.durationMs ? formatDuration(pair.audio.durationMs) : ''}
            </span>
          </span>
        </button>

        <div className="pr__state">
          <span className={`pr__chip pr__chip--${state}`}>
            {state === 'aligning' && <span className="spinner pr__spin" aria-hidden="true" />}
            {t(`pairs.state.${state}` as MessageKey)}
          </span>
          {caption && (
            <span className="pr__caption">
              <bdi>{caption}</bdi>
            </span>
          )}
          {state === 'aligning' && job && (
            <span className="progressbar pr__progress" aria-hidden="true">
              <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </span>
          )}
        </div>

        {state === 'aligned' && (
          <div className="pr__strip">
            <CoverageStrip pair={pair} compact />
          </div>
        )}

        {isAdmin && (
          <div className="pr__actions">
            {state === 'suggested' && (
              <>
                <button
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => onAction(pair.id, 'confirm')}
                >
                  <IconCheck size={15} /> {t('pairs.actions.link')}
                </button>
                <button
                  className="btn btn--sm btn--ghost"
                  disabled={busy}
                  onClick={() => onAction(pair.id, 'reject')}
                >
                  <IconClose size={15} /> {t('pairs.actions.notAMatch')}
                </button>
              </>
            )}
            {state === 'ready' && (
              <button
                className="btn btn--sm btn--secondary"
                disabled={busy}
                onClick={() => onAction(pair.id, 'align')}
              >
                {t('pairs.actions.start')}
              </button>
            )}
            {state === 'model' && job?.modelMissing && (
              <button
                className="btn btn--sm"
                disabled={busy}
                onClick={() => onDownloadModel(job.modelMissing!.modelId)}
              >
                <IconDownload size={15} /> {t('pairs.job.download')}
              </button>
            )}
            {state === 'failed' && (
              <button
                className="btn btn--sm btn--secondary"
                disabled={busy}
                onClick={() => onAction(pair.id, 'align')}
              >
                {t('common.retry')}
              </button>
            )}
            {state === 'dismissed' && (
              <button
                className="btn btn--sm btn--secondary"
                disabled={busy}
                onClick={() => onAction(pair.id, 'confirm')}
              >
                {t('pairs.actions.linkAnyway')}
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          className="pr__chev"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={
            open ? t('pairs.row.hideDetails', { title }) : t('pairs.row.showDetails', { title })
          }
          onClick={() => onToggleOpen(pair.id)}
        >
          <IconChevronDown size={18} />
        </button>
      </div>

      {open && (
        <div className="pr__details" id={detailsId}>
          <PairDetails
            pair={pair}
            state={state}
            isAdmin={isAdmin}
            busy={busy}
            onAction={onAction}
            onLanguage={onLanguage}
            onDownloadModel={onDownloadModel}
          />
        </div>
      )}
    </li>
  );
}

/** Everything about a pair that does not belong on one line. */
function PairDetails({
  pair,
  state,
  isAdmin,
  busy,
  onAction,
  onLanguage,
  onDownloadModel,
}: {
  pair: PairDto;
  state: RowState;
  isAdmin: boolean;
  busy: boolean;
  onAction: (id: string, a: PairAction) => void;
  onLanguage: (id: string, language: string | null) => void;
  onDownloadModel: (modelId: string) => void;
}) {
  const t = useT();
  const f = useFormat();
  const e = pair.evidence;
  const notes = (e.notes ?? []).flatMap((n): { text: string; done: boolean }[] => {
    if (pair.status === 'candidate' || !n.startsWith('Strong metadata match')) {
      return [{ text: n, done: false }];
    }
    if (pair.status === 'auto') {
      return [{ text: t('pairs.card.verifiedNote'), done: true }];
    }
    return [];
  });
  const job = pair.lastAlignJob;
  const lang = pair.language;

  return (
    <>
      <div className="pr__editions">
        <EditionTile book={pair.ebook} kind="ebook" />
        <span
          className={`pr__join ${state === 'suggested' ? 'pr__join--maybe' : ''}`}
          aria-hidden="true"
        >
          <IconSwitch size={16} />
        </span>
        <EditionTile
          book={pair.audio}
          kind="audio"
          extra={pair.audio?.durationMs ? formatDuration(pair.audio.durationMs) : undefined}
        />
      </div>

      <div className="pr__facts">
        <span className="pr__fact">
          {isLinked(pair)
            ? t('pairs.row.linkedWhen', {
                status: pair.status,
                when: f.ago(pair.decidedAt ?? pair.createdAt),
              })
            : t('pairs.card.status', { status: pair.status })}
        </span>
        <span className="pr__fact">{t('pairs.card.match', { pct: f.percent(pair.score) })}</span>
        {pair.handoff?.available && (
          <span className="badge badge--sync">
            <IconSwitch size={11} />{' '}
            {t('pairs.card.switchReady', { pct: f.percent(pair.handoff.exactSentenceCoverage) })}
          </span>
        )}
        <label className="lang-pick">
          <span className="lang-pick__label">{t('pairs.language.label')}</span>
          <select
            className="lang-pick__select"
            value={lang.override ?? ''}
            disabled={!isAdmin}
            title={t('pairs.language.sourceTitle', { source: lang.source })}
            onChange={(ev) => onLanguage(pair.id, ev.target.value || null)}
          >
            <option value="">
              {lang.override
                ? t('pairs.language.auto')
                : lang.effective
                  ? t('pairs.language.autoWith', { name: f.languageName(lang.effective) })
                  : t('pairs.language.autoDetect')}
            </option>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {t('pairs.language.option', { name: f.languageName(l.code), native: l.native })}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="evidence-grid">
        {e.titleScore !== undefined && (
          <ScoreCell
            label={t('pairs.evidence.title')}
            value={f.percent(e.titleScore)}
            good={e.titleScore > 0.85}
          />
        )}
        {e.authorScore !== undefined && (
          <ScoreCell
            label={t('pairs.evidence.author')}
            value={f.percent(e.authorScore)}
            good={e.authorScore > 0.85}
          />
        )}
        <ScoreCell
          label={t('pairs.evidence.identifiers')}
          value={e.identifierMatch ? t('pairs.evidence.match') : '-'}
          good={e.identifierMatch ? true : null}
        />
        <ScoreCell
          label={t('pairs.evidence.language')}
          value={
            e.languageMatch === null || e.languageMatch === undefined
              ? t('common.unknown')
              : e.languageMatch
                ? t('pairs.evidence.match')
                : t('pairs.evidence.mismatch')
          }
          good={e.languageMatch ?? null}
        />
        {e.durationPagesRatio != null && (
          <ScoreCell
            label={t('pairs.evidence.lengthRatio')}
            value={t('pairs.evidence.ratio', { ratio: e.durationPagesRatio.toFixed(2) })}
            good={e.durationPagesRatio > 0.55 && e.durationPagesRatio < 1.9}
          />
        )}
        {e.contentScore != null && (
          <ScoreCell
            label={t('pairs.evidence.contentOverlap')}
            value={f.percent(e.contentScore)}
            good={e.contentScore > 0.6}
          />
        )}
      </div>

      {notes.map((n, i) => (
        <div className="banner" key={i}>
          {n.done ? <IconCheck size={15} /> : <IconAlert size={15} />} <bdi>{n.text}</bdi>
        </div>
      ))}
      {pair.compat?.warning && (
        <div className="banner banner--error">
          <IconAlert size={15} /> <bdi>{pair.compat.warning}</bdi>
        </div>
      )}

      {state === 'model' && job?.modelMissing && (
        <div className="banner banner--action" role="alert">
          <IconDownload size={16} />
          <span className="grow">
            {/* One model covers every language, so there is only ever one
                thing missing and naming a language would misdescribe it. */}
            <strong>{t('pairs.job.modelNeeded')}</strong>{' '}
            <bdi>
              {job.modelMissing.message.replace(/[ --]*(download|get) it in Settings.*$/i, '')}
            </bdi>
            . {t('pairs.job.modelDownloadHint')}
          </span>
          <button
            className="btn"
            style={{ minHeight: 38 }}
            disabled={!isAdmin}
            onClick={() => onDownloadModel(job.modelMissing!.modelId)}
          >
            {t('pairs.job.download')}
          </button>
          <Link to="/settings#alignment" className="btn btn--ghost" style={{ minHeight: 38 }}>
            {t('pairs.job.models')}
          </Link>
        </div>
      )}
      {job?.state === 'failed' && !job.modelMissing && pair.status !== 'rejected' && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={15} />
          <span className="grow">
            {t('pairs.job.failed')}
            {job.error && (
              <small className="hint">
                {' '}
                <bdi>{job.error}</bdi>
              </small>
            )}
          </span>
        </div>
      )}

      {pair.alignment ? (
        <div className="align-summary">
          <div className="align-summary__row">
            <strong>{t('pairs.aligned.title')}</strong>
            <span>
              {t('pairs.aligned.sentenceExact', {
                pct: f.percent(pair.alignment.exactSentenceCoverage),
              })}
            </span>
            <span>{t('pairs.aligned.coverage', { pct: f.percent(pair.alignment.coverage) })}</span>
            <span>
              {t('pairs.aligned.confidence', { pct: f.percent(pair.alignment.meanConfidence) })}
            </span>
            <span>{t('pairs.aligned.sentences', { n: pair.alignment.segmentCount })}</span>
            <span className="soft">
              <bdi>{pair.alignment.model}</bdi> · {f.languageName(pair.alignment.language)}
            </span>
            {pair.alignment.gaps.length > 0 && (
              <span className="soft">
                {t('pairs.aligned.gaps', {
                  n: pair.alignment.gaps.length,
                  reason: pair.alignment.gaps[0]!.reason,
                  from: formatDuration(pair.alignment.gaps[0]!.fromMs),
                  to: formatDuration(pair.alignment.gaps[0]!.toMs),
                })}
              </span>
            )}
          </div>
          <CoverageStrip pair={pair} />
        </div>
      ) : (
        state === 'ready' && <p className="pr__note">{t('pairs.card.unalignedNote')}</p>
      )}

      {isAdmin && (
        <div className="pair-actions">
          {state === 'suggested' && (
            <>
              <button className="btn" disabled={busy} onClick={() => onAction(pair.id, 'confirm')}>
                <IconCheck size={16} /> {t('pairs.actions.linkEditions')}
              </button>
              <button
                className="btn btn--secondary"
                disabled={busy}
                onClick={() => onAction(pair.id, 'reject')}
              >
                <IconClose size={16} /> {t('pairs.actions.notAMatch')}
              </button>
            </>
          )}
          {isLinked(pair) && (
            <>
              {state !== 'aligning' && state !== 'queued' && (
                <button
                  className="btn btn--secondary"
                  disabled={busy}
                  onClick={() => onAction(pair.id, 'align')}
                >
                  {pair.alignment
                    ? t('pairs.actions.rerunAlignment')
                    : t('pairs.actions.runAlignment')}
                </button>
              )}
              <button
                className="btn btn--ghost btn--danger"
                disabled={busy}
                onClick={() => onAction(pair.id, 'unlink')}
              >
                {t('pairs.actions.unlink')}
              </button>
            </>
          )}
          {state === 'dismissed' && (
            <button
              className="btn btn--secondary"
              disabled={busy}
              onClick={() => onAction(pair.id, 'confirm')}
            >
              {t('pairs.actions.linkAnyway')}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function ScoreCell({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good?: boolean | null;
}) {
  const t = useT();
  return (
    <div className={`evidence-cell ${good === true ? 'is-good' : good === false ? 'is-bad' : ''}`}>
      {label}
      {/* A shape as well as a hue. The good and bad colours are both in the
          rust family and only a shade apart, so the verdict was carried by a
          difference many people cannot see and no screen reader announces. */}
      <b>
        {good === true && <IconCheck size={13} aria-hidden="true" />}
        {good === false && <IconAlert size={13} aria-hidden="true" />}
        {value}
        {good !== null && good !== undefined && (
          <span className="visually-hidden">
            {' '}
            {t(good ? 'pairs.evidence.good' : 'pairs.evidence.poor')}
          </span>
        )}
      </b>
    </div>
  );
}

function EditionTile({
  book,
  kind,
  extra,
}: {
  book: { id: string; title: string; author: string | null } | null;
  kind: 'ebook' | 'audio';
  extra?: string;
}) {
  const t = useT();
  return (
    <Link to={book ? `/book/${book.id}` : '/pairs'} className="edition-tile">
      <span className="edition-tile__cover">
        {book && (
          <Cover
            book={{ id: book.id, title: book.title, author: book.author, hasCover: true, kind }}
            className="edition-tile__img"
          />
        )}
      </span>
      <span className="edition-tile__body">
        <span className="edition-tile__kind">
          {kind === 'ebook' ? <IconBookOpen size={12} /> : <IconHeadphones size={12} />}
          {kind === 'ebook' ? t('common.ebook') : t('common.audiobook')}
        </span>
        <span className="edition-tile__title">{book?.title ?? t('common.unknown')}</span>
        <span className="edition-tile__meta">
          {book?.author ?? '-'}
          {extra ? ` · ${extra}` : ''}
        </span>
      </span>
    </Link>
  );
}

// -------------------------------------------------------------- unpaired

function UnpairedList({
  books,
  canLink,
  onLink,
}: {
  books: BookSummary[] | null;
  canLink: boolean;
  onLink: (book: BookSummary) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  if (!books) {
    return (
      <div aria-busy="true">
        <div className="skeleton" style={{ height: 52, marginBlockEnd: 8 }} />
        <div className="skeleton" style={{ height: 52 }} />
      </div>
    );
  }
  if (books.length === 0) {
    return (
      <EmptyState icon={<IconCheck size={42} />} title={t('pairs.empty.unpaired')}>
        {t('pairs.empty.unpairedBody')}
      </EmptyState>
    );
  }
  const q = query.trim().toLowerCase();
  const shown = q
    ? books.filter(
        (b) => b.title.toLowerCase().includes(q) || (b.author ?? '').toLowerCase().includes(q),
      )
    : books;
  return (
    <>
      {books.length > 6 && (
        <label className="search-field pun__search">
          <IconSearch size={16} />
          <input
            type="search"
            value={query}
            placeholder={t('pairs.unpaired.search')}
            aria-label={t('pairs.unpaired.search')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      {shown.length === 0 ? (
        <p className="pr__note">{t('pairs.unpaired.noMatch', { query: query.trim() })}</p>
      ) : (
        <ul className="pun">
          {shown.map((b) => (
            <li key={b.id} className="pun__row">
              <Link to={`/book/${b.id}`} className="pun__book">
                <span className="pun__slot">
                  <Cover book={b} className="pun__cover" />
                </span>
                <span className="pun__text">
                  <span className="pun__title">
                    <bdi>{b.title}</bdi>
                  </span>
                  <span className="pun__meta">
                    {b.kind === 'ebook' ? <IconBookOpen size={12} /> : <IconHeadphones size={12} />}
                    {b.kind === 'ebook' ? t('common.ebook') : t('common.audiobook')}
                    {b.author ? (
                      <>
                        {' · '}
                        <bdi>{b.author}</bdi>
                      </>
                    ) : null}
                  </span>
                </span>
              </Link>
              {canLink && (
                <button className="btn btn--sm btn--secondary" onClick={() => onLink(b)}>
                  <IconLink size={14} /> {t('pairs.unpaired.link')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ----------------------------------------------------------- manual link

/**
 * Manual arbitrary pairing: pick any UNLINKED ebook and any unlinked
 * audiobook and link them. Complements automatic suggestions for titles whose
 * metadata never matches.
 *
 * `filter=unpaired` asks the server for what is actually linkable, in SQL,
 * because a library where most titles are owned twice would otherwise send
 * most of itself here to be discarded in the browser. A `candidate` still
 * appears: it is a suggestion nobody has answered, and this sheet is where a
 * reader goes when the suggestion is wrong. A `preset` fills one side in,
 * for the Unpaired tab's per-book "Link…".
 */
function ManualLinkSheet({
  preset,
  onClose,
  onLinked,
}: {
  preset: { ebookId?: string; audioId?: string };
  onClose: () => void;
  onLinked: () => void;
}) {
  const t = useT();
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [ebookId, setEbookId] = useState(preset.ebookId ?? '');
  const [audioId, setAudioId] = useState(preset.audioId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ books: BookSummary[] }>('/api/library?filter=unpaired')
      .then((r) => {
        if (alive) setBooks(r.books);
      })
      .catch(() => {
        if (alive) setError('pairs.manual.libraryFailed');
      });
    return () => {
      alive = false;
    };
  }, []);

  const ebooks = (books ?? []).filter((b) => b.kind === 'ebook');
  const audios = (books ?? []).filter((b) => b.kind === 'audio');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/pairs/link', { method: 'POST', body: { ebookId, audioId } });
      onLinked();
    } catch {
      setError('pairs.manual.linkFailed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t('pairs.manual.title')} onClose={onClose}>
      <p style={{ color: 'var(--rp-text-soft)', fontSize: 13.5, marginBlockStart: 0 }}>
        {t('pairs.manual.note')}
      </p>
      {error && (
        <div className="banner banner--error" role="alert">
          {t(error)}
        </div>
      )}
      <div className="field">
        <label htmlFor="ml-ebook">{t('common.ebook')}</label>
        <select
          id="ml-ebook"
          className="input"
          value={ebookId}
          onChange={(e) => setEbookId(e.target.value)}
        >
          <option value="">{t('pairs.manual.chooseEbook')}</option>
          {ebooks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
              {b.author ? ` - ${b.author}` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ml-audio">{t('common.audiobook')}</label>
        <select
          id="ml-audio"
          className="input"
          value={audioId}
          onChange={(e) => setAudioId(e.target.value)}
        >
          <option value="">{t('pairs.manual.chooseAudiobook')}</option>
          {audios.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
              {b.author ? ` - ${b.author}` : ''}
            </option>
          ))}
        </select>
      </div>
      <button className="btn" disabled={busy || !ebookId || !audioId} onClick={() => void submit()}>
        <IconLink size={16} /> {t('pairs.actions.linkEditions')}
      </button>
    </Sheet>
  );
}

// -------------------------------------------------------------- coverage

/** Bars fetched once per pair, shared by the row's strip and the details'. */
const stripCache = new Map<string, { minute: number; confidence: number }[]>();

function CoverageStrip({ pair, compact }: { pair: PairDto; compact?: boolean }) {
  const t = useT();
  const f = useFormat();
  const [bars, setBars] = useState<{ minute: number; confidence: number }[] | null>(
    () => stripCache.get(pair.id) ?? null,
  );
  const version = pair.alignment?.version;
  useEffect(() => {
    let alive = true;
    const cached = stripCache.get(pair.id);
    if (cached) {
      setBars(cached);
      return;
    }
    api<{ confidenceByMinute: { minute: number; confidence: number }[] }>(
      `/api/pairs/${pair.id}/alignment`,
    )
      .then((r) => {
        const list = Array.isArray(r?.confidenceByMinute) ? r.confidenceByMinute : [];
        stripCache.set(pair.id, list);
        if (alive) setBars(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // A re-run replaces the alignment: fetch again for the new version.
  }, [pair.id, version]);
  if (!bars || bars.length === 0) return null;
  const avg = bars.reduce((a, b) => a + b.confidence, 0) / bars.length;
  // One bar per audio minute makes a ten-hour book 600 bars wide. Average
  // them down to a fixed count so the strip fits its card on a phone - and
  // to far fewer on the row, where it is a glance and not a report.
  const shown = bucketCoverage(bars, compact ? 36 : undefined);
  return (
    <div
      className={`coverage-strip ${compact ? 'coverage-strip--mini' : ''}`}
      role="img"
      aria-label={t('pairs.coverage.label', { n: bars.length, pct: f.percent(avg) })}
      title={compact ? t('pairs.row.strip') : undefined}
    >
      {shown.map((b) => (
        <span
          key={b.minute}
          style={{
            height: `${Math.max(12, b.confidence * 100)}%`,
            opacity: 0.35 + b.confidence * 0.65,
          }}
          title={
            compact
              ? undefined
              : b.minutes === 1
                ? t('pairs.coverage.minute', { minute: b.minute, pct: f.percent(b.confidence) })
                : t('pairs.coverage.minutes', {
                    from: b.minute,
                    to: b.minute + b.minutes - 1,
                    pct: f.percent(b.confidence),
                  })
          }
        />
      ))}
    </div>
  );
}
