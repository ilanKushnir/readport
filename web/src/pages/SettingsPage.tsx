import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  COVER_SOURCES,
  DEFAULT_UI_LOCALE,
  suggestUiLocale,
  type CoverSourceName,
  type Job,
  type Settings,
} from '@readport/shared';
import { api, ApiError, failureMessage } from '../api/client';
import { useSession } from '../state/session';
import { useToast } from '../components/ui';
import {
  IconAlert,
  IconCheck,
  IconDownload,
  IconGitHub,
  IconTrash,
  ReadPortMark,
} from '../components/icons';
import { useI18n, useT, type TranslateFn } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { type MessageKey } from '../i18n/messages/en';
import { storageEstimate } from '../offline/downloads';
import { alignerModel, type ModelInfo, type ModelsResponse } from '../lib/types';
import { applyAppThemeColor } from '../lib/themeColor';
import { ConnectedAppsSection } from './ConnectedApps';
import { openWhatsNew } from '../whatsnew/open';
import { Link } from 'react-router-dom';
import { folderApi, LibraryFolders } from '../components/LibraryFolders';
import { AccountMenu } from '../components/AccountMenu';
import { COVER_SOURCE_NAME } from '../lib/cover';

interface DashboardStats {
  ebooks: number;
  audiobooks: number;
  booksIndexing: number;
  pairsLinked: number;
  pairsCandidate: number;
  pairsAligned: number;
  jobsRunning: number;
  jobsQueued: number;
  jobsFailed: number;
  users: number;
}

interface SettingsResponse {
  settings: Settings;
  envPinned: string[];
  stats?: DashboardStats;
  paths: {
    dataDir: string;
    cacheDir: string;
    modelsDir: string;
    ebookDirs: string[];
    audiobookDirs: string[];
    alignmentDirs: string[];
  };
  alignments?: {
    dirs: string[];
    writeDir: string;
    files: number;
    bytes: number;
    problem: string | null;
  };
  precedence: string;
}

/**
 * A job type as words. The server's known types have a name of their own; a
 * type this build has not heard of reads as itself, with its dashes spaced
 * out, rather than as a blank.
 */
