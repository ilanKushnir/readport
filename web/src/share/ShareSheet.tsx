import { useEffect, useState } from 'react';
import { Sheet, useToast } from '../components/ui';
import { IconLink } from '../components/icons';
import { useSession } from '../state/session';
import { failureMessage } from '../api/client';
import { useT } from '../i18n';
import { createShare } from './api';

/**
 * The Share sheet on the book page: the link, a Copy button, and - where
 * the browser has a share tray - the tray itself. The link is made when
 * the sheet opens, and the same one comes back every time until it is
 * revoked, so opening the sheet twice does not mint two links.
 */
export function ShareSheet({
  bookId,
  title,
  onClose,
}: {
  bookId: string;
  title: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { user } = useSession();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    let alive = true;
    createShare(bookId)
      .then((res) => {
        if (alive) setUrl(res.url);
      })
      .catch((err) => {
        if (alive) setError(failureMessage(err, t('share.sheet.failed'), t));
      });
    return () => {
      alive = false;
    };
  }, [bookId, t]);

  const text = t('share.sheet.text', { name: user?.displayName ?? user?.username ?? '', title });

  const copy = () => {
    if (!url) return;
    void navigator.clipboard?.writeText(url).then(
      () => toast.show(t('share.sheet.copied')),
      () => toast.show(t('share.sheet.copyFailed')),
    );
  };

  const share = async () => {
    if (!url) return;
    try {
      await navigator.share({ title, text, url });
    } catch {
      /* the tray was dismissed, or the browser refused; the link is still on screen */
    }
  };

  return (
    <Sheet title={t('share.sheet.title', { title })} onClose={onClose}>
      <p className="sheet__lede">{t('share.sheet.lede')}</p>
      {error && (
        <div className="banner banner--error" role="alert">
          <bdi>{error}</bdi>
        </div>
      )}
      <div className="field">
        <label htmlFor="share-link">{t('share.sheet.linkLabel')}</label>
        <div className="linkbox">
          <input
            id="share-link"
            className="input"
            dir="ltr"
            readOnly
            value={url ?? t('share.sheet.creating')}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button className="btn" disabled={!url} onClick={copy}>
            <IconLink size={16} /> {t('share.sheet.copy')}
          </button>
        </div>
      </div>
      {canShare && (
        <div className="sheet__actions">
          <button className="btn btn--secondary" disabled={!url} onClick={() => void share()}>
            {t('share.sheet.native')}
          </button>
        </div>
      )}
    </Sheet>
  );
}
