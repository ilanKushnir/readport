import { Link } from 'react-router-dom';
import { type TranslationTitle } from '@readport/shared';
import { IconCheck, IconLanguages } from '../components/icons';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { leadBook } from './continue';
import './translations.css';

/**
 * "Also in Russian · German", under a book's title: the same book in the
 * other languages it is linked to, each a way to its page. A reader who has
 * opened one sees how far they are in it on its chip - the two editions
 * keep separate places, and this is where the other one is said.
 *
 * Two editions in one language (two translations into English of the same
 * novel) are told apart by title.
 */
export function OtherLanguagesRow({ titles }: { titles: TranslationTitle[] }) {
  const t = useT();
  const f = useFormat();
  if (titles.length === 0) return null;
  const counts = new Map<string, number>();
  for (const x of titles) counts.set(x.language ?? '', (counts.get(x.language ?? '') ?? 0) + 1);
  return (
    <div className="also-in" role="group" aria-label={t('translations.rowLabel')}>
      <span className="also-in__label">
        <IconLanguages size={15} />
        {t('translations.alsoIn')}
      </span>
      {titles.map((title) => {
        const book = leadBook(title);
        const language = f.languageName(title.language);
        const twice = (counts.get(title.language ?? '') ?? 0) > 1;
        const p = title.progress;
        const label = p
          ? p.finished
            ? t('translations.chipFinished', { language, title: title.title })
            : t('translations.chipProgress', {
                language,
                title: title.title,
                pct: f.percent(p.pct),
              })
          : t('translations.chip', { language, title: title.title });
        return (
          <Link
            key={book.id}
            to={`/book/${book.id}`}
            className="also-in__chip"
            aria-label={label}
            title={title.title}
          >
            <span className="also-in__lang">{language}</span>
            {twice && (
              <bdi className="also-in__title" lang={title.language ?? undefined}>
                {title.title}
              </bdi>
            )}
            {p &&
              (p.finished ? (
                <IconCheck size={13} className="also-in__done" aria-hidden="true" />
              ) : p.pct > 0.005 ? (
                <span className="also-in__pct" aria-hidden="true">
                  {f.percent(p.pct)}
                </span>
              ) : null)}
          </Link>
        );
      })}
    </div>
  );
}
