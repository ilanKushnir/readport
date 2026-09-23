import { useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { refreshToLatest, useNewVersion } from '../pwa/update';
import { IconClose, IconRefresh } from './icons';

/** A version put away with "Not now", for as long as the app stays open. */
const DISMISSED_KEY = 'rp-update-dismissed';

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, version);
  } catch {
    /* private mode: put away until the next reload instead */
  }
}

/**
 * A newer ReadPort is on the server than the one on screen: say so, with the
 * one button that fixes it.
 *
 * It waits at the bottom of the screen rather than interrupting, so whatever
 * somebody is in the middle of, they can finish first; and like the other
 * things the shell pins there, it is never shown over a book being read or
 * listened to. "Not now" puts it away until the app is next opened, or until
 * an even newer version comes along.
 */
export function UpdateCard() {
  const t = useT();
  const version = useNewVersion();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [refreshing, setRefreshing] = useState(false);
  const card = useRef<HTMLElement | null>(null);
  const show = version !== null && version !== dismissed;

  // The toasts, and the end of a page on a phone, make room for it.
  useLayoutEffect(() => {
    const el = card.current;
    if (!show || !el) return;
    const root = document.documentElement;
    const measure = () =>
      root.style.setProperty('--rp-update-card-h', `${Math.ceil(el.offsetHeight)}px`);
    measure();
    root.classList.add('has-update-card');
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.classList.remove('has-update-card');
      root.style.removeProperty('--rp-update-card-h');
    };
  }, [show]);

  return (
    // Always there, so that the card appearing inside it is announced.
    <div className="update-card-live" role="status">
      {show && (
        <section ref={card} className="update-card" aria-labelledby="update-card-title">
          <span className="update-card__mark" aria-hidden="true">
            <IconRefresh size={18} />
          </span>
          <div className="update-card__text">
            <p id="update-card-title" className="update-card__title">
              {t('whatsnew.update.title')}
            </p>
            <p className="update-card__detail">{t('whatsnew.update.detail', { version })}</p>
          </div>
          <button
            type="button"
            className="update-card__later"
            aria-label={t('whatsnew.update.later')}
            title={t('whatsnew.update.later')}
            onClick={() => {
              writeDismissed(version);
              setDismissed(version);
            }}
          >
            <IconClose size={16} />
          </button>
          <button
            type="button"
            className="btn update-card__refresh"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void refreshToLatest();
            }}
          >
            {refreshing ? t('whatsnew.update.refreshing') : t('whatsnew.update.refresh')}
          </button>
        </section>
      )}
    </div>
  );
}