function jobTypeName(t: TranslateFn, type: string): string {
  const named = t('settings.jobs.type', { type });
  if (named !== type) return named;
  const words = type.replace(/[-_]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function SettingsPage() {
  const { user, via, hasPassword, logout } = useSession();
  const t = useT();
  const f = useFormat();
  const { locales, chosen, setLocale } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [appTheme, setAppTheme] = useState<string>(
    () => localStorage.getItem('rp-app-theme') ?? 'auto',
  );
  const isAdmin = user?.role === 'admin';
  const stats = data?.stats ?? null;
  // One catalog for the whole page, so the overview card, the engine-readiness
  // panel and the model cards can never disagree about what is installed.
  const { models, reload: reloadModels } = useModels();
  const aligner = alignerModel(models);
  // What "follow the browser" resolves to right now, named in its own language.
  const suggestedLanguage = useMemo(() => {
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
    const code = suggestUiLocale(languages) ?? DEFAULT_UI_LOCALE;
    return locales.find((l) => l.code === code)?.native ?? code;
  }, [locales]);

  const load = useCallback(async () => {
    try {
      setData(await api<SettingsResponse>('/api/settings'));
      setLoadFailed(false);
      const j = await api<{ jobs: Job[] }>('/api/jobs');
      setJobs(j.jobs);
    } catch {
      setLoadFailed(true);
    }
    setStorage(await storageEstimate());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const root = document.documentElement;
    if (appTheme === 'auto') root.removeAttribute('data-app-theme');
    else root.setAttribute('data-app-theme', appTheme);
    localStorage.setItem('rp-app-theme', appTheme);
    applyAppThemeColor();
  }, [appTheme]);

  // Deep link from the pairing page: /settings#alignment
  useEffect(() => {
    if (!data || location.hash !== '#alignment') return;
    document.getElementById('alignment')?.scrollIntoView({ block: 'start' });
  }, [data]);

  const save = async (patch?: Partial<Settings>) => {
    setSaving(true);
    try {
      const body = patch ?? draft;
      const res = await api<{ settings: Settings }>('/api/settings', {
        method: 'PUT',
        body,
      });
      setData((d) => (d ? { ...d, settings: res.settings } : d));
      if (!patch) setDraft({});
      toast.show(t('settings.saved'));
    } catch (err) {
      toast.show(failureMessage(err, t('settings.couldNotSave'), t));
    } finally {
      setSaving(false);
    }
  };

  const rescan = async () => {
    try {
      await api('/api/library/rescan', { method: 'POST' });
      toast.show(t('settings.libraries.rescanQueued'));
      void load();
    } catch {
      toast.show(t('settings.libraries.rescanFailed'));
    }
  };

  // Settings is one of the three permanent tabs, so it has to answer for
  // itself with no server: what is on this device, and why the rest is
  // missing. A spinner that never resolves is not an answer.
  if (!data) {
    if (!loadFailed) {
      return (
        <main className="app-main" id="main-content" tabIndex={-1} aria-busy="true">
          <div className="skeleton" style={{ height: 200 }} />
        </main>
      );
    }
    return (
      <main
        className="app-main settings-page"
        id="main-content"
        tabIndex={-1}
        style={{ '--rp-measure': '900px' } as React.CSSProperties}
      >
        <header className="page-head">
          <h1>{t('nav.settings')}</h1>
        </header>
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} />
          <span style={{ flex: 1 }}>{t('settings.serverUnreachable')}</span>
          <button className="btn btn--ghost" style={{ minHeight: 36 }} onClick={() => void load()}>
            {t('common.retry')}
          </button>
        </div>
        <OfflineStorageSection storage={storage} />
      </main>
    );
  }

  const s = { ...data.settings, ...draft };
  const modelsReady = Boolean(aligner?.installed);
  const pinned = (k: string) => data.envPinned.includes(k);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const dirty = Object.keys(draft).length > 0;
  // Paths are technical values: isolated so they read left-to-right whatever
  // direction the page runs in.
  const folderList = (dirs: string[]) =>
    dirs.length > 0 ? <bdi>{dirs.join(', ')}</bdi> : t('settings.libraries.notConfigured');

  return (
    <main
      className="app-main settings-page"
      id="main-content"
      tabIndex={-1}
      style={{ '--rp-measure': '900px' } as React.CSSProperties}
    >
      <header className="page-head">
        {/* The title, and at its far end who is signed in - with the way
            out - where an account is looked for. */}
        <div className="page-head__titlerow">
          <h1>{t('nav.settings')}</h1>
          <AccountMenu
            onAccount={() => {
              const section = document.getElementById('account');
              section?.scrollIntoView({
                block: 'start',
                behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
                  ? 'auto'
                  : 'smooth',
              });
              section?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
            }}
          />
        </div>
        <p>{t('settings.lede')}</p>
      </header>

      {stats && (
        <section className="dash" aria-label={t('settings.overview.label')}>
          <DashCard
            to="#libraries"
            label={t('nav.library')}
            value={f.number(stats.ebooks + stats.audiobooks)}
            unit={t('settings.overview.titles')}
            detail={
              stats.booksIndexing > 0
                ? t('settings.overview.stillIndexing', { n: stats.booksIndexing })
                : t('settings.overview.libraryBreakdown', {
                    ebooks: stats.ebooks,
                    audiobooks: stats.audiobooks,
                  })
            }
            busy={stats.booksIndexing > 0}
          />
          <DashCard
            to="/pairs"
            label={t('settings.overview.pairs')}
            value={f.number(stats.pairsLinked)}
            unit={t('settings.overview.linked')}
            detail={
              stats.pairsCandidate > 0
                ? t('settings.overview.awaitingReview', { n: stats.pairsCandidate })
                : t('settings.overview.aligned', { n: stats.pairsAligned })
            }
          />
          <DashCard
            to="/pairs"
            label={t('settings.overview.processing')}
            value={stats.jobsRunning > 0 ? f.number(stats.jobsRunning) : '-'}
            unit={
              stats.jobsRunning > 0 ? t('settings.overview.running') : t('settings.overview.idle')
            }
            detail={
              stats.jobsQueued > 0
                ? t('settings.overview.waiting', { n: stats.jobsQueued })
                : stats.jobsFailed > 0
                  ? t('settings.overview.failed', { n: stats.jobsFailed })
                  : s.autoAlign
                    ? t('settings.overview.aligningNewMatches')
                    : t('settings.overview.manual')
            }
            busy={stats.jobsRunning > 0}
            warn={stats.jobsRunning === 0 && stats.jobsFailed > 0}
          />
          <DashCard
            to="#alignment"
            label={t('settings.alignment.title')}
            value={
              !models
                ? '-'
                : modelsReady
                  ? t('settings.overview.ready')
                  : t('settings.overview.setUp')
            }
            unit={modelsReady ? t('settings.overview.toAlign') : t('settings.overview.needed')}
            detail={
              !models
                ? t('settings.overview.unavailable')
                : modelsReady
                  ? t('settings.overview.modelInstalled')
                  : t('settings.overview.modelNotInstalled')
            }
            warn={Boolean(models) && !modelsReady}
          />
          {isAdmin && (
            <DashCard
              to="/settings/people"
              label={t('settings.overview.people')}
              value={f.number(stats.users)}
              unit={t('settings.overview.accounts', { n: stats.users })}
              detail={t('settings.overview.rolesAndInvitations')}
            />
          )}
          <DashCard
            to="#offline"
            label={t('settings.overview.offline')}
            value={storage ? f.bytes(storage.usage) : '-'}
            unit={t('settings.overview.onThisDevice')}
            detail={
              storage
                ? t('settings.overview.ofAbout', { quota: f.bytes(storage.quota) })
                : t('settings.overview.notReported')
            }
          />
        </section>
      )}

      <section
        className="settings-section"
        aria-label={t('settings.libraries.title')}
        id="libraries"
      >
        <h2>{t('settings.libraries.title')}</h2>
        <p className="settings-section__lede">{t('settings.libraries.lede')}</p>
        {isAdmin ? (
          <LibrariesEditor
            data={data}
            onSaved={(paths) => setData((d) => (d ? { ...d, paths: { ...d.paths, ...paths } } : d))}
          />
        ) : (
          <dl style={{ margin: 0 }}>
            <div className="kv">
              <dt>{t('settings.libraries.ebookFolders')}</dt>
              <dd>{folderList(data.paths.ebookDirs)}</dd>
            </div>
            <div className="kv">
              <dt>{t('settings.libraries.audiobookFolders')}</dt>
              <dd>{folderList(data.paths.audiobookDirs)}</dd>
            </div>
            <div className="kv">
              <dt>{t('settings.libraries.alignmentFolder')}</dt>
              <dd>{folderList(data.paths.alignmentDirs)}</dd>
            </div>
          </dl>
        )}
        {isAdmin && (
          <div style={{ marginBlockStart: 'var(--sp-4)' }}>
            <button className="btn btn--secondary" onClick={() => void rescan()}>
              {t('settings.libraries.rescanNow')}
            </button>
          </div>
        )}
        {isAdmin && (
          <CoverSources
            sources={s.coverSources}
            auto={s.coverSuggestions}
            onSave={(patch) => void save(patch)}
          />
        )}
      </section>

      <section className="settings-section" aria-label={t('settings.appearance.title')}>
        <h2>{t('settings.appearance.title')}</h2>
        <div className="field">
          <label htmlFor="set-theme">{t('settings.appearance.appTheme')}</label>
          <div
            className="segmented"
            role="group"
            aria-label={t('settings.appearance.appTheme')}
            id="set-theme"
          >
            {(['auto', 'light', 'dark'] as const).map((theme) => (
              <button
                key={theme}
                aria-pressed={appTheme === theme}
                onClick={() => setAppTheme(theme)}
              >
                {t('settings.appearance.theme', { theme })}
              </button>
            ))}
          </div>
          <span className="hint">{t('settings.appearance.readerThemeHint')}</span>
        </div>
        {/* The interface language. Each entry is listed in its own language,
            which is how someone who cannot read the current one finds it; the
            first entry follows the browser, and says what that means today. */}
        <div className="field">
          <label htmlFor="set-locale">{t('language.pickerTitle')}</label>
          <select
            id="set-locale"
            className="input input--select"
            value={chosen ?? ''}
            onChange={(e) => void setLocale(e.target.value || null)}
          >
            <option value="">{t('language.followBrowser', { name: suggestedLanguage })}</option>
            {locales.map((l) => (
              <option key={l.code} value={l.code} lang={l.code}>
                {l.native}
              </option>
            ))}
          </select>
          <span className="hint">{t('language.generatedNote')}</span>
        </div>
      </section>

      <AlignmentSection
        settings={s}
        isAdmin={isAdmin}
        pinned={pinned}
        models={models}
        reload={reloadModels}
        onSave={(patch) => void save(patch)}
        onDraft={set}
        dirty={dirty}
        saving={saving}
        onCommit={() => void save()}
        speedRatio={s.alignSpeedRatio}
      />

      <OfflineStorageSection storage={storage} />

      <section className="settings-section" aria-label={t('settings.jobs.title')}>
        <h2>{t('settings.jobs.title')}</h2>
        {jobs.length === 0 ? (
          <p style={{ color: 'var(--rp-text-soft)', fontSize: 14.5 }}>{t('settings.jobs.none')}</p>
        ) : (
          <div className="list-card">
            {jobs.slice(0, 12).map((j) => (
              <div className="list-row" key={j.id} style={{ cursor: 'default' }}>
                {j.state === 'running' ? (
                  <span className="spinner" style={{ width: 15, height: 15 }} />
                ) : j.state === 'failed' ? (
                  <IconAlert size={15} style={{ color: 'var(--rp-danger)' }} />
                ) : (
                  <IconCheck size={15} style={{ opacity: j.state === 'done' ? 1 : 0.4 }} />
                )}
                <span className="grow" style={{ whiteSpace: 'normal' }}>
                  <span style={{ fontWeight: 600 }}>{jobTypeName(t, j.type)}</span>
                  {j.detail ? (
                    <>
                      {' - '}
                      <bdi>{j.detail}</bdi>
                    </>
                  ) : (
                    ''
                  )}
                  {j.error ? (
                    <span style={{ display: 'block', color: 'var(--rp-danger)', fontSize: 13 }}>
                      <bdi>{j.error.replace(/^model-missing:[^|]*\|/, '')}</bdi>
                    </span>
                  ) : null}
                </span>
                <span className="soft">
                  {t('settings.jobs.state', { state: j.state })} · {f.date(j.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="settings-section" aria-label={t('settings.account.title')} id="account">
        <h2 tabIndex={-1}>{t('settings.account.title')}</h2>
        <p style={{ fontSize: 14.5 }}>
          {t('settings.account.signedInAs')} <strong>{user?.displayName ?? user?.username}</strong>
          {user?.displayName ? (
            <>
              {' ('}
              <bdi>@{user.username}</bdi>)
            </>
          ) : (
            ''
          )}{' '}
          ·{' '}
          {t('settings.account.roleLine', {
            role: t('settings.account.role', { role: user?.role ?? 'reader' }),
            via,
          })}
        </p>
        <AccountSelfService via={via} hasPassword={hasPassword} />
        {via === 'proxy' ? (
          <p style={{ fontSize: 13.5, color: 'var(--rp-text-soft)' }}>
            {t('settings.account.proxySignOut', { app: t('common.appName') })}
          </p>
        ) : (
          <button className="btn btn--secondary" onClick={() => void logout()}>
            {t('settings.account.signOut')}
          </button>
        )}
      </section>

      {isAdmin && <PublicAddressSection settings={s} onDraft={set} />}
      {isAdmin && <ConnectedAppsSection key={JSON.stringify(s.apps)} initial={s.apps} />}

      <ApiKeysSection />

      {/* Which build this is, and where it comes from. The version is the
          one way back to What's new after it has been dismissed. */}
      <footer className="settings-foot">
        <button
          type="button"
          className="settings-foot__version"
          onClick={openWhatsNew}
          title={t('whatsnew.title')}
        >
          <ReadPortMark size={18} style={{ color: 'var(--rp-primary)' }} />
          <span className="settings-foot__name">{t('common.appName')}</span>
          <span className="settings-foot__num">
            {t('whatsnew.eyebrow', { version: __APP_VERSION__ })}
          </span>
        </button>
        <a
          className="settings-foot__github"
          href="https://github.com/ilanKushnir/readport"
          target="_blank"
          rel="noopener noreferrer"
        >
          <IconGitHub size={17} /> GitHub
        </a>
      </footer>
    </main>
  );
}

/**
 * The address this server answers to from outside.
 *
 * Only matters for sharing. An invitation link is built from it, so without
 * one a link made on the admin's laptop points at a LAN name their friend
 * cannot resolve - the invitation looks fine and simply does not open.
 */
function PublicAddressSection({
  settings,
  onDraft,
}: {
  settings: Settings;
  onDraft: (k: 'publicUrl', v: string) => void;
}) {
  const t = useT();
  const value = settings.publicUrl ?? '';
  // Not validation, a warning: plenty of valid setups are http, and it is not
  // this field's job to refuse them.
  const looksLocal = /^https?:\/\/(localhost|127\.|192\.168\.|10\.|\[?::1)|\.lan(?::|\/|$)/i.test(
    value,
  );
  return (
    <section className="settings-section" aria-label={t('settings.sharing.title')} id="sharing">
      <h2>{t('settings.sharing.title')}</h2>
      <p className="settings-section__lede">{t('settings.sharing.lede')}</p>
      <div className="field">
        <label htmlFor="set-public">{t('settings.sharing.publicAddress')}</label>
        <input
          id="set-public"
          className="input"
          inputMode="url"
          dir="ltr"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://readport.example.com"
          value={value}
          onChange={(e) => onDraft('publicUrl', e.target.value)}
        />
        <span className="hint">
          {value.trim() === ''
            ? t('settings.sharing.emptyHint')
            : looksLocal
              ? t('settings.sharing.localHint')
              : t('settings.sharing.usedHint')}
        </span>
      </div>
    </section>
  );
}

/**
 * Read-only keys, for a person's own agents.
 *
 * The distinction the copy has to carry: a key lets something SEE your
 * library, and can never change it or take the files. That is what makes it
 * safe to paste into an assistant, and it is the first thing someone will
 * want to know before they do.
 */
function ApiKeysSection() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyDto[] | null>(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys((await api<{ keys: ApiKeyDto[] }>('/api/keys')).keys);
    } catch {
      setKeys([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const res = await api<{ key: string }>('/api/keys', {
        method: 'POST',
        body: { name: name.trim() || t('settings.keys.defaultName') },
      });
      setFresh(res.key);
      setName('');
      await load();
    } catch (err) {
      toast.show(failureMessage(err, t('settings.keys.couldNotCreate'), t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-label={t('settings.keys.title')} id="keys">
      <h2>{t('settings.keys.title')}</h2>
      <p className="settings-section__lede">{t('settings.keys.lede')}</p>

      {fresh && (
        <div className="banner" role="status">
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{t('settings.keys.copyNow')}</strong> {t('settings.keys.notShownAgain')}
            <code className="apikey" dir="ltr">
              {fresh}
            </code>
          </div>
          <button
            className="btn btn--secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(fresh).then(
                () => toast.show(t('settings.keys.copied')),
                () => toast.show(t('settings.keys.copyFailed')),
              );
            }}
          >
            {t('settings.keys.copy')}
          </button>
          <button className="btn btn--ghost" onClick={() => setFresh(null)}>
            {t('common.done')}
          </button>
        </div>
      )}

      {keys && keys.length > 0 && (
        <ul className="keylist">
          {keys.map((k) => (
            <li key={k.id} className="keylist__row">
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{k.name}</strong>
                <span className="hint" style={{ display: 'block' }}>
                  <bdi>rp_{k.prefix}…</bdi> ·{' '}
                  {k.lastUsedAt
                    ? t('settings.keys.lastUsed', { when: f.ago(k.lastUsedAt) })
                    : t('settings.keys.neverUsed')}
                </span>
              </span>
              <button
                className="btn btn--ghost"
                onClick={() => {
                  void api(`/api/keys/${k.id}`, { method: 'DELETE' })
                    .then(() => {
                      toast.show(t('settings.keys.revoked'));
                      return load();
                    })
                    .catch((err) =>
                      toast.show(failureMessage(err, t('settings.keys.couldNotRevoke'), t)),
                    );
                }}
              >
                {t('settings.keys.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="folders__add">
        <input
          className="input"
          placeholder={t('settings.keys.namePlaceholder')}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
        />
        <button className="btn btn--secondary" disabled={busy} onClick={() => void create()}>
          {busy ? t('settings.keys.creating') : t('settings.keys.newKey')}
        </button>
      </div>
    </section>
  );
}

interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function LibrariesEditor({
  data,
  onSaved,
}: {
  data: SettingsResponse;
  onSaved: (paths: {
    ebookDirs: string[];
    audiobookDirs: string[];
    alignmentDirs: string[];
  }) => void;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const [ebookDirs, setEbookDirs] = useState(data.paths.ebookDirs);
  const [audioDirs, setAudioDirs] = useState(data.paths.audiobookDirs);
  const [alignDirs, setAlignDirs] = useState(data.paths.alignmentDirs);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<'import' | 'export' | null>(null);
  const [importSaved, setImportSaved] = useState(data.settings.importSavedAlignments);
  const { user } = useSession();
  const canEdit = user?.role === 'admin';
  const folders = useMemo(() => folderApi(), []);
  const pinnedE = data.envPinned.includes('ebookDirs');
  const pinnedA = data.envPinned.includes('audiobookDirs');
  const pinnedAl = data.envPinned.includes('alignmentDirs');
  const dirty =
    ebookDirs.join('\n') !== data.paths.ebookDirs.join('\n') ||
    audioDirs.join('\n') !== data.paths.audiobookDirs.join('\n') ||
    alignDirs.join('\n') !== data.paths.alignmentDirs.join('\n');
  const run = async (what: 'import' | 'export') => {
    setBusy(what);
    try {
      await api(`/api/alignments/${what}`, { method: 'POST' });
      toast.show(
        what === 'import'
          ? t('settings.libraries.importStarted')
          : t('settings.libraries.exportStarted'),
      );
    } catch (err) {
      toast.show(failureMessage(err, t('settings.libraries.couldNotStart'), t));
    } finally {
      setBusy(null);
    }
  };
  const setImport = async (next: boolean) => {
    setImportSaved(next);
    try {
      await api('/api/settings', { method: 'PUT', body: { importSavedAlignments: next } });
    } catch (err) {
      setImportSaved(!next);
      toast.show(failureMessage(err, t('settings.libraries.couldNotSaveThat'), t));
    }
  };
  const save = async () => {
    setSaving(true);
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: {
          ...(pinnedE ? {} : { ebookDirs }),
          ...(pinnedA ? {} : { audiobookDirs: audioDirs }),
          ...(pinnedAl ? {} : { alignmentDirs: alignDirs }),
        },
      });
      onSaved({ ebookDirs, audiobookDirs: audioDirs, alignmentDirs: alignDirs });
      await api('/api/library/rescan', { method: 'POST' }).catch(() => {});
      toast.show(t('settings.libraries.foldersSaved'));
    } catch {
      toast.show(t('settings.libraries.couldNotSaveFolders'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div>
      <h3 className="settings-h3">{t('settings.libraries.ebookFolders')}</h3>
      <LibraryFolders
        kind="ebook"
        value={ebookDirs}
        onChange={setEbookDirs}
        folders={folders}
        disabled={pinnedE}
        pinnedNote={pinnedE ? t('settings.libraries.pinnedBy', { name: 'RP_EBOOK_DIRS' }) : null}
      />
      <h3 className="settings-h3">{t('settings.libraries.audiobookFolders')}</h3>
      <LibraryFolders
        kind="audio"
        value={audioDirs}
        onChange={setAudioDirs}
        folders={folders}
        disabled={pinnedA}
        pinnedNote={
          pinnedA ? t('settings.libraries.pinnedBy', { name: 'RP_AUDIOBOOK_DIRS' }) : null
        }
      />
      <h3 className="settings-h3">{t('settings.libraries.alignmentFolder')}</h3>
      <p className="settings-section__lede">
        {t('settings.libraries.alignmentFolderLede', { app: t('common.appName') })}
      </p>
      <LibraryFolders
        kind="alignment"
        value={alignDirs}
        onChange={setAlignDirs}
        folders={folders}
        disabled={pinnedAl}
        pinnedNote={
          pinnedAl ? t('settings.libraries.pinnedBy', { name: 'RP_ALIGNMENT_DIRS' }) : null
        }
      />
      {data.alignments && (
        <div className="align-store">
          <p className="align-store__stat">
            {data.alignments.files === 0
              ? t('settings.libraries.nothingSavedYet')
              : t('settings.libraries.savedCount', {
                  n: data.alignments.files,
                  size: f.bytes(data.alignments.bytes),
                })}
            {data.alignments.problem ? (
              <>
                {' - '}
                <bdi>{data.alignments.problem}</bdi>
              </>
            ) : (
              ''
            )}
          </p>
          {/* The redeploy question, kept beside the count that answers it:
              adopt what is already here, or time every book again. Off leaves
              the files alone rather than deleting them, so it is reversible. */}
          <label className="rs-toggle" style={{ maxWidth: 620 }}>
            <span>
              {t('settings.libraries.useExisting')}
              <span className="hint" style={{ display: 'block' }}>
                {data.alignments.files > 0
                  ? t('settings.libraries.useExistingOnHint', { n: data.alignments.files })
                  : t('settings.libraries.useExistingHint')}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              disabled={!canEdit}
              checked={importSaved}
              onChange={(e) => void setImport(e.target.checked)}
            />
          </label>
          <div className="align-store__actions">
            <button
              className="btn btn--secondary"
              disabled={busy !== null}
              onClick={() => void run('export')}
            >
              {t('settings.libraries.exportAll')}
            </button>
            <button
              className="btn btn--ghost"
              disabled={busy !== null}
              onClick={() => void run('import')}
            >
              {t('settings.libraries.importExisting')}
            </button>
          </div>
        </div>
      )}
      {dirty && (
        <button
          className="btn"
          style={{ marginTop: 'var(--sp-3)' }}
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? t('common.saving') : t('settings.libraries.saveAndRescan')}
        </button>
      )}
    </div>
  );
}

const COVER_SOURCE_HINT: Record<CoverSourceName, MessageKey> = {
  apple: 'settings.covers.appleHint',
  audible: 'settings.covers.audibleHint',
  google: 'settings.covers.googleHint',
  openlibrary: 'settings.covers.openlibraryHint',
};

/**
 * Where covers for books without one are looked up, and whether that
 * happens by itself. Each source is a choice an admin makes knowingly -
 * what it is good at is said beside it - and choosing none means covers
 * come only from a book's other format, with nothing asked of anyone.
 */
function CoverSources({
  sources,
  auto,
  onSave,
}: {
  sources: readonly CoverSourceName[];
  auto: boolean;
  onSave: (patch: Partial<Settings>) => void;
}) {
  const t = useT();
  const on = new Set(sources);
  const toggle = (source: CoverSourceName) =>
    onSave({
      coverSources: COVER_SOURCES.filter((x) => (x === source ? !on.has(x) : on.has(x))),
    });
  return (
    <div className="cover-sources">
      <h3 className="settings-h3">{t('settings.covers.title')}</h3>
      <p className="hint">{t('settings.covers.lede')}</p>
      <fieldset className="cover-sources__list">
        <legend className="cover-sources__legend">{t('settings.covers.where')}</legend>
        {COVER_SOURCES.map((source) => (
          <label key={source} className="cover-source">
            <input type="checkbox" checked={on.has(source)} onChange={() => toggle(source)} />
            <span>
              <span className="cover-source__name">{COVER_SOURCE_NAME[source]}</span>
              <span className="hint">{t(COVER_SOURCE_HINT[source])}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {on.size === 0 && <p className="hint">{t('settings.covers.none')}</p>}
      <label className="rs-toggle" style={{ maxWidth: 620 }}>
        <span>
          {t('settings.covers.auto')}
          <span className="hint" style={{ display: 'block' }}>
            {t('settings.covers.autoHint')}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          disabled={on.size === 0}
          checked={auto && on.size > 0}
          onChange={(e) => onSave({ coverSuggestions: e.target.checked })}
        />
      </label>
    </div>
  );
}

function AccountSelfService({ via, hasPassword }: { via: string; hasPassword: boolean }) {
  const t = useT();
  const { user, refresh } = useSession();
  const toast = useToast();
  const [name, setName] = useState(user?.displayName ?? '');
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const saveName = async () => {
    setBusy(true);
    try {
      await api('/api/auth/me', { method: 'PATCH', body: { displayName: name.trim() || null } });
      await refresh();
      toast.show(t('settings.account.nameSaved'));
    } catch {
      toast.show(t('settings.account.couldNotSave'));
    } finally {
      setBusy(false);
    }
  };
  const changePw = async () => {
    setBusy(true);
    try {
      const r = await api<{ revokedOtherSessions: number }>('/api/auth/password', {
        method: 'POST',
        // Omitted, not blank, when there is nothing to prove: the server
        // decides whether this account is allowed to skip the check.
        body: hasPassword ? { currentPassword: cur, newPassword: next } : { newPassword: next },
      });
      setCur('');
      setNext('');
      await refresh();
      toast.show(
        r.revokedOtherSessions
          ? t('settings.account.passwordChangedRevoked', { n: r.revokedOtherSessions })
          : hasPassword
            ? t('settings.account.passwordChanged')
            : t('settings.account.passwordSet'),
      );
    } catch (err) {
      toast.show(
        err instanceof ApiError && err.code === 'bad-credentials'
          ? t('settings.account.wrongCurrentPassword')
          : err instanceof ApiError && err.code === 'invalid'
            ? err.message.replace(/^invalid:?\s*/, '')
            : t('settings.account.couldNotChangePassword'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="account-grid">
      <div className="field">
        <label htmlFor="ac-name">{t('settings.account.displayName')}</label>
        <div className="linkbox">
          <input
            id="ac-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={user?.username}
          />
          <button
            className="btn btn--secondary"
            disabled={busy || (name.trim() || '') === (user?.displayName ?? '')}
            onClick={() => void saveName()}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="ac-cur">
          {hasPassword ? t('settings.account.changePassword') : t('settings.account.addPassword')}
        </label>
        <div className="pw-row">
          {hasPassword && (
            <input
              id="ac-cur"
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder={t('settings.account.currentPassword')}
              value={cur}
              onChange={(e) => setCur(e.target.value)}
            />
          )}
          <input
            id={hasPassword ? undefined : 'ac-cur'}
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={
              hasPassword
                ? t('settings.account.newPasswordPlaceholder')
                : t('settings.account.passwordPlaceholder')
            }
            minLength={10}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-label={
              hasPassword ? t('settings.account.newPassword') : t('settings.account.password')
            }
          />
          <button
            className="btn btn--secondary"
            disabled={busy || (hasPassword && !cur) || next.length < 10}
            onClick={() => void changePw()}
          >
            {hasPassword ? t('settings.account.change') : t('settings.account.set')}
          </button>
        </div>
        <span className="hint">
          {hasPassword
            ? t('settings.account.otherDevicesHint')
            : via === 'proxy'
              ? t('settings.account.proxyPasswordHint')
              : t('settings.account.noPasswordHint')}
        </span>
      </div>
    </div>
  );
}

/**
 * What this device is holding. Reads nothing but the browser's own storage
 * estimate, so it is also the one part of Settings that still answers when
 * the server cannot be reached.
 */
function OfflineStorageSection({ storage }: { storage: { usage: number; quota: number } | null }) {
  const t = useT();
  const f = useFormat();
  return (
    <section className="settings-section" aria-label={t('settings.offline.title')} id="offline">
      <h2>{t('settings.offline.title')}</h2>
      {storage ? (
        <p style={{ fontSize: 14.5 }}>
          {t('settings.offline.usage', {
            usage: f.bytes(storage.usage),
            quota: f.bytes(storage.quota),
          })}
        </p>
      ) : (
        <p style={{ fontSize: 14.5, color: 'var(--rp-text-soft)' }}>
          {t('settings.offline.notReported')}
        </p>
      )}
      <p style={{ color: 'var(--rp-text-soft)', fontSize: 13.5 }}>
        {t('settings.offline.perTitle')}
      </p>
    </section>
  );
}

/**
 * One number with its meaning, linking to the section or page that explains
 * it. Anchors scroll within Settings; paths navigate.
 */
function DashCard({
  to,
  label,
  value,
  unit,
  detail,
  busy,
  warn,
}: {
  to: string;
  label: string;
  value: string;
  unit: string;
  detail: string;
  busy?: boolean;
  warn?: boolean;
}) {
  const body = (
    <>
      <span className="dash__label">
        {label}
        {busy && <span className="dash__pulse" aria-hidden="true" />}
      </span>
      <span className="dash__value">
        {value} <small>{unit}</small>
      </span>
      <span className="dash__detail">{detail}</span>
    </>
  );
  const cls = `dash__card ${warn ? 'is-warn' : ''}`;
  return to.startsWith('#') ? (
    <a className={cls} href={to}>
      {body}
    </a>
  ) : (
    <Link className={cls} to={to}>
      {body}
    </Link>
  );
}

/* ---------------------------------------------------- alignment engine */

/** The engines, in the order someone choosing one should consider them. */
/**
 * Alignment: four controls, in the order the questions arise. Is the model
 * here, does it run by itself, how closely does it listen, and what language
 * should it assume when a book does not say.
 *
 * The rule this section is written to: describe a CHOICE and its CONSEQUENCE,
 * never a mechanism the reader cannot choose between.
 */

/** Two outcomes, not two settings. Anything finer is a parameter, not a choice. */
const PRECISIONS: [Settings['alignPrecision'], MessageKey, MessageKey][] = [
  [
    'standard',
    'settings.alignment.precision.standard',
    'settings.alignment.precision.standardBlurb',
  ],
  ['exact', 'settings.alignment.precision.exact', 'settings.alignment.precision.exactBlurb'],
];

function AlignmentSection({
  settings,
  isAdmin,
  pinned,
  models,
  reload,
  onSave,
  onDraft,
  dirty,
  saving,
  onCommit,
  speedRatio,
}: {
  settings: Settings;
  isAdmin: boolean;
  pinned: (k: string) => boolean;
  models: ModelsResponse | null;
  reload: () => Promise<void>;
  onSave: (patch: Partial<Settings>) => void;
  onDraft: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  dirty: boolean;
  saving: boolean;
  onCommit: () => void;
  speedRatio: number;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const model = alignerModel(models);
  const runtime = models?.alignerRuntime ?? null;

  const download = async () => {
    if (!model) return;
    try {
      await api(`/api/models/${model.id}/download`, { method: 'POST' });
      toast.show(t('settings.model.downloading'));
      await reload();
    } catch (err) {
      toast.show(failureMessage(err, t('settings.alignment.couldNotStartDownload'), t));
    }
  };
  const remove = async () => {
    if (!model) return;
    try {
      await api(`/api/models/${model.id}`, { method: 'DELETE' });
      toast.show(t('settings.alignment.removed'));
      await reload();
    } catch (err) {
      toast.show(failureMessage(err, t('settings.alignment.couldNotRemove'), t));
    }
  };

  return (
    <section className="settings-section" aria-label={t('settings.alignment.title')} id="alignment">
      <h2>{t('settings.alignment.title')}</h2>
      <p className="settings-section__lede">{t('settings.alignment.lede')}</p>

      {model && (
        <SoloModelCard
          model={model}
          isAdmin={isAdmin}
          cta={t('settings.alignment.download')}
          licenceNote={t('settings.alignment.licenceNote', { app: t('common.appName') })}
          onDownload={() => void download()}
          onRemove={() => void remove()}
        />
      )}
      {models && !model && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} />
          <span className="grow">
            {t('settings.alignment.catalogOutOfDate', { app: t('common.appName') })}
          </span>
        </div>
      )}
      {model?.installed && runtime && !runtime.available && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} />
          <span className="grow">
            {t('settings.alignment.runtimeMissing')}
            {runtime.error ? (
              <span style={{ display: 'block', fontSize: 12.5, opacity: 0.85 }}>
                <bdi>{runtime.error}</bdi>
              </span>
            ) : null}
          </span>
        </div>
      )}

      <h3 className="settings-h3">{t('settings.alignment.whenItRuns')}</h3>
      <label className="rs-toggle" style={{ maxWidth: 620 }}>
        <span>
          {t('settings.alignment.autoAlign')}
          <span className="hint" style={{ display: 'block' }}>
            {speedRatio > 0
              ? t('settings.alignment.autoAlignTimed', {
                  span: f.span((6 * 3600_000) / speedRatio),
                })
              : t('settings.alignment.autoAlignHint')}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          disabled={!isAdmin}
          checked={settings.autoAlign}
          onChange={(e) => onSave({ autoAlign: e.target.checked })}
        />
      </label>

      <h3 className="settings-h3">{t('settings.alignment.precisionTitle')}</h3>
      <div
        className="role-picker"
        role="radiogroup"
        aria-label={t('settings.alignment.precisionTitle')}
      >
        {PRECISIONS.map(([value, label, blurb]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={settings.alignPrecision === value}
            disabled={!isAdmin}
            className={`role-picker__opt ${settings.alignPrecision === value ? 'is-on' : ''}`}
            onClick={() => onSave({ alignPrecision: value })}
          >
            <strong>{t(label)}</strong>
            <span>{t(blurb)}</span>
          </button>
        ))}
      </div>
      <p className="settings-section__lede">{t('settings.alignment.behindNote')}</p>

      <h3 className="settings-h3">{t('settings.alignment.languageTitle')}</h3>
      <div className="field">
        <label htmlFor="set-lang">
          {t('settings.alignment.fallbackLanguage')}{' '}
          {pinned('defaultLanguage') && <em>{t('settings.alignment.pinnedTag')}</em>}
        </label>
        <input
          id="set-lang"
          className="input"
          disabled={pinned('defaultLanguage') || !isAdmin}
          value={settings.defaultLanguage}
          maxLength={8}
          style={{ maxWidth: 120 }}
          onChange={(e) => onDraft('defaultLanguage', e.target.value)}
        />
        <span className="hint">{t('settings.alignment.fallbackHint')}</span>
      </div>
      {dirty && (
        <button className="btn" onClick={onCommit} disabled={saving}>
          <IconCheck size={16} />{' '}
          {saving ? t('common.saving') : t('settings.alignment.saveChanges')}
        </button>
      )}
    </section>
  );
}

function useModels(): { models: ModelsResponse | null; reload: () => Promise<void> } {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const reload = useCallback(async () => {
    try {
      setModels(await api<ModelsResponse>('/api/models'));
    } catch {
      /* non-fatal: the rest of Settings works without the catalog */
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const downloading = models?.models.some((m) => m.download) ?? false;
  useEffect(() => {
    if (downloading && !timer.current) timer.current = setInterval(() => void reload(), 2000);
    if (!downloading && timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [downloading, reload]);

  return { models, reload };
}

function SoloModelCard({
  model,
  isAdmin,
  badge,
  cta,
  licenceNote,
  style,
  onDownload,
  onRemove,
}: {
  model: ModelInfo;
  isAdmin: boolean;
  badge?: string | null;
  cta: string;
  licenceNote?: string;
  style?: CSSProperties;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const dl = model.download;
  return (
    <article
      className={`model-card ${model.installed ? 'is-installed' : ''}`}
      style={{ maxWidth: 620, ...style }}
    >
      <div className="model-card__head">
        <span className="model-card__lang" style={{ fontSize: 15, fontWeight: 650 }}>
          <bdi>{model.label}</bdi>
        </span>
        {model.installed ? (
          <span className="badge badge--sync">
            <IconCheck size={11} /> {t('settings.model.installed')}
          </span>
        ) : dl ? (
          <span className="badge">{t('settings.model.downloading')}</span>
        ) : (
          <span className="badge badge--muted">{t('settings.model.notInstalled')}</span>
        )}
        {badge && <span className="badge">{badge}</span>}
      </div>
      <p className="model-card__note" style={{ minHeight: 0 }}>
        <bdi>{model.note}</bdi>
      </p>
      {model.licence && (
        <p className="model-card__note" style={{ minHeight: 0 }}>
          <strong>{t('settings.model.licence', { licence: model.licence })}</strong>
          {licenceNote ? ` ${licenceNote}` : ''}
        </p>
      )}
      {dl ? (
        <div className="model-card__progress">
          <span className="progressbar" aria-hidden="true">
            <span style={{ width: `${Math.round(dl.progress * 100)}%` }} />
          </span>
          <span className="model-card__progress-text">
            {dl.detail ? (
              <bdi>{dl.detail}</bdi>
            ) : dl.state === 'queued' ? (
              t('settings.model.queued')
            ) : (
              t('settings.model.starting')
            )}
          </span>
        </div>
      ) : model.installed ? (
        <div className="model-card__actions">
          <span className="model-card__size">
            {t('settings.model.onDisk', { size: f.bytes(model.installedBytes) })}
          </span>
          {isAdmin && (
            <button className="btn btn--ghost" style={{ minHeight: 36 }} onClick={onRemove}>
              <IconTrash size={15} /> {t('common.remove')}
            </button>
          )}
        </div>
      ) : (
        <div className="model-card__actions">
          <span className="model-card__size">
            {t('settings.model.downloadSize', { size: f.bytes(model.sizeBytes) })}
          </span>
          {model.lastError && (
            <span className="model-card__error" title={model.lastError}>
              {t('settings.model.lastAttemptFailed')}
            </span>
          )}
          <button
            className="btn"
            style={{ minHeight: 38 }}
            disabled={!isAdmin}
            onClick={onDownload}
          >
            <IconDownload size={15} /> {model.lastError ? t('settings.model.retryDownload') : cta}
          </button>
        </div>
      )}
    </article>
  );
}
