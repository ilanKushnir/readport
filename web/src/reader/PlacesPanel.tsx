import { type ReadingPlace } from '@readport/shared';
import { IconClose } from '../components/icons';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import './places.css';

/**
 * The Places tab of the reader's contents: where this reader reads the book.
 *
 * Their own place first - the one they have read on at longest - then the
 * others they went on to read for a while, each known by its chapter and
 * the words it stopped at, when they were last there and how long they read.
 * Above them the book as a strip, so it is plain at a glance which place is
 * where, and where the reader is now.
 */
export function PlacesPanel({
  places,
  herePct,
  isHere,
  chapterName,
  onGo,
  onForget,
}: {
  places: ReadingPlace[];
  /** Where the reader is now, as a fraction of the book. */
  herePct: number;
  /** Whether the reader is at a place now. */
  isHere: (place: ReadingPlace) => boolean;
  /** A chapter the book never named, called by its number. */
  chapterName: (place: ReadingPlace) => string;
  onGo: (place: ReadingPlace) => void;
  onForget: (place: ReadingPlace) => void;
}) {
  const t = useT();
  const f = useFormat();
  const own = places.find((p) => p.main) ?? null;
  const others = places.filter((p) => !p.main);

  if (places.length === 0) {
    return (
      <div className="places places--empty">
        <p className="places__lede">{t('reader.places.empty')}</p>
      </div>
    );
  }

  const row = (place: ReadingPlace) => {
    const here = isHere(place);
    const where = t('reader.places.where', {
      chapter: chapterName(place),
      pct: f.percent(place.locator.pct),
    });
    const meta = here
      ? t('reader.places.here')
      : t('reader.places.meta', { read: f.span(place.readMs), when: f.ago(place.lastReadAt) });
    return (
      <li
        key={place.id}
        className={`place-row${place.main ? ' is-own' : ''}${here ? ' is-here' : ''}`}
      >
        <button
          type="button"
          className="place-row__open"
          aria-current={here ? 'location' : undefined}
          aria-label={t('reader.places.goLabel', {
            where,
            text: place.excerpt ?? '',
            meta,
          })}
          onClick={() => onGo(place)}
        >
          <span className="place-row__pin" aria-hidden="true" />
          <span className="place-row__body">
            <span className="place-row__where">{where}</span>
            {place.excerpt && (
              <span className="place-row__text">{t('reader.quoted', { text: place.excerpt })}</span>
            )}
            <span className="place-row__meta">{meta}</span>
          </span>
        </button>
        {!place.main && (
          <button
            type="button"
            className="icon-btn place-row__forget"
            aria-label={t('reader.places.forget', { where })}
            onClick={() => onForget(place)}
          >
            <IconClose size={15} />
          </button>
        )}
      </li>
    );
  };

  const pos = (pct: number) => `${Math.min(100, Math.max(0, pct * 100))}%`;
  return (
    <div className="places">
      {/* The book as a strip: the stretch read to the reader's own place,
          a pin for each place, and a tick where the reader is now. */}
      <div className="places-map" aria-hidden="true">
        <span className="places-map__track" />
        {own && (
          <span
            className="places-map__run"
            style={{
              insetInlineStart: pos(own.fromPct),
              width: pos(Math.max(0, own.locator.pct - own.fromPct)),
            }}
          />
        )}
        {places.map((p) => (
          <span
            key={p.id}
            className={`places-map__pin${p.main ? ' is-own' : ''}`}
            style={{ insetInlineStart: pos(p.locator.pct) }}
          />
        ))}
        <span className="places-map__here" style={{ insetInlineStart: pos(herePct) }} />
      </div>

      {own && (
        <section aria-labelledby="places-own">
          <h3 id="places-own" className="places__label">
            {t('reader.places.own')}
          </h3>
          <ul className="places__list">{row(own)}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section aria-labelledby="places-others">
          <h3 id="places-others" className="places__label">
            {t('reader.places.others')}
          </h3>
          <ul className="places__list">{others.map(row)}</ul>
        </section>
      )}
      <p className="places__note">{t('reader.places.note')}</p>
    </div>
  );
}
