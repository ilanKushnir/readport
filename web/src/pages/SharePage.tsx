import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, failureMessage } from '../api/client';
import { useSession, type User } from '../state/session';
import { useShelves } from '../state/shelves';
import { useToast } from '../components/ui';
import {
  IconAlert,
  IconBookOpen,
  IconCheck,
  IconHeadphones,
  IconList,
  ReadPortMark,
} from '../components/icons';
import { useT } from '../i18n';
import {
  addSharedBook,
  askToJoin,
  joinStatusFor,
  peekShare,
  rememberJoinEmail,
  rememberedJoinEmail,
  shareCoverUrl,
  type JoinStatusResponse,
  type SharePeek,
  type SharedBook,
} from '../share/api';
import '../styles/share.css';

/**
 * Where a share link lands: `/s/<token>`.
 *
 * Signed in, it is a card about the book with two things to do with it.
 * Not signed in, it is the same teaser and two ways in - sign in, or leave
 * an address and wait for an admin - and on every later visit it checks on
 * that request by the address this browser remembers, so the moment an
 * admin says yes the same link turns into the account form.
 */

type Valid = Extract<SharePeek, { valid: true }>;
type PeekState = 'loading' | 'invalid' | 'unreachable' | Valid;

export function SharePage({ token: tokenProp }: { token?: string }) {
  const params = useParams<{ token: string }>();
  const token = tokenProp ?? params.token ?? '';
  const { user } = useSession();
  const [peek, setPeek] = useState<PeekState>('loading');

  useEffect(() => {
    let alive = true;
    setPeek('loading');
    peekShare(token)
      .then((p) => {
        if (alive) setPeek(p.valid ? p : 'invalid');
      })
      .catch((err) => {
        // A server that did not answer says nothing about the link.
        if (alive) {
          setPeek(
            err instanceof ApiError && err.status >= 400 && err.status < 500
              ? 'invalid'
              : 'unreachable',
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [token]);

  return user ? <SignedIn token={token} peek={peek} /> : <Visitor token={token} peek={peek} />;
}

/* ---------------------------------------------------------------- pieces */

/** The same tints the library deals a coverless book from its id. */
const COVER_TINTS = ['#8C3F1F', '#5E4A8A', '#2F4A5C', '#6B3A44', '#4E5A2E', '#8A6A2F'];
function tintFor(id: string): string {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return COVER_TINTS[hash % COVER_TINTS.length]!;
}

/** The cover through the public route, since the visitor may have no session. */
function ShareCover({ token, book }: { token: string; book: SharedBook }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const tint = tintFor(book.id);
  if (book.hasCover && !failed) {
    return (
      <img
        className="share-cover"
        src={shareCoverUrl(token)}
        alt={t('share.page.coverAlt', { title: book.title })}
        style={{ backgroundColor: tint }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="share-cover share-cover--fallback" style={{ background: tint }} aria-hidden>
      <span>{book.title}</span>
      <span style={{ opacity: 0.85, fontWeight: 400 }}>{book.author ?? ''}</span>
    </span>
  );
}

function Teaser({ token, peek, line }: { token: string; peek: Valid; line: string }) {
  const t = useT();
  const { book } = peek;
  return (
    <div className="share-teaser">
      <ShareCover token={token} book={book} />
      <div className="share-teaser__body">
        <span className="share-teaser__eyebrow">
          {book.kind === 'ebook' ? <IconBookOpen size={13} /> : <IconHeadphones size={13} />}
          {book.kind === 'ebook' ? t('common.ebook') : t('common.audiobook')}
        </span>
        <h1 className="share-teaser__title" id="share-title">
          {book.title}
        </h1>
        {book.author && <p className="share-teaser__author">{book.author}</p>}
        <p className="share-teaser__line">{line}</p>
      </div>
    </div>
  );
}

function Invalid() {
  const t = useT();
  return (
    <>
      <h1>{t('share.page.invalidTitle')}</h1>
      <p className="lede">{t('share.page.invalidLede')}</p>
      <Link className="btn" to="/">
        {t('share.page.openLibrary')}
      </Link>
    </>
  );
}

function Unreachable() {
  const t = useT();
  return (
    <>
      <h1>{t('share.page.unreachableTitle')}</h1>
      <p className="lede">{t('share.page.unreachableLede')}</p>
      <button className="btn" type="button" onClick={() => window.location.reload()}>
        {t('common.retry')}
      </button>
    </>
  );
}

/* ------------------------------------------------------------- signed in */

function SignedIn({ token, peek }: { token: string; peek: PeekState }) {
  const t = useT();
  const toast = useToast();
  const { refresh: refreshShelves } = useShelves();
  const [onList, setOnList] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const bookId = typeof peek === 'object' ? peek.book.id : null;

  useEffect(() => {
    if (!bookId) return;
    let alive = true;
    api<{ onReadingList: boolean }>(`/api/books/${bookId}/shelves`)
      .then((m) => {
        if (alive) setOnList(m.onReadingList);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bookId]);

  const add = async () => {
    setBusy(true);
    try {
      const res = await addSharedBook(token);
      setOnList(true);
      toast.show(res.added ? t('share.page.added') : t('share.page.onList'));
      void refreshShelves();
    } catch (err) {
      toast.show(failureMessage(err, t('share.page.addFailed'), t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app-main share-page" id="main-content" tabIndex={-1}>
      <section className="share-card" aria-labelledby="share-title">
        {peek === 'loading' && <p className="lede">{t('share.page.checking')}</p>}
        {peek === 'invalid' && <Invalid />}
        {peek === 'unreachable' && <Unreachable />}
        {typeof peek === 'object' && (
          <>
            <Teaser
              token={token}
              peek={peek}
              line={t('share.page.sharedWithYou', { name: peek.sharedBy.displayName })}
            />
            <div className="share-card__actions">
              {onList ? (
                <span className="btn btn--secondary is-static" aria-live="polite">
                  <IconCheck size={16} /> {t('share.page.onList')}
                </span>
              ) : (
                <button className="btn btn--secondary" disabled={busy} onClick={() => void add()}>
                  <IconList size={16} /> {t('share.page.addToList')}
                </button>
              )}
              <Link className="btn" to={`/book/${peek.book.id}`}>
                {peek.book.kind === 'ebook' ? (
                  <IconBookOpen size={16} />
                ) : (
                  <IconHeadphones size={16} />
                )}{' '}
                {t('share.page.openBook')}
              </Link>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

/* --------------------------------------------------------------- visitor */

type Mode = 'teaser' | 'login' | 'join';

function Visitor({ token, peek }: { token: string; peek: PeekState }) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('teaser');
  const [email, setEmail] = useState<string | null>(() => rememberedJoinEmail());
  const [status, setStatus] = useState<JoinStatusResponse | 'checking' | null>(null);

  // Every visit checks on the request this browser left, so an approval
  // shows up as the account form without anyone having to be told.
  useEffect(() => {
    if (!email || typeof peek !== 'object') return;
    let alive = true;
    setStatus('checking');
    joinStatusFor(token, email)
      .then((s) => {
        if (alive) setStatus(s.status === 'none' ? null : s);
      })
      .catch(() => {
        if (alive) setStatus(null);
      });
    return () => {
      alive = false;
    };
  }, [token, email, peek]);

  const forget = () => {
    rememberJoinEmail(null);
    setEmail(null);
    setStatus(null);
    setMode('join');
  };

  return (
    <main className="auth-page">
      <div className="auth-page__glow" aria-hidden="true" />
      <div className="auth-card share-card share-card--visitor">
        <span className="brand">
          <ReadPortMark size={34} style={{ color: 'var(--rp-primary)' }} />
          <span className="brand__name">{t('common.appName')}</span>
        </span>
        <p className="auth-card__tagline">{t('common.tagline')}</p>
        {peek === 'loading' && <p className="lede">{t('share.page.checking')}</p>}
        {peek === 'invalid' && <Invalid />}
        {peek === 'unreachable' && <Unreachable />}
        {typeof peek === 'object' && (
          <>
            <Teaser
              token={token}
              peek={peek}
              line={t('share.page.sharedTeaser', { name: peek.sharedBy.displayName })}
            />
            {status === 'checking' ? (
              <p className="lede">{t('share.page.checking')}</p>
            ) : status?.status === 'pending' ? (
              <div className="share-status" role="status">
                <h2>{t('share.join.pendingTitle')}</h2>
                <p>{t('share.join.pendingBody')}</p>
                <span className="share-status__as">
                  {t('share.join.pendingAs', { email: email ?? '' })} ·{' '}
                  <button type="button" className="share-link" onClick={forget}>
                    {t('share.join.notYou')}
                  </button>
                </span>
              </div>
            ) : status?.status === 'declined' ? (
              <div className="share-status" role="status">
                <h2>{t('share.join.declinedTitle')}</h2>
                <p>{t('share.join.declinedBody')}</p>
                <span className="share-status__as">
                  <button type="button" className="share-link" onClick={forget}>
                    {t('share.page.askToJoin')}
                  </button>
                </span>
              </div>
            ) : status?.status === 'approved' && status.inviteToken ? (
              <AccountForm token={token} inviteToken={status.inviteToken} bookId={peek.book.id} />
            ) : status?.status === 'approved' ? (
              <>
                <div className="share-status" role="status">
                  <h2>{t('share.join.approvedUsedTitle')}</h2>
                  <p>{t('share.join.approvedUsedBody')}</p>
                </div>
                {mode === 'login' ? (
                  <LoginForm onBack={() => setMode('teaser')} />
                ) : (
                  <div className="share-card__actions">
                    <button className="btn" onClick={() => setMode('login')}>
                      {t('auth.login.submit')}
                    </button>
                  </div>
                )}
              </>
            ) : mode === 'login' ? (
              <LoginForm onBack={() => setMode('teaser')} />
            ) : mode === 'join' ? (
              <JoinForm
                token={token}
                onBack={() => setMode('teaser')}
                onSent={(sentAs, result) => {
                  rememberJoinEmail(sentAs);
                  setEmail(sentAs);
                  setStatus(result);
                }}
              />
            ) : (
              <div className="share-card__actions">
                <button className="btn" onClick={() => setMode('login')}>
                  {t('share.page.haveAccount')}
                </button>
                <button className="btn btn--secondary" onClick={() => setMode('join')}>
                  {t('share.page.askToJoin')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

/**
 * Sign in without leaving the page. The app's login screen has no way back
 * to a share link, and the link is the whole point: after a successful
 * sign-in the URL is unchanged, so the shell re-renders this very page for
 * the signed-in person.
 */
function LoginForm({ onBack }: { onBack: () => void }) {
  const t = useT();
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
      setError(
        err instanceof ApiError && err.status === 429
          ? t('auth.login.tooManyAttempts')
          : err instanceof ApiError && err.status === 401
            ? t('auth.login.wrongCredentials')
            : t('auth.login.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="share-form" onSubmit={submit}>
      <p className="lede">{t('share.page.signInLede')}</p>
      {error && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} /> {error}
        </div>
      )}
      <div className="field">
        <label htmlFor="sh-user">{t('auth.form.username')}</label>
        <input
          id="sh-user"
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
        <label htmlFor="sh-pass">{t('auth.form.password')}</label>
        <input
          id="sh-pass"
          className="input"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="share-card__actions">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? t('auth.login.pleaseWait') : t('auth.login.submit')}
        </button>
        <button className="btn btn--ghost" type="button" onClick={onBack}>
          {t('common.back')}
        </button>
      </div>
    </form>
  );
}

function JoinForm({
  token,
  onBack,
  onSent,
}: {
  token: string;
  onBack: () => void;
  onSent: (email: string, result: JoinStatusResponse) => void;
}) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const address = email.trim().toLowerCase();
    try {
      const res = await askToJoin(token, {
        email: address,
        name: name.trim() || undefined,
        message: message.trim() || undefined,
      });
      onSent(address, { status: res.status });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? t('share.join.tooMany')
          : err instanceof ApiError && err.code === 'invalid'
            ? err.message.replace(/^invalid:?\s*/, '')
            : failureMessage(err, t('share.join.failed'), t),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="share-form" onSubmit={submit}>
      <p className="lede">{t('share.join.lede')}</p>
      {error && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} /> <bdi>{error}</bdi>
        </div>
      )}
      <div className="field">
        <label htmlFor="sh-email">{t('share.join.email')}</label>
        <input
          id="sh-email"
          className="input"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="sh-name">{t('share.join.name')}</label>
        <input
          id="sh-name"
          className="input"
          autoComplete="name"
          maxLength={80}
          placeholder={t('auth.form.optional')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="sh-message">{t('share.join.message')}</label>
        <textarea
          id="sh-message"
          className="input"
          rows={2}
          maxLength={500}
          placeholder={t('share.join.messagePlaceholder')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
      <div className="share-card__actions">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? t('share.join.sending') : t('share.join.send')}
        </button>
        <button className="btn btn--ghost" type="button" onClick={onBack}>
          {t('common.back')}
        </button>
      </div>
    </form>
  );
}

/**
 * The approved request's account form. The invitation carries the role and
 * the name the request was left with; what is asked for here is only what
 * the invitation cannot know. Accepting signs the new account in, puts the
 * book on its reading list credited to the sharer, and opens it.
 */
function AccountForm({
  token,
  inviteToken,
  bookId,
}: {
  token: string;
  inviteToken: string;
  bookId: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { setUser } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError(t('auth.form.passwordsMismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: User }>(
        `/api/invites/${encodeURIComponent(inviteToken)}/accept`,
        { method: 'POST', body: { username, password } },
      );
      // Signed in now (the cookie is set): the book onto the list, then the
      // book itself. The add is best-effort - the account is the point.
      await addSharedBook(token).catch(() => {});
      rememberJoinEmail(null);
      navigate(`/book/${bookId}`, { replace: true });
      setUser(res.user);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'username-taken'
          ? t('auth.join.usernameTaken')
          : err instanceof ApiError && err.code === 'invalid-invite'
            ? t('share.join.inviteLapsed')
            : err instanceof ApiError && err.code === 'invalid'
              ? err.message.replace(/^invalid:?\s*/, '')
              : t('auth.join.createFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="share-form" onSubmit={submit}>
      <div className="share-status">
        <h2>{t('share.join.approvedTitle')}</h2>
        <p>{t('share.join.approvedLede')}</p>
      </div>
      {error && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} /> <bdi>{error}</bdi>
        </div>
      )}
      <div className="field">
        <label htmlFor="sh-new-user">{t('auth.form.username')}</label>
        <input
          id="sh-new-user"
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
        <label htmlFor="sh-new-pass">{t('auth.form.password')}</label>
        <input
          id="sh-new-pass"
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
        <label htmlFor="sh-new-confirm">{t('auth.form.confirmPassword')}</label>
        <input
          id="sh-new-confirm"
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
    </form>
  );
}
