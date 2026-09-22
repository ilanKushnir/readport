import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, failureMessage } from '../api/client';
import { useToast } from '../components/ui';
import { IconChat, IconClose, IconLink, IconShare } from '../components/icons';
import { useSession } from '../state/session';
import { useT } from '../i18n';
import { createShare, currentShare, revokeShare } from './api';

/**
 * Share, as one button with a small menu under it.
 *
 * Opening the menu makes nothing: it asks whether a link already exists and
 * says so. The link is minted by the first thing that needs it - copying it,
 * sending it on WhatsApp, handing it to the phone's share tray - so looking
 * at the menu is not the same as handing out a link. Withdrawing it is here
 * too, quietly at the end, for the person who shared a book and thought
 * better of it: the next share makes a fresh link.
 */
export function ShareMenu({ bookId, title }: { bookId: string; title: string }) {
  const t = useT();
  const toast = useToast();
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<{ url: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const canTray = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  const toggle = () => {
    if (open) return close();
    const r = trigger.current?.getBoundingClientRect();
    // Hang from the end edge when the start edge would run off the screen.
    setAlignEnd(!!r && r.left + 260 > window.innerWidth);
    setOpen(true);
    currentShare(bookId)
      .then((res) => setLink(res.url && res.token ? { url: res.url, token: res.token } : null))
      .catch(() => {});
  };

  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
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

  /** The link, made on first need. */
  const ensure = async (): Promise<{ url: string; token: string } | null> => {
    if (link) return link;
    setBusy(true);
    try {
      const made = await createShare(bookId);
      setLink(made);
      return made;
    } catch (err) {
      toast.show(failureMessage(err, t('share.sheet.failed'), t));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const message = (url: string) =>
    `${t('share.sheet.text', { name: user?.displayName ?? user?.username ?? '', title })} ${url}`;

  const copy = async () => {
    const l = await ensure();
    if (!l) return;
    try {
      await navigator.clipboard.writeText(l.url);
      toast.show(t('share.sheet.copied'));
    } catch {
      toast.show(t('share.sheet.copyFailed'));
    }
    close();
  };
  const whatsapp = async () => {
    const l = await ensure();
    if (!l) return;
    // wa.me opens the app on a phone and WhatsApp Web on a desk.
    window.open(`https://wa.me/?text=${encodeURIComponent(message(l.url))}`, '_blank', 'noopener');
    close();
  };
  const tray = async () => {
    const l = await ensure();
    if (!l) return;
    try {
      await navigator.share({ title, text: message(l.url), url: l.url });
    } catch {
      /* the tray was dismissed, or refused; nothing to report */
    }
    close();
  };
  const withdraw = async () => {
    if (!link) return;
    try {
      await revokeShare(link.token);
      setLink(null);
      toast.show(t('share.menu.withdrawn'));
    } catch (err) {
      toast.show(
        err instanceof ApiError && err.status === 404
          ? t('share.menu.withdrawn')
          : failureMessage(err, t('share.sheet.failed'), t),
      );
    }
    close();
  };

  return (
    <div className="share-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="btn btn--ghost book-tool"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <IconShare size={17} />
        <span>{t('share.button')}</span>
      </button>
      {open && (
        <div className={`share-menu__pop${alignEnd ? ' is-end' : ''}`} role="menu">
          <p className="share-menu__hint">{t('share.sheet.lede')}</p>
          <button
            ref={first}
            type="button"
            role="menuitem"
            className="share-menu__item"
            disabled={busy}
            onClick={() => void copy()}
          >
            <IconLink size={17} /> {t('share.sheet.copy')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="share-menu__item"
            disabled={busy}
            onClick={() => void whatsapp()}
          >
            <IconChat size={17} /> {t('share.menu.whatsapp')}
          </button>
          {canTray && (
            <button
              type="button"
              role="menuitem"
              className="share-menu__item"
              disabled={busy}
              onClick={() => void tray()}
            >
              <IconShare size={17} /> {t('share.sheet.native')}
            </button>
          )}
          {link && (
            <>
              <div className="share-menu__sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="share-menu__item share-menu__item--quiet"
                onClick={() => void withdraw()}
              >
                <IconClose size={15} /> {t('share.menu.withdraw')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
