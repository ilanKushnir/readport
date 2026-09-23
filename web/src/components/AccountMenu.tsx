import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../state/session';
import { useT } from '../i18n';
import { IconChevronDown, IconSignOut, IconUser } from './icons';

/** The first letter of a name, for the round mark that stands for a person. */
function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : '·';
}

/**
 * Who is signed in, and the way out, at the top of Settings.
 *
 * Signing out used to be a button near the foot of a long page, under the
 * account section, where nobody looking for it would think to scroll. It
 * is the person's own mark now - their initial, and their name where
 * there is room - at the end of the page's title, the place an account is
 * looked for, opening a short menu: who this is, the account settings, and
 * Sign out. Signed in through a proxy, there is no signing out from here,
 * and the menu says where to do it instead.
 *
 * A menu: arrows move through it, Escape closes it and gives focus back to
 * the button, a click outside closes it.
 */
export function AccountMenu({ onAccount }: { onAccount: () => void }) {
  const t = useT();
  const { user, via, logout } = useSession();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const items = () =>
      Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === 'Tab') {
        close(false);
        return;
      }
      const all = items();
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      const to =
        e.key === 'ArrowDown'
          ? (at + 1) % all.length
          : e.key === 'ArrowUp'
            ? (at - 1 + all.length) % all.length
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? all.length - 1
                : -1;
      if (to < 0) return;
      e.preventDefault();
      all[to]?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, close]);

  if (!user) return null;
  const name = user.displayName || user.username;

  return (
    <div className="acct-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="acct-menu__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('settings.account.menuLabel', { name })}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="acct-menu__avatar" aria-hidden="true">
          {initialOf(name)}
        </span>
        <span className="acct-menu__name">{name}</span>
        <IconChevronDown size={14} />
      </button>
      {open && (
        <div
          ref={list}
          className="acct-menu__pop"
          role="menu"
          aria-label={t('settings.account.title')}
        >
          <div className="acct-menu__who">
            <span className="acct-menu__avatar" aria-hidden="true">
              {initialOf(name)}
            </span>
            <span className="acct-menu__whoText">
              <strong>{name}</strong>
              <bdi className="acct-menu__handle">@{user.username}</bdi>
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="acct-menu__item"
            onClick={() => {
              close(false);
              onAccount();
            }}
          >
            <IconUser size={17} />
            {t('settings.account.goTo')}
          </button>
          {via === 'proxy' ? (
            <p className="acct-menu__note">
              {t('settings.account.proxySignOut', { app: t('common.appName') })}
            </p>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="acct-menu__item acct-menu__item--out"
              onClick={() => void logout()}
            >
              <IconSignOut size={17} />
              {t('settings.account.signOut')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
