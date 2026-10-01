import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { UI_LOCALES, type InviteDto, type Role, type UserDto } from '@readport/shared';
import { api, ApiError } from '../api/client';
import { useSession } from '../state/session';
import { Sheet, useToast } from '../components/ui';
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconLink,
  IconMail,
  IconShare,
} from '../components/icons';
import { translatorFor, useLocale, useT, type TranslateFn } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { type JoinRequestDto } from '../share/api';

const ROLES: Role[] = ['admin', 'curator', 'reader'];

/** A role's name and its one-line job description, in the interface language. */
const roleLabel = (t: TranslateFn, r: Role) => t(`people.roles.${r}.label` as const);
const roleBlurb = (t: TranslateFn, r: Role) => t(`people.roles.${r}.blurb` as const);

function errorText(err: unknown, fallback: string, t: TranslateFn): string {
  if (!(err instanceof ApiError)) return fallback;
  switch (err.code) {
    case 'username-taken':
      return t('people.error.usernameTaken');
    case 'email-taken':
      return t('people.error.emailTaken');
    case 'last-admin':
      return t('people.error.lastAdmin');
    case 'self-lockout':
      return t('people.error.selfLockout');
    case 'proxy-managed':
      return t('people.error.proxyManaged');
    case 'invalid':
      return err.message.replace(/^invalid:?\s*/, '');
    default:
      return fallback;
  }
}

