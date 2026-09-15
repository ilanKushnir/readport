import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { LANGUAGES, type Job, type JobCount, type JobsResponse } from '@readport/shared';
import { api, ApiError } from '../api/client';
import { setupProgress } from '../lib/setupProgress';
import { useSession, type User } from '../state/session';
import {
  IconAlert,
  IconBookOpen,
  IconCheck,
  IconDownload,
  IconHeadphones,
  IconLink,
  ReadPortMark,
} from '../components/icons';
import { folderApi, LibraryFolders } from '../components/LibraryFolders';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import type { MessageKey } from '../i18n/messages/en';

/**
 * Setup wizard, in two modes.
 *
 * `first-run` - nobody exists yet: Welcome (bootstrap token) → Admin account
 * → Books → Ready.
 *
 * `libraries` - an admin already exists but no library folders are set. This
 * is the normal path behind reverse-proxy SSO, where the first user is
 * provisioned automatically and never sees a first-run screen: the same
 * wizard resumes at Books, authenticated by the session instead of the token.
 * Nothing is written until "Finish setup" in either mode.
 *
 * That last rule is why the model download is a CHOICE here and a POST inside
 * `finish()`: during first run there is no session yet, and
 * `/api/models/:id/download` is admin-only. Finishing keeps the operator on
 * the Ready screen - it turns into the live scan and download progress rather
 * than advancing to a step of its own.
 */

export type WizardMode = 'first-run' | 'libraries';

type StepId = 'welcome' | 'admin' | 'books' | 'ready';

const ALL_STEPS: { id: StepId; label: MessageKey }[] = [
  { id: 'welcome', label: 'auth.setup.steps.welcome' },
  { id: 'admin', label: 'auth.setup.steps.admin' },
  { id: 'books', label: 'auth.setup.steps.books' },
  { id: 'ready', label: 'auth.setup.steps.ready' },
];

/** Remembered when an admin chooses "Skip for now", so it stops asking. */
const SKIP_KEY = 'rp-setup-libraries-skipped';

/** server/src/alignment/model.ts */
const ALIGNER_ID = 'alignment-model';
/** Catalog size, used only until the server's own report arrives. */
const ALIGNER_BYTES = 317_341_664;

interface SetupStatus {
  needsSetup: boolean;
  setupTokenRequired: boolean;
  libraries: {
    ebookDirs: string[];
    audiobookDirs: string[];
    /** Absent on servers whose setup status predates the alignment folder. */
    alignmentDirs?: string[];
    envPinned: {
      ebookDirs: boolean;
      audiobookDirs: boolean;
      /** Absent on servers whose setup status predates the alignment folder. */
      alignmentDirs?: boolean;
      /** Only known once signed in; /api/setup/status does not report it. */
      defaultLanguage?: boolean;
    };
  } | null;
  languages: { code: string; label: string }[] | null;
  defaultLanguage: string | null;
}

/** Mirrors the report from POST /api/preflight (server/src/api/routes/preflight.ts). */
interface PreflightCheck {
  id: string;
  label: string;
  state: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  modelsDir: string;
  aligner: {
    id: string;
    label: string;
    licence: string | null;
    note: string;
    sizeBytes: number;
    installed: boolean;
    installedBytes: number;
    download: { state: string; progress: number; detail: string | null } | null;
    lastError: string | null;
  };
}

