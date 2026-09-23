import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { downloadFraction, preparedFraction } from '../offline/downloads';
import { useActiveDownloads } from '../offline/useDownloads';

/**
 * What is being saved offline, wherever the reader is in the app.
 *
 * A download used to be visible only on the page that started it - leave
 * the book page and it went on, unseen, until a toast said it had finished
 * or failed. This small pill sits above the tab bar on a phone and in the
 * corner on a desk: a ring that fills, the book's title, and how far it
 * has got. It opens the book, where the download can be followed or
 * stopped. Not shown over a book being read: the reader and the player
 * have enough on screen.
 */
export function DownloadsPill() {
  const t = useT();
  const f = useFormat();
  const active = useActiveDownloads();
  const first = active[0] ?? null;

  // The toasts move up while the pill is there, so neither covers the other.
  useEffect(() => {
    const root = document.documentElement;
    if (!first) return;
    root.classList.add('has-downloads-pill');
    return () => root.classList.remove('has-downloads-pill');
  }, [first]);

  if (!first) return null;
  const preparing = first.phase === 'preparing';
  const fraction = preparing ? preparedFraction(first) : downloadFraction(first);
  const pct = Math.round(fraction * 100);
  const title = first.title ?? t('library.offline.pill');
  return (
    <Link
      to={`/book/${first.bookId}`}
      className="downloads-pill"
      aria-label={t('library.offline.pillLabel', { title, pct: f.percent(fraction) })}
    >
      <span
        className="downloads-pill__ring"
        style={{ '--pct': pct } as React.CSSProperties}
        aria-hidden="true"
      >
        <span className="downloads-pill__pct">{f.number(pct)}</span>
      </span>
      <span className="downloads-pill__text" aria-hidden="true">
        <span className="downloads-pill__what">
          {preparing ? t('library.offline.preparing') : t('library.offline.pill')}
        </span>
        <bdi className="downloads-pill__title">{title}</bdi>
      </span>
      {active.length > 1 && (
        <span className="downloads-pill__more" aria-hidden="true">
          {t('library.offline.pillMore', { n: active.length - 1 })}
        </span>
      )}
    </Link>
  );
}
