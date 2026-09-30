import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { formatDuration } from '../lib/format';
import { IconBookOpen, IconClose } from '../components/icons';
import { type BeyondTextNow } from './readalong';
import './beyond.css';

/**
 * Only in the audiobook: said while the voice reads a stretch the ebook does
 * not have - an introduction, a passage this edition cut, what follows the
 * last page.
 *
 * Without it read-along goes quiet in the worst way: the highlight lets go,
 * the page stops, and the reader is left to wonder whether the app has lost
 * its place or they have. So it says three things, in the order a listener
 * needs them: that this part is not in the book, that nothing is wrong and
 * the voice will be back, and when - with a way on for anyone who would
 * rather not wait. The page meanwhile waits where the text picks up, marked
 * (ReaderPage), so the voice comes back to a page that is already there.
 *
 * It floats over the text above the transport rather than joining the bar
 * beneath: a row in the bar would re-lay the chapter out, and this is the
 * one moment the page must not move under the reader.
 */
export function BeyondTextCard({
  ref,
  now,
  playing,
  raised,
  onSkip,
  onHide,
}: {
  ref?: React.Ref<HTMLElement>;
  now: BeyondTextNow;
  playing: boolean;
  /** Lifted over the way-back pill when that is showing too. */
  raised: boolean;
  onSkip: () => void;
  onHide: () => void;
}) {
  const t = useT();
  const { stretch, remainingMs, progress } = now;
  // Whole seconds, so the countdown ticks rather than flickers.
  const time = formatDuration(Math.ceil(remainingMs / 1000) * 1000);
  const line =
    stretch.where === 'start'
      ? 'reader.readAlong.beyond.start'
      : stretch.where === 'end'
        ? 'reader.readAlong.beyond.end'
        : 'reader.readAlong.beyond.middle';

  // Said once to a screen reader, when the stretch begins - not with every
  // tick of the countdown, which the bar's status carries for whoever asks.
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnnounced(t('reader.readAlong.beyond.announce')));
    return () => cancelAnimationFrame(id);
  }, [stretch.fromMs, t]);

  return (
    <aside
      ref={ref}
      className={`beyond${playing ? ' is-playing' : ''}${raised ? ' is-raised' : ''}`}
      aria-label={t('reader.readAlong.beyond.title')}
      data-where={stretch.where}
    >
      <span className="beyond__voice" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <div className="beyond__body">
        <p className="beyond__title">{t('reader.readAlong.beyond.title')}</p>
        <p className="beyond__line" aria-hidden="true">
          {t(line, { time })}
        </p>
        <div className="beyond__foot">
          <span className="beyond__track" aria-hidden="true">
            <span style={{ transform: `scaleX(${progress})` }} />
          </span>
          {stretch.resume && (
            <button type="button" className="beyond__skip" onClick={onSkip}>
              <IconBookOpen size={15} />
              <span>{t('reader.readAlong.beyond.skip')}</span>
            </button>
          )}
        </div>
      </div>
      <button
        type="button"
        className="beyond__x"
        aria-label={t('reader.readAlong.beyond.hide')}
        title={t('reader.readAlong.beyond.hide')}
        onClick={onHide}
      >
        <IconClose size={14} />
      </button>
      <span className="visually-hidden" role="status">
        {announced}
      </span>
    </aside>
  );
}
