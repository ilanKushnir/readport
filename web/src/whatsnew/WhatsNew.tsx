import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { IconChevronRight, IconClose } from '../components/icons';
import { useFocusTrap, useScrollLock } from '../components/ui';
import { useT } from '../i18n';
import { useSession } from '../state/session';
import { CHANGELOG, LATEST_RELEASE_VERSION, shouldAnnounce } from './changelog';
import './whatsnew.css';

/**
 * Same-device echo of the account-level answer. The truth lives on the
 * server (`/api/prefs/whatsnew`), so dismissing on a phone also silences a
 * laptop; this only stops the dialog flashing on a reload before the
 * account's answer has arrived, and keeps it shut offline.
 */
const SEEN_KEY = 'rp-whatsnew-seen';

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    /* private mode; the server still remembers */
  }
}

/**
 * Shown once per release, and only to somebody who was here before it.
 *
 * A brand-new account does NOT get it: being handed a changelog for software
 * you have never used is noise, so the server stamps the current version on
 * every account it creates. `null` therefore means "was already here when
 * this feature landed", which is exactly who should be told. See
 * `shouldAnnounce` for the comparison.
 */
export function WhatsNew() {
  const { phase, whatsNewSeen } = useSession();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (phase !== 'ready') return;
    if (!shouldAnnounce(whatsNewSeen)) return;
    // Same device, already dismissed: do not flash it again while the
    // account-level write is still in flight, or while offline.
    if (readSeen() === LATEST_RELEASE_VERSION) return;
    setOpen(true);
  }, [phase, whatsNewSeen]);

  const dismiss = () => {
    setOpen(false);
    writeSeen(LATEST_RELEASE_VERSION);
    // Fire and forget: the worst case is being told once more on another
    // device, which is a great deal better than blocking the way in.
    void api('/api/prefs/whatsnew', {
      method: 'PUT',
      body: { seenVersion: LATEST_RELEASE_VERSION },
    }).catch(() => {});
  };

  // The dialog is its own component so its focus trap and scroll lock exist
  // only while it is on screen. Mounted alongside the shell, a trap that
  // listens for Escape all the time would take a keypress meant for some
  // other dialog as a dismissal, and mark the release seen unread.
  return open ? <WhatsNewDialog onDismiss={dismiss} /> : null;
}

function WhatsNewDialog({ onDismiss: dismiss }: { onDismiss: () => void }) {
  const t = useT();
  const [showOlder, setShowOlder] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, dismiss);
  useScrollLock(true);

  const [current, ...older] = CHANGELOG;
  if (!current) return null;

  return createPortal(
    <>
      <div className="wn-backdrop" onClick={dismiss} aria-hidden="true" />
      <div
        className="wn"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wn-title"
        tabIndex={-1}
        ref={ref}
      >
        <header className="wn__head">
          <div className="wn__heading">
            <p className="wn__eyebrow">{t('whatsnew.eyebrow', { version: current.version })}</p>
            <h2 className="wn__title" id="wn-title">
              {t('whatsnew.title')}
            </h2>
          </div>
          <button className="icon-btn" onClick={dismiss} aria-label={t('common.close')}>
            <IconClose />
          </button>
        </header>

        <div className="wn__body">
          <p className="wn__lede">{t('whatsnew.lede')}</p>
          <ul className="wn__list">
            {current.items.map((item) => (
              <li key={item.key}>
                <span className="wn__emoji" aria-hidden="true">
                  {item.emoji}
                </span>
                <span>{t(`whatsnew.release.${item.key}` as 'whatsnew.title')}</span>
              </li>
            ))}
          </ul>

          {older.length > 0 && (
            <>
              <button
                type="button"
                className="wn__older"
                onClick={() => setShowOlder((v) => !v)}
                aria-expanded={showOlder}
              >
                <IconChevronRight size={15} data-mirror="" />
                {showOlder ? t('whatsnew.hideOlder') : t('whatsnew.showOlder')}
              </button>

              {showOlder &&
                older.map((release) => (
                  <section className="wn__past" key={release.version}>
                    <h3 className="wn__pasthead">
                      {t('whatsnew.olderHeading', { version: release.version })}
                    </h3>
                    <ul className="wn__list">
                      {release.items.map((item) => (
                        <li key={item.key}>
                          <span className="wn__emoji" aria-hidden="true">
                            {item.emoji}
                          </span>
                          <span>{t(`whatsnew.release.${item.key}` as 'whatsnew.title')}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
            </>
          )}
        </div>

        <footer className="wn__foot">
          <button className="btn btn--primary wn__done" onClick={dismiss}>
            {t('whatsnew.done')}
          </button>
        </footer>
      </div>
    </>,
    document.body,
  );
}
