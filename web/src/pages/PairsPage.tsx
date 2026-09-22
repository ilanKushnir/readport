import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LANGUAGES, type Settings } from '@readport/shared';
import { api, failureMessage } from '../api/client';
import { type BookSummary, type PairDto, type ProcessingSummary } from '../lib/types';
import { Cover, EmptyState, Sheet, useToast } from '../components/ui';
import { useSession } from '../state/session';
import {
  IconAlert,
  IconBookOpen,
  IconCheck,
  IconClose,
  IconDownload,
  IconHeadphones,
  IconLink,
  IconSwitch,
} from '../components/icons';
import { formatDuration } from '../lib/format';
import { PipelineDiagram, ProcessingQueue } from '../components/Processing';
import { bucketCoverage } from '../lib/coverageBars';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { type MessageKey } from '../i18n/messages/en';

type PairAction = 'confirm' | 'reject' | 'unlink' | 'align';

/**
 * Two outcomes, not two settings - the same pair of choices Settings offers,
 * worded for the moment you are about to start a queue.
 */
const ACCURACY: [Settings['alignPrecision'], MessageKey, MessageKey][] = [
  ['standard', 'pairs.work.precision.standard', 'pairs.work.precision.standardBlurb'],
  ['exact', 'pairs.work.precision.exact', 'pairs.work.precision.exactBlurb'],
];

