import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type Locator, type TranslationTitle } from '@readport/shared';
import { isOffline } from '../api/client';
import { Cover, Sheet, useToast } from '../components/ui';
import { IconBookOpen, IconHeadphones } from '../components/icons';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { type MessageKey } from '../i18n/messages/en';
import { bookOf, carryOver, continueUrl } from './continue';
import './translations.css';

/** What opening an edition from here will do, in one line. */
export function landingNote(title: TranslationTitle, kind: 'ebook' | 'audio'): MessageKey {
  if (kind === 'ebook' && (title.match === 'close' || title.match === 'rough'))
    return 'translations.continue.paragraph';
  if (title.match === 'pending') return 'translations.continue.pending';
  return 'translations.continue.approximate';
}

/**
 * The book's other languages, from inside the book: carry on reading or
 * listening in one of them from the place on screen now. Shared by the
 * reader and the player - `here` is wherever each of them is.
 *
 * The reader also offers to show the page in the other language without
 * leaving it (`onPeek`); the player has no page to show.
 */
export function LanguagesSheet({
  bookId,
  language,
  titles,
  here,
  onPeek,
  onClose,
}: {
  bookId: string;
  /** This book's language, for the greeting on the other side. */
  language: string | null;
  titles: TranslationTitle[];
  /** Where the reader or listener is now. */
  here: () => Locator | null;
  onPeek?: (title: TranslationTitle) => void;
  onClose: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);

  const go = async (title: TranslationTitle, toBookId: string) => {
    const from = here();
    if (!from) return;
    setBusy(toBookId);
    try {
      const res = await carryOver(bookId, from, toBookId);
      navigate(continueUrl(res, language));
    } catch (err) {
      setBusy(null);
      toast.show(
        isOffline(err)
          ? t('translations.continue.offline')
          : t('translations.continue.failed', { language: f.languageName(title.language) }),
      );
    }
  };

  return (
    <Sheet title={t('translations.continue.title')} onClose={onClose}>
      <ul className="lang-list">
        {titles.map((title) => {
          const ebook = bookOf(title, 'ebook');
          const audio = bookOf(title, 'audio');
          const lead = ebook ?? audio!;
          const name = f.languageName(title.language);
          return (
            <li key={lead.id} className="lang-row">
              <span className="edition-cover edition-cover--md">
                <Cover
                  book={{
                    id: lead.id,
                    title: title.title,
                    author: title.author,
                    hasCover: lead.hasCover,
                    kind: lead.kind,
                  }}
                />
              </span>
              <div className="lang-row__body">
                <span className="lang-row__lang">{name}</span>
                <bdi className="lang-row__title" lang={title.language ?? undefined}>
                  {title.title}
                </bdi>
                {title.progress && (
                  <span className="lang-row__progress">
                    {title.progress.finished
                      ? t('library.card.finished')
                      : t('library.book.progress', {
                          pct: f.percent(title.progress.pct),
                          kind:
                            title.books.find((b) => b.id === title.progress!.bookId)?.kind ??
                            'ebook',
                        })}
                  </span>
                )}
                <div className="lang-row__actions">
                  {ebook && (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={busy !== null}
                      aria-label={t('translations.continue.readIn', { language: name })}
                      onClick={() => void go(title, ebook.id)}
                    >
                      <IconBookOpen size={16} />
                      {busy === ebook.id
                        ? t('translations.continue.opening')
                        : t('translations.continue.read')}
                    </button>
                  )}
                  {audio && (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={busy !== null}
                      aria-label={t('translations.continue.listenIn', { language: name })}
                      onClick={() => void go(title, audio.id)}
                    >
                      <IconHeadphones size={16} />
                      {busy === audio.id
                        ? t('translations.continue.opening')
                        : t('translations.continue.listen')}
                    </button>
                  )}
                  {onPeek && ebook && title.match !== 'none' && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy !== null}
                      onClick={() => onPeek(title)}
                    >
                      {t('translations.continue.peek', { language: name })}
                    </button>
                  )}
                </div>
                <span className="lang-row__note">
                  {t(landingNote(title, ebook ? 'ebook' : 'audio'))}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