export function SetupWizard({
  mode = 'first-run',
  onDone,
}: {
  mode?: WizardMode;
  onDone?: () => void;
} = {}) {
  const { setUser, refresh } = useSession();
  const t = useT();
  const f = useFormat();
  const firstRun = mode === 'first-run';
  const STEPS = firstRun
    ? ALL_STEPS
    : ALL_STEPS.filter((s) => s.id !== 'welcome' && s.id !== 'admin');
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState<StepId>(firstRun ? 'welcome' : 'books');
  /** Ready screen, after Finish: same step, now showing what is running. */
  const [initializing, setInitializing] = useState(false);
  const [token, setToken] = useState('');
  const [tokenOk, setTokenOk] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ebookDirs, setEbookDirs] = useState<string[]>([]);
  const [audioDirs, setAudioDirs] = useState<string[]>([]);
  const [alignDirs, setAlignDirs] = useState<string[]>([]);
  const [language, setLanguage] = useState('en');
  const [autoAlign, setAutoAlign] = useState(true);
  /** How friends will reach this server; blank for a library nobody shares. */
  const [publicUrl, setPublicUrl] = useState('');
  const [importSaved, setImportSaved] = useState(true);
  const [wantAligner, setWantAligner] = useState(true);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [alignerFailed, setAlignerFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUser, setCreatedUser] = useState<User | null>(null);

  useEffect(() => {
    if (firstRun) {
      void api<SetupStatus>('/api/setup/status')
        .then((s) => {
          setStatus(s);
          setEbookDirs(s.libraries?.ebookDirs ?? []);
          setAudioDirs(s.libraries?.audiobookDirs ?? []);
          setAlignDirs(s.libraries?.alignmentDirs ?? []);
          setLanguage(s.defaultLanguage ?? 'en');
        })
        .catch(() => setError(t('auth.setup.unreachable')));
      return;
    }
    // Already signed in: the settings endpoint knows the folders and which of
    // them the environment pins. The stored `alignmentDirs` is read rather
    // than the resolved path, so "unset" stays unset.
    void api<{
      settings: {
        defaultLanguage: string;
        alignmentDirs: string[];
        autoAlign: boolean;
        publicUrl?: string;
        importSavedAlignments: boolean;
      };
      envPinned: string[];
      paths: { ebookDirs: string[]; audiobookDirs: string[] };
    }>('/api/settings')
      .then((s) => {
        setStatus({
          needsSetup: false,
          setupTokenRequired: false,
          libraries: {
            ebookDirs: s.paths.ebookDirs,
            audiobookDirs: s.paths.audiobookDirs,
            alignmentDirs: s.settings.alignmentDirs,
            envPinned: {
              ebookDirs: s.envPinned.includes('ebookDirs'),
              audiobookDirs: s.envPinned.includes('audiobookDirs'),
              alignmentDirs: s.envPinned.includes('alignmentDirs'),
              defaultLanguage: s.envPinned.includes('defaultLanguage'),
            },
          },
          languages: LANGUAGES.map((l) => ({ code: l.code, label: l.label })),
          defaultLanguage: s.settings.defaultLanguage,
        });
        setEbookDirs(s.paths.ebookDirs);
        setAudioDirs(s.paths.audiobookDirs);
        setAlignDirs(s.settings.alignmentDirs ?? []);
        setLanguage(s.settings.defaultLanguage);
        setAutoAlign(s.settings.autoAlign ?? true);
        setImportSaved(s.settings.importSavedAlignments ?? true);
        setPublicUrl(s.settings.publicUrl ?? '');
      })
      .catch(() => setError(t('auth.setup.unreachable')));
  }, [firstRun]);

  // First run authorises the folder probes with the bootstrap token; an
  // admin session needs no token.
  const setupHeaders = useMemo(
    () => (firstRun && token.trim() ? { 'x-rp-setup-token': token.trim() } : undefined),
    [firstRun, token],
  );
  const folders = useMemo(() => folderApi(firstRun ? token.trim() : undefined), [firstRun, token]);
  const stepIdx = STEPS.findIndex((s) => s.id === step);
  const pinned = {
    ebookDirs: status?.libraries?.envPinned.ebookDirs ?? false,
    audiobookDirs: status?.libraries?.envPinned.audiobookDirs ?? false,
    alignmentDirs: status?.libraries?.envPinned.alignmentDirs ?? false,
    defaultLanguage: status?.libraries?.envPinned.defaultLanguage ?? false,
  };
  const languages = status?.languages ?? [{ code: 'en', label: 'English' }];
  const languageLabel = f.languageName(language);
  const aligner = preflight?.aligner ?? null;

  /**
   * Server self-check. All three folder lists are sent with it because on
   * first run they exist only in this form - the server has not been told
   * about them yet. `alignmentDirs` is the one the app will write to, so the
   * writable probe needs it; a server whose /api/preflight body schema
   * predates that field ignores the key rather than rejecting the request.
   */
  const runPreflight = useCallback(async () => {
    setChecking(true);
    try {
      setPreflight(
        await api<PreflightReport>('/api/preflight', {
          method: 'POST',
          body: { ebookDirs, audiobookDirs: audioDirs, alignmentDirs: alignDirs },
          headers: setupHeaders,
        }),
      );
    } catch {
      // Not fatal: the wizard still works, it just cannot show the ticks.
      setPreflight(null);
    } finally {
      setChecking(false);
    }
  }, [ebookDirs, audioDirs, alignDirs, setupHeaders]);

  // Re-check on entering the screen that shows the result. `runPreflight`
  // only changes identity when the chosen folders do, and those cannot change
  // from here, so this does not re-fire while the operator reads.
  useEffect(() => {
    if (step === 'ready' && !initializing) void runPreflight();
  }, [step, initializing, runPreflight]);

  // Move focus to the new step's heading so a screen reader announces it and
  // the keyboard lands in the right place. Not on the very first render: the
  // token field's autoFocus owns that.
  const rendered = useRef(false);
  useEffect(() => {
    if (!rendered.current) {
      rendered.current = true;
      return;
    }
    document.querySelector<HTMLElement>('.wizard__body h1')?.focus();
  }, [step, initializing]);

  const welcomeNext = async (e: FormEvent) => {
    e.preventDefault();
    // Not knowing yet is not the same as knowing there is no lock. Treating
    // it as "open" would walk a locked instance straight past the only step
    // that collects the token, and strand it at Finish with a 403.
    if (!status) return;
    // The ordinary case: nothing to prove, so nothing to ask.
    if (!status.setupTokenRequired) {
      setError(null);
      setTokenOk(true);
      setStep('admin');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/api/setup/verify', { method: 'POST', body: { setupToken: token.trim() } });
      setTokenOk(true);
      setStep('admin');
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'bad-setup-token'
          ? t('auth.setup.welcome.badToken')
          : err instanceof ApiError && err.status === 429
            ? t('auth.setup.welcome.tooManyAttempts')
            : t('auth.setup.welcome.verifyFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  const adminNext = (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError(t('auth.form.passwordsMismatch'));
      return;
    }
    setError(null);
    setStep('books');
  };

  /**
   * Start the model download, now that a session exists. Deliberately
   * non-fatal: setup has already succeeded by the time this runs, and the
   * model can always be fetched later from Settings → Alignment.
   */
  const startAlignerDownload = async () => {
    if (!wantAligner) return;
    if (preflight?.aligner.installed || preflight?.aligner.download) return;
    try {
      await api(`/api/models/${preflight?.aligner.id ?? ALIGNER_ID}/download`, { method: 'POST' });
    } catch {
      setAlignerFailed(true);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!firstRun) {
        await api('/api/settings', {
          method: 'PUT',
          body: {
            ...(pinned.ebookDirs ? {} : { ebookDirs }),
            ...(pinned.audiobookDirs ? {} : { audiobookDirs: audioDirs }),
            ...(pinned.alignmentDirs ? {} : { alignmentDirs: alignDirs }),
            ...(pinned.defaultLanguage ? {} : { defaultLanguage: language }),
            autoAlign,
            importSavedAlignments: importSaved,
            publicUrl: publicUrl.trim(),
          },
        });
        await startAlignerDownload();
        await api('/api/library/rescan', { method: 'POST' }).catch(() => {});
        setInitializing(true);
        return;
      }
      const res = await api<{ user: User }>('/api/setup', {
        method: 'POST',
        body: {
          username,
          password,
          displayName: displayName.trim() || undefined,
          setupToken: token.trim() || undefined,
          ebookDirs,
          audiobookDirs: audioDirs,
          ...(alignDirs.length ? { alignmentDirs: alignDirs } : {}),
          defaultLanguage: language,
          autoAlign,
          importSavedAlignments: importSaved,
          ...(publicUrl.trim() ? { publicUrl: publicUrl.trim() } : {}),
        },
      });
      // The session cookie is set by /api/setup, so the admin-only download
      // endpoint is reachable from here on.
      await startAlignerDownload();
      setCreatedUser(res.user);
      setInitializing(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid'
          ? err.message.replace(/^invalid:?\s*/, '')
          : err instanceof ApiError && err.code === 'already-configured'
            ? t('auth.setup.ready.alreadyConfigured')
            : t('auth.setup.ready.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page wizard-page">
      <div className="auth-page__glow" aria-hidden="true" />
      <div className="wizard">
        <header className="wizard__head">
          <span className="brand">
            <ReadPortMark size={30} style={{ color: 'var(--rp-primary)' }} />
            <span className="brand__name">{t('common.appName')}</span>
          </span>
          <ol className="wizard__steps" aria-label={t('auth.setup.stepsLabel')}>
            {STEPS.map((s, i) => (
              <li
                key={s.id}
                className={i < stepIdx ? 'is-done' : i === stepIdx ? 'is-current' : ''}
                aria-current={i === stepIdx ? 'step' : undefined}
              >
                <span className="wizard__dot">
                  {i < stepIdx ? <IconCheck size={12} /> : f.number(i + 1)}
                </span>
                <span className="wizard__label">{t(s.label)}</span>
              </li>
            ))}
          </ol>
        </header>

        {error && (
          <div className="banner banner--error" role="alert">
            {error}
          </div>
        )}

        {step === 'welcome' && (
          <form className="wizard__body" onSubmit={welcomeNext}>
            <h1 tabIndex={-1}>{t('auth.setup.welcome.title')}</h1>
            <p className="lede">{t('auth.setup.welcome.lede')}</p>
            {status?.setupTokenRequired && (
              <div className="field">
                <label htmlFor="wz-token">{t('auth.setup.welcome.tokenLabel')}</label>
                <input
                  id="wz-token"
                  className="input"
                  dir="ltr"
                  autoComplete="off"
                  // iOS capitalises and autocorrects a text field by default,
                  // and the token is case-sensitive - it arrives as "Abc…"
                  // when the log said "abc…", and setup refuses it.
                  autoCapitalize="none"
                  autoCorrect="off"
                  required
                  autoFocus
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  spellCheck={false}
                />
                <span className="hint">{t('auth.setup.welcome.tokenHint')}</span>
              </div>
            )}
            <div className="wizard__actions">
              <button
                className="btn"
                type="submit"
                disabled={busy || !status || (status.setupTokenRequired && !token.trim())}
              >
                {busy
                  ? t('auth.setup.checking')
                  : status?.setupTokenRequired
                    ? t('common.continue')
                    : t('auth.setup.welcome.getStarted')}
              </button>
            </div>
          </form>
        )}

        {step === 'admin' && (
          <form className="wizard__body" onSubmit={adminNext}>
            <h1 tabIndex={-1}>{t('auth.setup.admin.title')}</h1>
            <p className="lede">{t('auth.setup.admin.lede')}</p>
            <div className="field">
              <label htmlFor="wz-name">{t('auth.form.displayName')}</label>
              <input
                id="wz-name"
                className="input"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t('auth.form.optional')}
              />
            </div>
            <div className="field">
              <label htmlFor="wz-user">{t('auth.form.username')}</label>
              <input
                id="wz-user"
                className="input"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                required
                minLength={3}
                pattern="[a-zA-Z0-9._\-]+"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="wizard__row">
              <div className="field">
                <label htmlFor="wz-pass">{t('auth.form.password')}</label>
                <input
                  id="wz-pass"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={10}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <span className="hint">{t('auth.form.passwordHint')}</span>
              </div>
              <div className="field">
                <label htmlFor="wz-confirm">{t('auth.setup.admin.confirm')}</label>
                <input
                  id="wz-confirm"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
            </div>
            <div className="wizard__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setStep('welcome')}>
                {t('common.back')}
              </button>
              <button className="btn" type="submit">
                {t('common.continue')}
              </button>
            </div>
          </form>
        )}

        {step === 'books' && (tokenOk || !firstRun) && (
          <div className="wizard__body">
            <h1 tabIndex={-1}>{t('auth.setup.books.title')}</h1>
            <p className="lede">{t('auth.setup.books.lede')}</p>
            <h2 className="wizard__h2">
              <IconBookOpen size={16} /> {t('auth.setup.books.ebookFolders')}
            </h2>
            <LibraryFolders
              kind="ebook"
              value={ebookDirs}
              onChange={setEbookDirs}
              folders={folders}
              disabled={pinned.ebookDirs}
              pinnedNote={
                pinned.ebookDirs
                  ? t('auth.setup.books.pinnedByEnv', { name: 'RP_EBOOK_DIRS' })
                  : null
              }
            />
            <h2 className="wizard__h2">
              <IconHeadphones size={16} /> {t('auth.setup.books.audiobookFolders')}
            </h2>
            <LibraryFolders
              kind="audio"
              value={audioDirs}
              onChange={setAudioDirs}
              folders={folders}
              disabled={pinned.audiobookDirs}
              pinnedNote={
                pinned.audiobookDirs
                  ? t('auth.setup.books.pinnedByEnv', { name: 'RP_AUDIOBOOK_DIRS' })
                  : null
              }
            />
            <h2 className="wizard__h2">
              <IconLink size={16} /> {t('auth.setup.books.alignmentFolder')}
            </h2>
            <p className="hint" style={{ marginBlockEnd: 10 }}>
              {t('auth.setup.books.alignmentHint')}
            </p>
            <LibraryFolders
              kind="alignment"
              value={alignDirs}
              onChange={setAlignDirs}
              folders={folders}
              disabled={pinned.alignmentDirs}
              pinnedNote={
                pinned.alignmentDirs
                  ? t('auth.setup.books.pinnedByEnv', { name: 'RP_ALIGNMENT_DIRS' })
                  : null
              }
            />
            <div className="field" style={{ marginBlockStart: 'var(--sp-5)' }}>
              <label htmlFor="wz-public">{t('auth.setup.books.publicUrlLabel')}</label>
              <input
                id="wz-public"
                className="input"
                dir="ltr"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://readport.example.com"
                value={publicUrl}
                onChange={(e) => setPublicUrl(e.target.value)}
              />
              <span className="hint">{t('auth.setup.books.publicUrlHint')}</span>
            </div>
            <div className="field" style={{ maxWidth: 340, marginBlockStart: 'var(--sp-5)' }}>
              <label htmlFor="wz-lang">{t('auth.setup.books.languageLabel')}</label>
              <select
                id="wz-lang"
                className="input"
                value={language}
                disabled={pinned.defaultLanguage}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {f.languageName(l.code)}
                  </option>
                ))}
              </select>
              <span className="hint">
                {pinned.defaultLanguage
                  ? t('auth.setup.books.pinnedByEnv', { name: 'RP_DEFAULT_LANGUAGE' })
                  : t('auth.setup.books.languageHint')}
              </span>
            </div>
            <div className="wizard__actions">
              {firstRun ? (
                <button type="button" className="btn btn--ghost" onClick={() => setStep('admin')}>
                  {t('common.back')}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    localStorage.setItem(SKIP_KEY, '1');
                    onDone?.();
                  }}
                >
                  {t('auth.setup.books.skip')}
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => setStep('ready')}
                disabled={!firstRun && ebookDirs.length + audioDirs.length === 0}
              >
                {firstRun && ebookDirs.length + audioDirs.length === 0
                  ? t('auth.setup.books.skip')
                  : t('common.continue')}
              </button>
            </div>
          </div>
        )}

        {step === 'ready' && !initializing && (
          <div className="wizard__body">
            <h1 tabIndex={-1}>{t('auth.setup.ready.title')}</h1>
            <p className="lede">{t('auth.setup.ready.lede')}</p>
            <dl className="review">
              {firstRun && (
                <div>
                  <dt>{t('auth.setup.steps.admin')}</dt>
                  <dd>
                    {displayName.trim() ? `${displayName.trim()} · ` : ''}
                    <code dir="ltr">{username}</code>
                  </dd>
                </div>
              )}
              <div>
                <dt>{t('auth.setup.books.ebookFolders')}</dt>
                <dd>
                  {ebookDirs.length
                    ? ebookDirs.map((p) => (
                        <code key={p} dir="ltr">
                          {p}
                        </code>
                      ))
                    : t('auth.setup.ready.noneYet')}
                </dd>
              </div>
              <div>
                <dt>{t('auth.setup.books.audiobookFolders')}</dt>
                <dd>
                  {audioDirs.length
                    ? audioDirs.map((p) => (
                        <code key={p} dir="ltr">
                          {p}
                        </code>
                      ))
                    : t('auth.setup.ready.noneYet')}
                </dd>
              </div>
              <div>
                <dt>{t('auth.setup.books.alignmentFolder')}</dt>
                <dd>
                  {alignDirs.length
                    ? alignDirs.map((p) => (
                        <code key={p} dir="ltr">
                          {p}
                        </code>
                      ))
                    : t('auth.setup.ready.inAppVolume')}
                </dd>
              </div>
              <div>
                <dt>{t('auth.setup.ready.language')}</dt>
                <dd>{languageLabel}</dd>
              </div>
            </dl>

            {aligner?.installed ? (
              <p className="hint" style={{ marginBlockStart: 'var(--sp-4)' }}>
                {t('auth.setup.ready.alignerInstalled')}
              </p>
            ) : aligner?.download ? (
              <p className="hint" style={{ marginBlockStart: 'var(--sp-4)' }}>
                {t('auth.setup.ready.alignerDownloading', {
                  pct: f.percent(aligner.download.progress),
                })}
              </p>
            ) : (
              <label className="rs-toggle" style={{ maxWidth: 620 }}>
                <span>
                  {t('auth.setup.ready.downloadAligner', {
                    size: f.bytes(aligner?.sizeBytes ?? ALIGNER_BYTES),
                  })}
                  <span className="hint" style={{ display: 'block' }}>
                    {t('auth.setup.ready.alignerLicence')}
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={wantAligner}
                  onChange={(e) => setWantAligner(e.target.checked)}
                />
              </label>
            )}
            {aligner?.lastError && !aligner.download && !aligner.installed && (
              <p className="hint" style={{ marginBlockStart: 8, color: 'var(--rp-danger)' }}>
                {t('auth.setup.ready.lastDownloadFailed', { error: aligner.lastError })}
              </p>
            )}

            {/* The question a rebuilt container has to ask: this folder may
                already hold hours of work from the last install. */}
            <label className="rs-toggle" style={{ maxWidth: 620 }}>
              <span>
                {t('auth.setup.ready.importSaved')}
                <span className="hint" style={{ display: 'block' }}>
                  {t('auth.setup.ready.importSavedHint')}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={importSaved}
                onChange={(e) => setImportSaved(e.target.checked)}
              />
            </label>

            <label className="rs-toggle" style={{ maxWidth: 620 }}>
              <span>
                {t('auth.setup.ready.autoAlign')}
                <span className="hint" style={{ display: 'block' }}>
                  {t('auth.setup.ready.autoAlignHint')}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={autoAlign}
                onChange={(e) => setAutoAlign(e.target.checked)}
              />
            </label>

            <h2 className="wizard__h2" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <IconCheck size={16} /> {t('auth.setup.ready.serverCheck')}
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--tight"
                onClick={() => void runPreflight()}
                disabled={checking}
              >
                {checking ? t('auth.setup.checking') : t('auth.setup.ready.runAgain')}
              </button>
            </h2>
            <CheckList report={preflight} checking={checking} />

            <div className="wizard__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setStep('books')}
                disabled={busy}
              >
                {t('common.back')}
              </button>
              <button type="button" className="btn" onClick={() => void finish()} disabled={busy}>
                {busy ? t('auth.setup.ready.settingUp') : t('auth.setup.ready.finish')}
              </button>
            </div>
          </div>
        )}

        {step === 'ready' && initializing && (createdUser || !firstRun) && (
          <InitStep
            hasRoots={ebookDirs.length + audioDirs.length > 0}
            watchAligner={wantAligner && !alignerFailed && !aligner?.installed}
            alignerFailed={alignerFailed}
            onEnter={() => {
              // Finishing with no folders is a deliberate skip: don't bounce
              // straight back into the wizard.
              if (ebookDirs.length + audioDirs.length > 0) localStorage.removeItem(SKIP_KEY);
              else localStorage.setItem(SKIP_KEY, '1');
              // onDone on BOTH paths. On first run it was only setUser, so
              // an operator who finished without folders was handed straight
              // back to the wizard they had just completed.
              if (createdUser) {
                setUser(createdUser);
                onDone?.();
              } else void refresh().then(() => onDone?.());
            }}
          />
        )}
      </div>
    </main>
  );
}