export function PairsPage() {
  const t = useT();
  const f = useFormat();
  const { user } = useSession();
  const [pairs, setPairs] = useState<PairDto[] | null>(null);
  const [summary, setSummary] = useState<ProcessingSummary | null>(null);
  /** Multi-select for bulk "align these". */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<MessageKey | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
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

  if (error) {
    return (
      <main className="app-main" id="main-content" tabIndex={-1}>
        <div className="banner banner--error" role="alert">
          <IconAlert size={18} /> {t(error)}
        </div>
      </main>
    );
  }

  const candidates = (pairs ?? []).filter((p) => p.status === 'candidate');
  const linked = (pairs ?? []).filter((p) => p.status === 'auto' || p.status === 'confirmed');
  const rejected = (pairs ?? []).filter((p) => p.status === 'rejected');

  /** Linked, not aligned yet, and not already queued: what Start acts on. */
  const startable = (pairs ?? []).filter(
    (p) =>
      (p.status === 'auto' || p.status === 'confirmed') &&
      !p.alignment &&
      !(p.lastAlignJob && ['queued', 'running'].includes(p.lastAlignJob.state)),
  );
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
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
          <button className="btn btn--secondary" onClick={() => setLinkOpen(true)}>
            <IconLink size={16} /> {t('pairs.linkManually')}
          </button>
        </div>
      </header>
      {howOpen && (
        <section className="panel panel--soft" aria-label={t('pairs.howItWorksLabel')}>
          <PipelineDiagram />
        </section>
      )}
      <ProcessingQueue canManage={isAdmin} onChange={() => void load()} />

      {isAdmin && summary && startable.length > 0 && (
        <section className="worksum" aria-label={t('pairs.work.label')}>
          <div className="worksum__body">
            <h2 className="worksum__title">{t('pairs.work.ready', { n: startable.length })}</h2>
            <p className="worksum__lede">
              {summary.estimatedMs != null
                ? t('pairs.work.estimate', {
                    computing: f.span(summary.estimatedMs),
                    audio: formatDuration(summary.pendingAudioMs),
                  })
                : t('pairs.work.noEstimate', {
                    audio: formatDuration(summary.pendingAudioMs),
                  })}
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
                void startMany(selected.size > 0 ? [...selected] : startable.map((p) => p.id))
              }
            >
              {selected.size > 0
                ? t('pairs.work.startSelected', { n: selected.size })
                : t('pairs.work.startAll', { n: startable.length })}
            </button>
          </div>
          {settings && (
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
        </section>
      )}
      {linkOpen && (
        <ManualLinkSheet
          onClose={() => setLinkOpen(false)}
          onLinked={() => {
            setLinkOpen(false);
            toast.show(t('pairs.toast.manualLinked'));
            void load();
          }}
        />
      )}

      {!pairs ? (
        <div aria-busy="true">
          <div className="skeleton" style={{ height: 180, marginBlockEnd: 16 }} />
          <div className="skeleton" style={{ height: 180 }} />
        </div>
      ) : pairs.length === 0 ? (
        <EmptyState icon={<IconLink size={42} />} title={t('pairs.emptyTitle')}>
          {t('pairs.emptyBody')}
        </EmptyState>
      ) : (
        <>
          {candidates.length > 0 && (
            <section aria-label={t('pairs.section.needsReview')}>
              <h2 className="section-title">
                {t('pairs.section.needsReview')}{' '}
                <span className="section-title__count">{f.number(candidates.length)}</span>
                {isAdmin && candidates.length > 1 && (
                  <button
                    className="btn btn--ghost section-title__action"
                    disabled={confirmingAll}
                    onClick={() => void confirmAll(candidates.map((p) => p.id))}
                  >
                    {confirmingAll
                      ? t('pairs.section.linking')
                      : t('pairs.section.linkAll', { n: candidates.length })}
                  </button>
                )}
              </h2>
              {candidates.map((p) => (
                <PairCard
                  speedRatio={summary?.speedRatio ?? 0}
                  key={p.id}
                  pair={p}
                  busy={busyId === p.id}
                  isAdmin={isAdmin}
                  onAction={act}
                  onLanguage={setLanguage}
                  onDownloadModel={downloadModel}
                  selectable={startable.some((s) => s.id === p.id)}
                  selected={selected.has(p.id)}
                  onSelect={toggleSelected}
                />
              ))}
            </section>
          )}
          {linked.length > 0 && (
            <section aria-label={t('pairs.section.linkedLabel')}>
              <h2 className="section-title">
                {t('pairs.section.linked')}{' '}
                <span className="section-title__count">{f.number(linked.length)}</span>
              </h2>
              {linked.map((p) => (
                <PairCard
                  speedRatio={summary?.speedRatio ?? 0}
                  key={p.id}
                  pair={p}
                  busy={busyId === p.id}
                  isAdmin={isAdmin}
                  onAction={act}
                  onLanguage={setLanguage}
                  onDownloadModel={downloadModel}
                  selectable={startable.some((s) => s.id === p.id)}
                  selected={selected.has(p.id)}
                  onSelect={toggleSelected}
                />
              ))}
            </section>
          )}
          {rejected.length > 0 && (
            <section aria-label={t('pairs.section.dismissedLabel')}>
              <h2 className="section-title">
                {t('pairs.section.dismissed')}{' '}
                <span className="section-title__count">{f.number(rejected.length)}</span>
              </h2>
              {rejected.map((p) => (
                <PairCard
                  speedRatio={summary?.speedRatio ?? 0}
                  key={p.id}
                  pair={p}
                  busy={busyId === p.id}
                  isAdmin={isAdmin}
                  onAction={act}
                  onLanguage={setLanguage}
                  onDownloadModel={downloadModel}
                  selectable={startable.some((s) => s.id === p.id)}
                  selected={selected.has(p.id)}
                  onSelect={toggleSelected}
                />
              ))}
            </section>
          )}
        </>
      )}
    </main>
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

function PairCard({
  pair,
  busy,
  isAdmin,
  onAction,
  onLanguage,
  onDownloadModel,
  selectable,
  selected,
  onSelect,
  speedRatio,
}: {
  pair: PairDto;
  busy: boolean;
  isAdmin: boolean;
  /** Seconds of audio aligned per second of wall clock; 0 = not yet measured. */
  speedRatio: number;
  onAction: (id: string, a: PairAction) => void;
  onLanguage: (id: string, language: string | null) => void;
  onDownloadModel: (modelId: string) => void;
  /** Verified, not aligned yet: offer it for bulk starting. */
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (id: string) => void;
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
  const running = job && (job.state === 'queued' || job.state === 'running');
  const lang = pair.language;

  return (
    <article
      id={`pair-${pair.id}`}
      className={`pair-card pair-card--${pair.status} ${selected ? 'is-selected' : ''}`}
    >
      {selectable && onSelect && (
        <label className="pair-card__pick">
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onSelect(pair.id)}
            aria-label={t('pairs.card.selectForAlignment', {
              title: pair.ebook?.title ?? t('pairs.card.thisPair'),
            })}
          />
          <span>{t('pairs.card.select')}</span>
        </label>
      )}
      <div className="pair-card__editions">
        <EditionTile book={pair.ebook} kind="ebook" />
        <span className="pair-card__link" aria-hidden="true">
          <IconSwitch size={18} />
        </span>
        <EditionTile
          book={pair.audio}
          kind="audio"
          extra={pair.audio?.durationMs ? formatDuration(pair.audio.durationMs) : undefined}
        />
      </div>

      <div className="pair-card__status">
        <span
          className={`badge ${pair.status === 'auto' || pair.status === 'confirmed' ? 'badge--paired' : pair.status === 'rejected' ? 'badge--muted' : ''}`}
        >
          {t('pairs.card.status', { status: pair.status })}
        </span>
        {pair.handoff?.available && (
          <span className="badge badge--sync">
            <IconSwitch size={11} />{' '}
            {t('pairs.card.switchReady', { pct: f.percent(pair.handoff.exactSentenceCoverage) })}
          </span>
        )}
        {/* What THIS book will cost, beside the button that starts it. The
            queue-wide total answers a different question, and a reader
            comparing one number against one book is how "it took longer than
            you said" happens. */}
        {!pair.alignment && speedRatio > 0 && pair.audio?.durationMs ? (
          <span className="badge badge--muted">
            {t('pairs.card.timeToAlign', { span: f.span(pair.audio.durationMs / speedRatio) })}
          </span>
        ) : null}
        <span className="pair-card__score">
          {t('pairs.card.match', { pct: f.percent(pair.score) })}
        </span>
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
        <div className="banner" key={i} style={{ marginBlockEnd: 8 }}>
          {n.done ? <IconCheck size={15} /> : <IconAlert size={15} />} <bdi>{n.text}</bdi>
        </div>
      ))}
      {pair.compat?.warning && (
        <div className="banner banner--error">
          <IconAlert size={15} /> <bdi>{pair.compat.warning}</bdi>
        </div>
      )}

      {running && job && (
        <div className="align-progress" role="status">
          <span className="spinner" style={{ width: 16, height: 16 }} />
          <span className="grow">
            <span style={{ fontWeight: 600 }}>
              {job.state === 'queued' ? t('pairs.job.queued') : t('pairs.job.aligning')}
            </span>
            {job.detail ? (
              <>
                {' - '}
                <bdi>{job.detail}</bdi>
              </>
            ) : null}
            <span className="progressbar" aria-hidden="true">
              <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </span>
          </span>
        </div>
      )}
      {job?.state === 'failed' && job.modelMissing && pair.status !== 'rejected' && (
        <div className="banner banner--action" role="alert">
          <IconDownload size={16} />
          <span className="grow">
            {/* One model covers every language, so there is only ever one
                thing missing and naming a language would misdescribe it. The
                old branch here compared against a model id that has not
                existed since forced alignment landed, so it always fell
                through to a model name nobody could act on. */}
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
          {isAdmin && (
            <button
              className="btn btn--ghost"
              style={{ minHeight: 36 }}
              onClick={() => onAction(pair.id, 'align')}
            >
              {t('common.retry')}
            </button>
          )}
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
        pair.status !== 'rejected' &&
        !running &&
        !job?.modelMissing && (
          <div style={{ fontSize: 13.5, color: 'var(--rp-text-soft)' }}>
            {t('pairs.card.unalignedNote')}
          </div>
        )
      )}

      <div className="pair-actions">
        {pair.status === 'candidate' && (
          <>
            <button
              className="btn"
              disabled={busy || !isAdmin}
              onClick={() => onAction(pair.id, 'confirm')}
            >
              <IconCheck size={16} /> {t('pairs.actions.linkEditions')}
            </button>
            <button
              className="btn btn--secondary"
              disabled={busy || !isAdmin}
              onClick={() => onAction(pair.id, 'reject')}
            >
              <IconClose size={16} /> {t('pairs.actions.notAMatch')}
            </button>
          </>
        )}
        {(pair.status === 'auto' || pair.status === 'confirmed') && (
          <>
            {!running && (
              <button
                className="btn btn--secondary"
                disabled={busy || !isAdmin}
                onClick={() => onAction(pair.id, 'align')}
              >
                {pair.alignment
                  ? t('pairs.actions.rerunAlignment')
                  : t('pairs.actions.runAlignment')}
              </button>
            )}
            <button
              className="btn btn--danger"
              disabled={busy || !isAdmin}
              onClick={() => onAction(pair.id, 'unlink')}
            >
              {t('pairs.actions.unlink')}
            </button>
          </>
        )}
        {pair.status === 'rejected' && (
          <button
            className="btn btn--secondary"
            disabled={busy || !isAdmin}
            onClick={() => onAction(pair.id, 'confirm')}
          >
            {t('pairs.actions.linkAnyway')}
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * Manual arbitrary pairing: pick any UNLINKED ebook and any unlinked
 * audiobook and link them. Complements automatic suggestions for titles whose
 * metadata never matches.
 *
 * The pickers used to offer the whole library, so a book that was already
 * linked sat in the list looking available - and choosing it either re-made
 * the link it already had or proposed a second one. `filter=unpaired` asks
 * the server for what is actually linkable, in SQL, because a library where
 * most titles are owned twice would otherwise send most of itself here to be
 * discarded in the browser.
 *
 * A `candidate` still appears: it is a suggestion nobody has answered, and
 * this sheet is where a reader goes when the suggestion is wrong.
 */
function ManualLinkSheet({ onClose, onLinked }: { onClose: () => void; onLinked: () => void }) {
  const t = useT();
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [ebookId, setEbookId] = useState('');
  const [audioId, setAudioId] = useState('');
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

function CoverageStrip({ pair }: { pair: PairDto }) {
  const t = useT();
  const f = useFormat();
  const [bars, setBars] = useState<{ minute: number; confidence: number }[] | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ confidenceByMinute: { minute: number; confidence: number }[] }>(
      `/api/pairs/${pair.id}/alignment`,
    )
      .then((r) => {
        if (alive) setBars(r.confidenceByMinute);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pair.id]);
  if (!bars || bars.length === 0) return null;
  const avg = bars.reduce((a, b) => a + b.confidence, 0) / bars.length;
  // One bar per audio minute makes a ten-hour book 600 bars wide. Average
  // them down to a fixed count so the strip fits its card on a phone.
  const shown = bucketCoverage(bars);
  return (
    <div
      className="coverage-strip"
      role="img"
      aria-label={t('pairs.coverage.label', { n: bars.length, pct: f.percent(avg) })}
    >
      {shown.map((b) => (
        <span
          key={b.minute}
          style={{
            height: `${Math.max(12, b.confidence * 100)}%`,
            opacity: 0.35 + b.confidence * 0.65,
          }}
          title={
            b.minutes === 1
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
