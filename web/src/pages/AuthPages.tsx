import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatInviteCode, isInviteCode, normalizeInviteCode } from '@readport/shared';
import { api, ApiError } from '../api/client';
import { useSession, type User } from '../state/session';
import { ReadPortMark } from '../components/icons';

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
  return (
    <main className="auth-page">
      <div className="auth-page__glow" aria-hidden="true" />
      <form className="auth-card" onSubmit={onSubmit}>
        <span className="brand">
          <ReadPortMark size={34} style={{ color: 'var(--rp-primary)' }} />
          <span className="brand__name">ReadPort</span>
        </span>
        <p className="auth-card__tagline">Read and listen in tandem</p>
        <h1>{title}</h1>
        <p className="lede">{lede}</p>
        {error && (
          <div className="banner banner--error" role="alert">
            {error}
          </div>
        )}
        {children}
        <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Please wait…' : submitLabel}
        </button>
      </form>
    </main>
  );
}

export function LoginPage() {
  const { setUser } = useSession();
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
        setError('Too many attempts. Try again in a few minutes.');
      } else if (err instanceof ApiError && err.status === 401) {
        setError('Wrong username or password.');
      } else {
        setError('Sign-in failed. Is the server reachable?');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Welcome back"
      lede="Sign in to your ReadPort server."
      onSubmit={submit}
      submitLabel="Sign in"
      busy={busy}
      error={error}
    >
      <div className="field">
        <label htmlFor="li-user">Username</label>
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
        <label htmlFor="li-pass">Password</label>
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
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const ok = isInviteCode(code);

  if (!open) {
    return (
      <button type="button" className="auth-card__aside" onClick={() => setOpen(true)}>
        I have an invitation code
      </button>
    );
  }
  return (
    <div className="field">
      <label htmlFor="li-code">Invitation code</label>
      <div className="folders__add">
        <input
          id="li-code"
          className="input"
          placeholder="ABCD-EFGH-JKMN"
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
          Continue
        </button>
      </div>
      <span className="hint">Twelve characters, in three groups. Case does not matter.</span>
    </div>
  );
}