/** Settings → People: accounts, roles, invitations. Admin only. */
export function PeoplePage() {
  const t = useT();
  const f = useFormat();
  const { user: me, refresh: refreshSession } = useSession();
  const toast = useToast();
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [invites, setInvites] = useState<InviteDto[]>([]);
  const [requests, setRequests] = useState<JoinRequestDto[]>([]);
  const [sheet, setSheet] = useState<'none' | 'add' | 'invite'>('none');
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [link, setLink] = useState<InviteLink | null>(null);
  /** The request whose approval is being decided, in its own sheet. */
  const [approving, setApproving] = useState<JoinRequestDto | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ users: UserDto[]; invites: InviteDto[] }>('/api/users');
      setUsers(res.users);
      setInvites(res.invites);
    } catch {
      setUsers([]);
    }
    // People waiting at the door. Its own request, so a failure here does
    // not take the accounts list down with it.
    try {
      const res = await api<{ requests: JoinRequestDto[] }>('/api/join-requests');
      setRequests(res.requests);
    } catch {
      setRequests([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (me?.role !== 'admin') {
    return (
      <main
        className="app-main"
        id="main-content"
        tabIndex={-1}
        style={{ '--rp-measure': '820px' } as React.CSSProperties}
      >
        <p>{t('people.adminsOnly')}</p>
      </main>
    );
  }

  const pending = requests.filter((r) => r.status === 'pending');
  // Let in, and not signed up yet: their link is still worth sending.
  const waiting = requests.filter((r) => r.status === 'approved' && r.invite);
  const decline = async (r: JoinRequestDto) => {
    try {
      await api(`/api/join-requests/${r.id}/decline`, { method: 'POST' });
      toast.show(t('people.joinRequests.declined'));
      await load();
      // The count the shell shows comes with the session.
      void refreshSession();
    } catch {
      toast.show(t('people.joinRequests.failed'));
    }
  };
  /** An approved request's invitation, as the link sheet sends it. */
  const linkFor = (r: JoinRequestDto): InviteLink | null =>
    r.invite
      ? {
          url: r.invite.url ?? `${location.origin}${r.invite.path}`,
          code: r.invite.code,
          role: 'reader',
          expiresAt: r.invite.expiresAt,
          email: r.email,
          language: r.invite.language,
          name: r.name,
          bookTitle: r.book?.title ?? null,
        }
      : null;

  const revokeInvite = async (id: string) => {
    try {
      await api(`/api/invites/${id}`, { method: 'DELETE' });
      toast.show(t('people.invites.revoked'));
      await load();
    } catch {
      toast.show(t('people.invites.couldNotRevoke'));
    }
  };

  return (
    <main
      className="app-main settings-page"
      id="main-content"
      tabIndex={-1}
      style={{ '--rp-measure': '820px' } as React.CSSProperties}
    >
      <header className="page-head page-head--row">
        <div>
          <p className="crumb">
            <Link to="/settings">{t('nav.settings')}</Link> / {t('people.title')}
          </p>
          <h1>{t('people.title')}</h1>
          <p>{t('people.lede')}</p>
        </div>
        <div className="page-head__actions">
          <button className="btn btn--secondary" onClick={() => setSheet('invite')}>
            <IconLink size={16} /> {t('people.inviteByLink')}
          </button>
          <button className="btn" onClick={() => setSheet('add')}>
            {t('people.addPerson')}
          </button>
        </div>
      </header>

      {pending.length + waiting.length > 0 && (
        <section className="settings-section" aria-label={t('people.joinRequests.title')}>
          <h2>
            {t('people.joinRequests.title')}{' '}
            {pending.length > 0 && (
              <span className="section-title__count">{f.number(pending.length)}</span>
            )}
          </h2>
          <p className="settings-section__lede">{t('people.joinRequests.lede')}</p>
          <ul className="people">
            {pending.map((r) => (
              <li key={r.id} className="person">
                <span className="person__avatar person__avatar--invite" aria-hidden="true">
                  {(r.name ?? r.email).slice(0, 1).toUpperCase()}
                </span>
                <span className="person__body">
                  <span className="person__name">
                    {r.name ?? r.email}
                    {r.name && (
                      <span className="person__user">
                        {' '}
                        <bdi>{r.email}</bdi>
                      </span>
                    )}
                  </span>
                  <span className="person__meta">
                    <span>
                      {r.book && r.sharedBy
                        ? t('people.joinRequests.askedFor', {
                            title: r.book.title,
                            name: r.sharedBy.displayName,
                          })
                        : t('people.joinRequests.askedForUnknown')}
                    </span>
                    <span>· {t('people.joinRequests.when', { when: f.ago(r.createdAt) })}</span>
                  </span>
                  {r.message && (
                    <span className="hint">
                      <bdi>{r.message}</bdi>
                    </span>
                  )}
                  <span className="manage-row">
                    <button className="btn btn--sm" onClick={() => setApproving(r)}>
                      <IconCheck size={14} /> {t('people.joinRequests.approve')}
                    </button>
                    <button className="btn btn--ghost btn--sm" onClick={() => void decline(r)}>
                      {t('people.joinRequests.decline')}
                    </button>
                  </span>
                </span>
              </li>
            ))}
            {waiting.map((r) => (
              <li key={r.id} className="person">
                <span className="person__avatar person__avatar--invite" aria-hidden="true">
                  <IconCheck size={16} />
                </span>
                <span className="person__body">
                  <span className="person__name">
                    {r.name ?? r.email}
                    {r.name && (
                      <span className="person__user">
                        {' '}
                        <bdi>{r.email}</bdi>
                      </span>
                    )}
                  </span>
                  <span className="person__meta">
                    <span>{t('people.joinRequests.waiting')}</span>
                    <span>
                      ·{' '}
                      {t('people.joinRequests.linkUntil', {
                        date: f.date(r.invite!.expiresAt),
                      })}
                    </span>
                  </span>
                </span>
                <button className="btn btn--secondary btn--sm" onClick={() => setLink(linkFor(r))}>
                  <IconMail size={14} /> {t('people.joinRequests.sendLink')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="roles-legend" aria-label={t('people.roles.label')}>
        {ROLES.map((r) => (
          <div key={r} className={`roles-legend__item roles-legend__item--${r}`}>
            <strong>{roleLabel(t, r)}</strong>
            <span>{roleBlurb(t, r)}</span>
          </div>
        ))}
      </section>

      <section className="settings-section" aria-label={t('people.accounts.title')}>
        <h2>
          {t('people.accounts.title')}{' '}
          {users && <span className="section-title__count">{f.number(users.length)}</span>}
        </h2>
        {!users ? (
          <div className="skeleton" style={{ height: 120 }} />
        ) : (
          <ul className="people">
            {users.map((u) => (
              <li key={u.id} className={`person ${u.status === 'disabled' ? 'is-disabled' : ''}`}>
                <span className={`person__avatar person__avatar--${u.role}`} aria-hidden="true">
                  {(u.displayName ?? u.username).slice(0, 1).toUpperCase()}
                </span>
                <span className="person__body">
                  <span className="person__name">
                    {u.displayName ?? u.username}
                    {u.displayName && (
                      <span className="person__user">
                        {' '}
                        @<bdi>{u.username}</bdi>
                      </span>
                    )}
                    {u.id === me.id && (
                      <span className="person__you">{t('people.accounts.you')}</span>
                    )}
                  </span>
                  <span className="person__meta">
                    <span className={`badge badge--role-${u.role}`}>{roleLabel(t, u.role)}</span>
                    {u.email && (
                      <span>
                        <bdi>{u.email}</bdi>
                      </span>
                    )}
                    {u.status === 'disabled' && (
                      <span className="badge badge--muted">{t('people.accounts.disabled')}</span>
                    )}
                    {u.proxyManaged && (
                      <span className="badge badge--muted">{t('people.accounts.proxySignIn')}</span>
                    )}
                    <span>
                      {t('people.accounts.lastSeen', {
                        when: f.ago(u.lastSeenAt ?? u.lastLoginAt),
                      })}
                    </span>
                    {u.booksInProgress > 0 && (
                      <span>
                        · {t('people.accounts.booksInProgress', { n: u.booksInProgress })}
                      </span>
                    )}
                    {u.sessions > 0 && (
                      <span>· {t('people.accounts.devices', { n: u.sessions })}</span>
                    )}
                  </span>
                </span>
                <button className="btn btn--ghost btn--sm" onClick={() => setEditing(u)}>
                  {t('people.accounts.manage')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {invites.length > 0 && (
        <section className="settings-section" aria-label={t('people.invites.title')}>
          <h2>
            {t('people.invites.title')}{' '}
            <span className="section-title__count">{f.number(invites.length)}</span>
          </h2>
          <ul className="people">
            {invites.map((i) => (
              <li key={i.id} className="person">
                <span className="person__avatar person__avatar--invite" aria-hidden="true">
                  <IconLink size={16} />
                </span>
                <span className="person__body">
                  <span className="person__name">
                    {i.displayName ?? i.username ?? t('people.invites.anyone')}
                  </span>
                  <span className="person__meta">
                    <span className={`badge badge--role-${i.role}`}>{roleLabel(t, i.role)}</span>
                    <span>{t('people.invites.expires', { date: f.date(i.expiresAt) })}</span>
                    {i.createdBy && (
                      <span>· {t('people.invites.from', { name: i.createdBy })}</span>
                    )}
                  </span>
                </span>
                <button className="btn btn--ghost btn--sm" onClick={() => void revokeInvite(i.id)}>
                  {t('people.invites.revoke')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sheet === 'add' && (
        <AddPersonSheet
          onClose={() => setSheet('none')}
          onDone={() => {
            setSheet('none');
            void load();
          }}
        />
      )}
      {sheet === 'invite' && (
        <InviteSheet
          onClose={() => setSheet('none')}
          onDone={(l) => {
            setSheet('none');
            setLink(l);
            void load();
          }}
        />
      )}
      {link && <InviteLinkSheet link={link} onClose={() => setLink(null)} />}
      {approving && (
        <ApproveSheet
          request={approving}
          onClose={() => setApproving(null)}
          onApproved={(r) => {
            setApproving(null);
            toast.show(t('people.joinRequests.approved'));
            void load();
            void refreshSession();
            // Straight on to sending them their way in.
            const l = linkFor(r);
            if (l) setLink(l);
          }}
        />
      )}
      {editing && (
        <ManageSheet
          user={editing}
          isSelf={editing.id === me.id}
          onClose={() => setEditing(null)}
          onChanged={(u) => {
            setEditing(u);
            void load();
          }}
          onDeleted={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </main>
  );
}

function RolePicker({
  value,
  onChange,
  disabled,
}: {
  value: Role;
  onChange: (r: Role) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="role-picker" role="radiogroup" aria-label={t('people.form.role')}>
      {ROLES.map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={value === r}
          disabled={disabled}
          className={`role-picker__opt ${value === r ? 'is-on' : ''}`}
          onClick={() => onChange(r)}
        >
          <strong>{roleLabel(t, r)}</strong>
          <span>{roleBlurb(t, r)}</span>
        </button>
      ))}
    </div>
  );
}

function AddPersonSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [language, setLanguage] = useState<string | null>(null);
  const [role, setRole] = useState<Role>('reader');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/users', {
        method: 'POST',
        body: {
          username,
          password,
          role,
          displayName: displayName.trim() || undefined,
          email: email.trim() || undefined,
          locale: language,
        },
      });
      toast.show(t('people.add.added', { name: displayName.trim() || username }));
      onDone();
    } catch (err) {
      setError(errorText(err, t('people.add.failed'), t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={t('people.add.title')} onClose={onClose}>
      <form onSubmit={submit}>
        {error && (
          <div className="banner banner--error" role="alert">
            <bdi>{error}</bdi>
          </div>
        )}
        <div className="field">
          <label htmlFor="ap-name">{t('people.form.displayName')}</label>
          <input
            id="ap-name"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('people.add.optional')}
          />
        </div>
        <div className="field">
          <label htmlFor="ap-user">{t('people.add.username')}</label>
          <input
            id="ap-user"
            className="input"
            required
            minLength={3}
            pattern="[a-zA-Z0-9._\-]+"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="ap-pass">{t('people.add.temporaryPassword')}</label>
          <input
            id="ap-pass"
            className="input"
            type="text"
            required
            minLength={10}
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="hint">{t('people.add.passwordHint')}</span>
        </div>
        <EmailField id="ap-email" value={email} onChange={setEmail} />
        <LanguageField id="ap-lang" value={language} onChange={setLanguage} />
        <div className="field">
          <label>{t('people.form.role')}</label>
          <RolePicker value={role} onChange={setRole} />
        </div>
        <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? t('people.add.adding') : t('people.addPerson')}
        </button>
      </form>
    </Sheet>
  );
}

function InviteSheet({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (l: InviteLink) => void;
}) {
  const t = useT();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [language, setLanguage] = useState<string | null>(null);
  const [role, setRole] = useState<Role>('reader');
  const [canExport, setCanExport] = useState(false);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{
        path: string;
        url: string | null;
        code: string;
        invite: { role: Role; expiresAt: string };
      }>('/api/invites', {
        method: 'POST',
        body: {
          role,
          canExport,
          displayName: displayName.trim() || undefined,
          expiresInDays: days,
          email: email.trim() || undefined,
          language,
        },
      });
      onDone({
        // The server builds the link from the public address it was told
        // about. Falling back to this browser's origin is right only for a
        // library nobody shares - which is exactly when publicUrl is unset.
        url: res.url ?? `${location.origin}${res.path}`,
        code: res.code,
        role: res.invite.role,
        expiresAt: res.invite.expiresAt,
        email: email.trim() || null,
        language,
        name: displayName.trim() || null,
        bookTitle: null,
      });
    } catch (err) {
      setError(errorText(err, t('people.invite.failed'), t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={t('people.inviteByLink')} onClose={onClose}>
      <form onSubmit={submit}>
        {error && (
          <div className="banner banner--error" role="alert">
            <bdi>{error}</bdi>
          </div>
        )}
        <div className="field">
          <label htmlFor="iv-name">{t('people.invite.whoFor')}</label>
          <input
            id="iv-name"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('people.invite.namePlaceholder')}
          />
        </div>
        <EmailField
          id="iv-email"
          value={email}
          onChange={setEmail}
          hint={t('people.invite.emailHint')}
        />
        <LanguageField id="iv-lang" value={language} onChange={setLanguage} />
        <div className="field">
          <label>{t('people.form.role')}</label>
          <RolePicker value={role} onChange={setRole} />
        </div>
        <label className="rs-toggle" style={{ maxWidth: 620 }}>
          <span>
            {t('people.form.letThemSave')}
            <span className="hint" style={{ display: 'block' }}>
              {role === 'admin'
                ? t('people.form.adminsAlwaysDownload')
                : t('people.invite.saveCopiesHint')}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            disabled={role === 'admin'}
            checked={role === 'admin' ? true : canExport}
            onChange={(e) => setCanExport(e.target.checked)}
          />
        </label>
        <div className="field">
          <label htmlFor="iv-days">{t('people.invite.validFor')}</label>
          <select
            id="iv-days"
            className="input input--select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {[1, 3, 7, 14, 30].map((n) => (
              <option key={n} value={n}>
                {t('people.invite.days', { n })}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? t('people.invite.creating') : t('people.invite.createLink')}
        </button>
      </form>
    </Sheet>
  );
}

function ManageSheet({
  user,
  isSelf,
  onClose,
  onChanged,
  onDeleted,
}: {
  user: UserDto;
  isSelf: boolean;
  onClose: () => void;
  onChanged: (u: UserDto) => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [email, setEmail] = useState(user.email ?? '');
  const [language, setLanguage] = useState<string | null>(user.locale ?? null);
  const [role, setRole] = useState<Role>(user.role);
  const [canExport, setCanExport] = useState(user.canExport);
  const [newPassword, setNewPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = async (body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: UserDto }>(`/api/users/${user.id}`, { method: 'PATCH', body });
      onChanged(res.user);
      toast.show(okMsg);
      return true;
    } catch (err) {
      setError(errorText(err, t('people.manage.saveFailed'), t));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const dirty =
    displayName.trim() !== (user.displayName ?? '') ||
    email.trim().toLowerCase() !== (user.email ?? '') ||
    language !== (user.locale ?? null) ||
    role !== user.role ||
    canExport !== user.canExport;

  return (
    <Sheet title={user.displayName ?? user.username} onClose={onClose}>
      {error && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} /> <bdi>{error}</bdi>
        </div>
      )}
      <div className="field">
        <label htmlFor="mg-name">{t('people.form.displayName')}</label>
        <input
          id="mg-name"
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <EmailField id="mg-email" value={email} onChange={setEmail} />
      <LanguageField
        id="mg-lang"
        value={language}
        onChange={setLanguage}
        hint={t('people.manage.languageHint')}
      />
      <div className="field">
        <label>{t('people.form.role')}</label>
        <RolePicker value={role} onChange={setRole} disabled={isSelf} />
        {isSelf && <span className="hint">{t('people.manage.ownRoleHint')}</span>}
      </div>
      <label className="rs-toggle" style={{ maxWidth: 620 }}>
        <span>
          {t('people.form.letThemSave')}
          <span className="hint" style={{ display: 'block' }}>
            {role === 'admin'
              ? t('people.form.adminsAlwaysDownload')
              : t('people.manage.saveCopiesHint')}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          disabled={role === 'admin'}
          checked={role === 'admin' ? true : canExport}
          onChange={(e) => setCanExport(e.target.checked)}
        />
      </label>
      <button
        className="btn"
        disabled={!dirty || busy}
        onClick={() =>
          void patch(
            {
              displayName: displayName.trim() || null,
              ...(email.trim().toLowerCase() !== (user.email ?? '')
                ? { email: email.trim() || null }
                : {}),
              ...(language !== (user.locale ?? null) ? { locale: language } : {}),
              ...(role !== user.role ? { role } : {}),
              ...(canExport !== user.canExport ? { canExport } : {}),
            },
            t('people.manage.saved'),
          )
        }
      >
        {t('people.manage.saveChanges')}
      </button>

      {!user.proxyManaged && (
        <div className="manage-block">
          <h3>{t('people.manage.resetPassword')}</h3>
          <p className="hint">{t('people.manage.resetPasswordHint')}</p>
          <div className="linkbox">
            <input
              className="input"
              type="text"
              autoComplete="off"
              minLength={10}
              placeholder={t('people.manage.newPasswordPlaceholder')}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button
              className="btn btn--secondary"
              disabled={newPassword.length < 10 || busy}
              onClick={() =>
                void patch({ password: newPassword }, t('people.manage.passwordReset')).then(
                  (ok) => ok && setNewPassword(''),
                )
              }
            >
              {t('people.manage.reset')}
            </button>
          </div>
        </div>
      )}

      <div className="manage-block">
        <h3>{t('people.manage.access')}</h3>
        <div className="manage-row">
          <button
            className="btn btn--secondary btn--sm"
            disabled={busy}
            onClick={async () => {
              try {
                const r = await api<{ revoked: number }>(
                  `/api/users/${user.id}/sign-out-everywhere`,
                  { method: 'POST' },
                );
                toast.show(
                  r.revoked
                    ? t('people.manage.signedOut', { n: r.revoked })
                    : t('people.manage.noSessions'),
                );
                onChanged({ ...user, sessions: 0 });
              } catch {
                toast.show(t('people.manage.signOutFailed'));
              }
            }}
          >
            {t('people.manage.signOutEverywhere')}
          </button>
          {!isSelf && (
            <button
              className="btn btn--secondary btn--sm"
              disabled={busy}
              onClick={() =>
                void patch(
                  { status: user.status === 'disabled' ? 'active' : 'disabled' },
                  user.status === 'disabled'
                    ? t('people.manage.accountEnabled')
                    : t('people.manage.accountDisabled'),
                )
              }
            >
              {user.status === 'disabled' ? (
                <>
                  <IconCheck size={14} /> {t('people.manage.enableAccount')}
                </>
              ) : (
                <>
                  <IconClose size={14} /> {t('people.manage.disableAccount')}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {!isSelf && (
        <div className="manage-block manage-block--danger">
          <h3>{t('people.manage.deleteAccount')}</h3>
          <p className="hint">{t('people.manage.deleteHint')}</p>
          {!confirmDelete ? (
            <button className="btn btn--danger btn--sm" onClick={() => setConfirmDelete(true)}>
              {t('people.manage.deleteNamed', { name: user.displayName ?? user.username })}
            </button>
          ) : (
            <div className="manage-row">
              <button
                className="btn btn--danger btn--sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`/api/users/${user.id}`, { method: 'DELETE' });
                    toast.show(t('people.manage.accountDeleted'));
                    onDeleted();
                  } catch (err) {
                    setError(errorText(err, t('people.manage.deleteFailed'), t));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('people.manage.deleteConfirm')}
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(false)}>
                {t('people.manage.keep')}
              </button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

/** An invitation as the link sheet sends it: the way in, and who and what it is for. */
interface InviteLink {
  url: string;
  code: string;
  role: Role;
  expiresAt: string;
  /** Who it is for, when that is known: the mail goes to them. */
  email?: string | null;
  /** The language the invitation is in; null writes it in this admin's own. */
  language?: string | null;
  /** Their name, as the request or the invitation gave it. */
  name?: string | null;
  /** The book they asked about, for an approved join request. */
  bookTitle?: string | null;
}

/**
 * The app's language for somebody else: each language listed in its own
 * name, as the Settings picker lists them, and first the choice to leave it
 * to their device.
 */
function LanguageField({
  id,
  value,
  onChange,
  hint,
}: {
  id: string;
  value: string | null;
  onChange: (code: string | null) => void;
  hint?: string;
}) {
  const t = useT();
  return (
    <div className="field">
      <label htmlFor={id}>{t('people.form.language')}</label>
      <select
        id={id}
        className="input input--select"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{t('people.form.languageDevice')}</option>
        {UI_LOCALES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.native}
          </option>
        ))}
      </select>
      <span className="hint">{hint ?? t('people.form.languageHint')}</span>
    </div>
  );
}

/** An optional email address: a second name to sign in with. */
function EmailField({
  id,
  value,
  onChange,
  hint,
}: {
  id: string;
  value: string;
  onChange: (email: string) => void;
  hint?: string;
}) {
  const t = useT();
  return (
    <div className="field">
      <label htmlFor={id}>{t('people.form.email')}</label>
      <input
        id={id}
        className="input"
        type="email"
        dir="ltr"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        placeholder={t('people.add.optional')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="hint">{hint ?? t('people.form.emailHint')}</span>
    </div>
  );
}

/**
 * Let a join request in: the language their sign-up page opens in and their
 * account keeps - the one they asked in, unless the admin knows better - and
 * then straight on to the link to send them.
 */
function ApproveSheet({
  request,
  onClose,
  onApproved,
}: {
  request: JoinRequestDto;
  onClose: () => void;
  onApproved: (r: JoinRequestDto) => void;
}) {
  const t = useT();
  const [language, setLanguage] = useState<string | null>(request.language ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ request: JoinRequestDto | null }>(
        `/api/join-requests/${request.id}/approve`,
        { method: 'POST', body: { language } },
      );
      if (res.request) onApproved(res.request);
      else onClose();
    } catch (err) {
      setError(errorText(err, t('people.joinRequests.failed'), t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={t('people.joinRequests.approveTitle', { name: request.name ?? request.email })}
      onClose={onClose}
    >
      {error && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} /> <bdi>{error}</bdi>
        </div>
      )}
      <p style={{ marginTop: 0 }}>
        {t('people.joinRequests.approveLede', { email: request.email })}
      </p>
      <LanguageField
        id="jr-lang"
        value={language}
        onChange={setLanguage}
        hint={t('people.joinRequests.languageHint')}
      />
      <button
        className="btn"
        disabled={busy}
        style={{ width: '100%' }}
        onClick={() => void approve()}
      >
        <IconCheck size={16} /> {t('people.joinRequests.approveConfirm')}
      </button>
    </Sheet>
  );
}

/**
 * The way in, ready to hand over. ReadPort sends no mail of its own, so the
 * message is written here - in the language the invitation is in, whatever
 * this admin's app speaks - and goes out through their own mail, the phone's
 * share sheet, or the clipboard.
 */
function InviteLinkSheet({ link, onClose }: { link: InviteLink; onClose: () => void }) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const here = useLocale();
  const { user: me } = useSession();
  const [message, setMessage] = useState<{ subject: string; body: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const language = link.language ?? here;
    void translatorFor(language).then((tl) => {
      if (!alive) return;
      let date: string;
      try {
        date = new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(
          new Date(link.expiresAt),
        );
      } catch {
        date = link.expiresAt.slice(0, 10);
      }
      // A date that ends in its own full stop - Russian "8 октября 2026 г." -
      // ends the sentence with it, rather than with a second one after it.
      date = date.replace(/\.$/, '');
      const values = {
        name: me?.displayName ?? me?.username ?? '',
        title: link.bookTitle ?? '',
        url: link.url,
        code: link.code,
        date,
      };
      setMessage({
        subject: tl('people.link.mailSubject'),
        body: link.bookTitle
          ? tl('people.link.mailBodyBook', values)
          : tl('people.link.mailBody', values),
      });
    });
    return () => {
      alive = false;
    };
  }, [link, here, me]);

  const mailto = message
    ? `mailto:${encodeURIComponent(link.email ?? '')}?subject=${encodeURIComponent(
        message.subject,
      )}&body=${encodeURIComponent(message.body)}`
    : undefined;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <Sheet title={t('people.link.title')} onClose={onClose}>
      <p style={{ marginTop: 0 }}>
        {t('people.link.shareOnce', { role: link.role, date: f.date(link.expiresAt) })}
      </p>
      {(link.email || link.language) && (
        <p className="hint" style={{ marginTop: 0 }}>
          {link.email && <bdi>{t('people.link.forEmail', { email: link.email })}</bdi>}
          {link.email && link.language && ' · '}
          {link.language && (
            <span lang={link.language}>
              {UI_LOCALES.find((l) => l.code === link.language)?.native ?? link.language}
            </span>
          )}
        </p>
      )}
      <div className="field">
        <label htmlFor="iv-code">{t('people.link.codeLabel')}</label>
        <input
          id="iv-code"
          className="input invitecode"
          dir="ltr"
          readOnly
          value={link.code}
          onFocus={(e) => e.currentTarget.select()}
        />
        <span className="hint">{t('people.link.codeHint')}</span>
      </div>
      <div className="linkbox">
        <input
          className="input"
          dir="ltr"
          readOnly
          value={link.url}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard?.writeText(link.url).then(
              () => toast.show(t('people.link.copied')),
              () => toast.show(t('people.link.copyFailed')),
            );
          }}
        >
          {t('people.link.copy')}
        </button>
      </div>
      <div className="manage-row" style={{ marginTop: 12 }}>
        <a
          className={`btn btn--secondary btn--sm ${mailto ? '' : 'is-disabled'}`}
          href={mailto}
          aria-disabled={!mailto}
        >
          <IconMail size={15} /> {t('people.link.email')}
        </a>
        {canShare && message && (
          <button
            className="btn btn--secondary btn--sm"
            onClick={() =>
              void navigator.share({ title: message.subject, text: message.body }).catch(() => {})
            }
          >
            <IconShare size={15} /> {t('people.link.share')}
          </button>
        )}
      </div>
    </Sheet>
  );
}