/** Green ticks and honest red crosses for the server self-check. */
function CheckList({ report, checking }: { report: PreflightReport | null; checking: boolean }) {
  const t = useT();
  if (!report) {
    return checking ? (
      <div className="skeleton" style={{ height: 96 }} />
    ) : (
      <p className="folders__empty">{t('auth.setup.check.unavailable')}</p>
    );
  }
  return (
    <ul className="folders__list">
      {report.checks.map((c) => (
        <li
          key={c.id}
          className={`folders__row ${c.state === 'ok' ? 'is-ok' : c.state === 'fail' ? 'is-bad' : ''}`}
        >
          <span className="folders__icon" aria-hidden="true">
            {c.state === 'ok' ? <IconCheck size={15} /> : <IconAlert size={15} />}
          </span>
          <span className="folders__body">
            <span style={{ fontSize: 13.5 }}>
              <bdi>{c.label}</bdi>
              <span className="visually-hidden">
                {c.state === 'ok'
                  ? t('auth.setup.check.passed')
                  : c.state === 'fail'
                    ? t('auth.setup.check.failed')
                    : t('auth.setup.check.warning')}
              </span>
            </span>
            <span className="folders__meta">
              <bdi>{c.detail}</bdi>
              {c.fix ? (
                <>
                  {' - '}
                  <bdi>{c.fix}</bdi>
                </>
              ) : null}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Live first-scan progress, plus the model download this wizard just started;
 * the session cookie is already set by /api/setup.
 */
function InitStep({
  hasRoots,
  watchAligner,
  alignerFailed,
  onEnter,
}: {
  hasRoots: boolean;
  watchAligner: boolean;
  alignerFailed: boolean;
  onEnter: () => void;
}) {
  const t = useT();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [totals, setTotals] = useState<JobCount[]>([]);
  const [books, setBooks] = useState<number>(0);
  const [aligner, setAligner] = useState<PreflightReport['aligner'] | null>(null);
  useEffect(() => {
    if (!hasRoots && !watchAligner) return;
    let alive = true;
    const tick = async () => {
      try {
        if (hasRoots) {
          const j = await api<JobsResponse>('/api/jobs');
          const lib = await api<{ books: unknown[] }>('/api/library');
          if (!alive) return;
          setJobs(j.jobs);
          setTotals(j.totals ?? []);
          setBooks(lib.books.length);
        }
        if (watchAligner) {
          const pf = await api<PreflightReport>('/api/preflight', { method: 'POST', body: {} });
          if (!alive) return;
          setAligner(pf.aligner);
        }
      } catch {
        /* keep last */
      }
      if (alive) setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [hasRoots, watchAligner]);
  const scan = jobs.find((j) => j.type === 'scan');
  const { done, percent, indexing, aligningLater } = setupProgress(
    totals,
    hasRoots,
    scan?.progress ?? 0.05,
  );
  return (
    <div className="wizard__body">
      <h1 tabIndex={-1}>
        {done
          ? t('auth.setup.init.allSet')
          : hasRoots
            ? t('auth.setup.init.readingShelves')
            : t('auth.setup.init.allSet')}
      </h1>
      {!hasRoots ? (
        <p className="lede">{t('auth.setup.init.noFolders')}</p>
      ) : (
        <>
          <p className="lede">
            {done
              ? aligningLater
                ? t('auth.setup.init.doneAligning', { books, n: aligningLater })
                : t('auth.setup.init.donePairing', { books })
              : t('auth.setup.init.scanning', { books, indexing })}
          </p>
          <div className="progressbar" style={{ height: 6 }}>
            <span
              style={{
                width: `${Math.max(6, percent)}%`,
                transition: 'width .5s ease',
              }}
            />
          </div>
          {scan?.detail && !done && (
            <p className="hint" style={{ marginTop: 8 }}>
              <bdi>{scan.detail}</bdi>
            </p>
          )}
        </>
      )}
      {alignerFailed && (
        <p className="hint" style={{ marginTop: 14, color: 'var(--rp-danger)' }}>
          {t('auth.setup.init.downloadNotStarted')}
        </p>
      )}
      {watchAligner && aligner && !alignerFailed && (
        <div style={{ marginTop: 18 }}>
          <h2 className="wizard__h2" style={{ marginTop: 0 }}>
            <IconDownload size={16} /> {t('auth.setup.init.alignerHeading')}
          </h2>
          {aligner.installed ? (
            <p className="hint">{t('auth.setup.init.alignerInstalled')}</p>
          ) : aligner.download ? (
            <>
              <div className="progressbar" style={{ height: 6 }}>
                <span
                  style={{
                    width: `${Math.max(3, Math.round(aligner.download.progress * 100))}%`,
                    transition: 'width .5s ease',
                  }}
                />
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                {t('auth.setup.init.downloading', {
                  status:
                    aligner.download.detail ??
                    (aligner.download.state === 'queued'
                      ? t('auth.setup.init.queued')
                      : t('auth.setup.init.starting')),
                })}
              </p>
            </>
          ) : (
            <p className="hint">
              {aligner.lastError
                ? t('auth.setup.init.downloadFailed', { error: aligner.lastError })
                : t('auth.setup.init.queuedWatch')}
            </p>
          )}
        </div>
      )}
      <div className="wizard__actions">
        {/* Sharing is the reason most people set a public address a moment
            ago, so offer the next step rather than making them find it. */}
        <a className="btn btn--secondary" href="/settings/people">
          {t('auth.setup.init.inviteSomeone')}
        </a>
        <button type="button" className="btn" onClick={onEnter}>
          {t('auth.setup.init.openLibrary')}
        </button>
      </div>
    </div>
  );
}
