import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatInviteCode, isInviteCode, normalizeInviteCode } from '@readport/shared';
import { api, ApiError } from '../api/client';
import { useSession, type User } from '../state/session';
import { ReadPortMark } from '../components/icons';
import { useT } from '../i18n';

function AuthCard({
  title,
  lede,
  onSubmit,
  submitLabel,
  busy,
  error,
  children,
}: {
  title: string;
  lede: string;
  onSubmit: (e: FormEvent) => void;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <main className="auth-page">
      <div className="auth-page__glow" aria-hidden="true" />
      <form className="auth-card" onSubmit={onSubmit}>
        <span className="brand">
          <ReadPortMark size={34} style={{ color: 'var(--rp-primary)' }} />
          <span className="brand__name">{t('common.appName')}</span>
        </span>
        <p className="auth-card__tagline">{t('common.tagline')}</p>
        <h1>{title}</h1>
        <p className="lede">{lede}</p>
        {error && (
          <div className="banner banner--error" role="alert">
            {error}
          </div>
        )}
        {children}
        <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? t('auth.login.pleaseWait') : submitLabel}
        </button>
      </form>
    </main>
  );
}

export function LoginPage() {
  const { setUser } = useSession();
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: User }>('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      setUser(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError(t('auth.login.tooManyAttempts'));
      } else if (err instanceof ApiError && err.status === 401) {
        setError(t('auth.login.wrongCredentials'));
      } else {
        setError(t('auth.login.failed'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={t('auth.login.title')}
      lede={t('auth.login.lede')}
      onSubmit={submit}
      submitLabel={t('auth.login.submit')}
      busy={busy}
      error={error}
    >
      <div className="field">
        <label htmlFor="li-user">{t('auth.form.username')}</label>
        <input
          id="li-user"
          className="input"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="li-pass">{t('auth.form.password')}</label>
        <input
          id="li-pass"
          className="input"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <RedeemCode />
    </AuthCard>
  );
}

/**
 * "I was given a code."
 *
 * An invitation arrives as a link or as a code read out loud, and the second
 * one had nowhere to go: someone holding ABCD-EFGH-JKMN and looking at a
 * sign-in form has no way in. Tucked under the form rather than beside it -
 * most people arriving here have an account.
 */
function RedeemCode() {
  const navigate = useNavigate();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const ok = isInviteCode(code);

  if (!open) {
    return (
      <button type="button" className="auth-card__aside" onClick={() => setOpen(true)}>
        {t('auth.invite.haveCode')}
      </button>
    );
  }
  return (
    <div className="field">
      <label htmlFor="li-code">{t('auth.invite.codeLabel')}</label>
      <div className="folders__add">
        <input
          id="li-code"
          className="input"
          dir="ltr"
          placeholder={t('auth.invite.codePlaceholder')}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(formatInviteCode(e.target.value))}
          onKeyDown={(e) => {
            // Enter here must not submit the sign-in form behind it.
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (ok) navigate(`/join/${normalizeInviteCode(code)}`);
          }}
        />
        <button
          type="button"
          className="btn btn--secondary"
          disabled={!ok}
          onClick={() => navigate(`/join/${normalizeInviteCode(code)}`)}
        >
          {t('common.continue')}
        </button>
      </div>
      <span className="hint">{t('auth.invite.codeHint')}</span>
    </div>
  );
}
