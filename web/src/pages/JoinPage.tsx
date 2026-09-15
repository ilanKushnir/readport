import { useEffect, useState, type FormEvent } from 'react';
import type { Role } from '@readport/shared';
import { api, ApiError } from '../api/client';
import { useSession, type User } from '../state/session';
import { ReadPortMark } from '../components/icons';
import { useT } from '../i18n';

interface InvitePeek {
  role: Role;
  displayName: string | null;
  username: string | null;
  invitedBy: string | null;
  expiresAt: string;
}

/** Accept an invitation link: /join/<token>. The only self-service sign-up path. */
export function JoinPage({ token }: { token: string }) {
  const { setUser } = useSession();
  const t = useT();
  const [peek, setPeek] = useState<InvitePeek | null | 'invalid' | 'unreachable'>(null);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<InvitePeek>(`/api/invites/${encodeURIComponent(token)}`)
      .then((p) => {
        setPeek(p);
        setDisplayName(p.displayName ?? '');
        setUsername(p.username ?? '');
      })
      .catch((err) =>
        // A server that did not answer says nothing about the invitation, and
        // telling someone their link has expired when it has not sends them
        // back to ask for another one that will look just as broken.
        setPeek(
          err instanceof ApiError && err.status >= 400 && err.status < 500
            ? 'invalid'
            : 'unreachable',
        ),
      );
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError(t('auth.form.passwordsMismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: User }>(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: { username, password, displayName: displayName.trim() || undefined },
      });
      history.replaceState(null, '', '/');
      setUser(res.user);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'username-taken'
          ? t('auth.join.usernameTaken')
          : err instanceof ApiError && err.code === 'invalid-invite'
            ? t('auth.join.inviteInvalid')
            : err instanceof ApiError && err.code === 'invalid'
              ? err.message.replace(/^invalid:?\s*/, '')
              : t('auth.join.createFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-page__glow" aria-hidden="true" />
      <form className="auth-card" onSubmit={submit}>
        <span className="brand">
          <ReadPortMark size={34} style={{ color: 'var(--rp-primary)' }} />
          <span className="brand__name">{t('common.appName')}</span>
        </span>
        <p className="auth-card__tagline">{t('common.tagline')}</p>
        {peek === null && <p className="lede">{t('auth.join.checking')}</p>}
        {peek === 'unreachable' && (
          <>
            <h1>{t('auth.join.unreachableTitle')}</h1>
            <p className="lede">{t('auth.join.unreachableLede')}</p>
            <button className="btn" type="button" onClick={() => window.location.reload()}>
              {t('common.retry')}
            </button>
          </>
        )}
        {peek === 'invalid' && (
          <>
            <h1>{t('auth.join.expiredTitle')}</h1>
            <p className="lede">{t('auth.join.expiredLede')}</p>
          </>
        )}
        {peek && peek !== 'invalid' && peek !== 'unreachable' && (
          <>
            <h1>{t('auth.join.title')}</h1>
            <p className="lede">
              {peek.invitedBy
                ? t('auth.join.invitedBy', { name: peek.invitedBy, role: peek.role })
                : t('auth.join.invited', { role: peek.role })}{' '}
              {t(`auth.join.roleBlurb.${peek.role}` as const)}
            </p>
            {error && (
              <div className="banner banner--error" role="alert">
                {error}
              </div>
            )}
            <div className="field">
              <label htmlFor="jn-name">{t('auth.form.displayName')}</label>
              <input
                id="jn-name"
                className="input"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t('auth.form.optional')}
              />
            </div>
            <div className="field">
              <label htmlFor="jn-user">{t('auth.form.username')}</label>
              <input
                id="jn-user"
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
            <div className="field">
              <label htmlFor="jn-pass">{t('auth.form.password')}</label>
              <input
                id="jn-pass"
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
              <label htmlFor="jn-confirm">{t('auth.form.confirmPassword')}</label>
              <input
                id="jn-confirm"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? t('auth.join.creating') : t('auth.join.submit')}
            </button>
          </>
        )}
      </form>
    </main>
  );
}
