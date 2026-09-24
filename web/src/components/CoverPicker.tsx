import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { type BookSummary, type CoverSourceName } from '@readport/shared';
import { api, failureMessage } from '../api/client';
import { Cover, useToast } from './ui';
import { IconCheck, IconChevronLeft, IconChevronRight, IconClose, IconSearch } from './icons';
import { useT } from '../i18n';
import { COVER_SOURCE_NAME } from '../lib/cover';

type Source = 'edition' | CoverSourceName;

interface Suggestion {
  n: number;
  source: Source;
  title: string | null;
  author: string | null;
  width: number;
  height: number;
}

interface SuggestionsResponse {
  state: 'has-cover' | 'found' | 'none' | 'ask' | 'dismissed';
  auto: boolean;
  /** Whether an admin has left any source to look in. */
  canLook: boolean;
  suggestions: Suggestion[];
}

/**
 * A book's cover on its page - and, for a curator, a way to give a book
 * without one a cover.
 *
 * A curator opening a coverless book is offered what ReadPort found: its
 * other format's own cover, straight away, and what the catalogues an admin
 * chose have for it - by themselves when an admin has said so (Settings),
 * or when the curator presses Find a cover. The picture stands in the cover's own frame, marked
 * as a suggestion, with the way to take it underneath; "Not these" puts the
 * offer away for good. A cover picked this way says so, and can be changed.
 *
 * Everyone else sees the cover, and nothing else.
 */
export function CoverPicker({
  book,
  canCurate,
  onChanged,
  children,
}: {
  book: BookSummary;
  canCurate: boolean;
  /** The book as it is now its cover has changed. */
  onChanged: (book: BookSummary) => void;
  /** Drawn over the cover (the hidden mark). */
  children?: ReactNode;
}) {
  const t = useT();
  const toast = useToast();
  const [data, setData] = useState<SuggestionsResponse | null>(null);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState<'look' | 'use' | 'dismiss' | 'remove' | null>(null);
  // A picked cover is changed on request; a missing one is looked for on arrival.
  const [changing, setChanging] = useState(false);
  const coverless = !book.hasCover;
  const wanted = canCurate && (coverless || changing);

  const ask = useCallback(
    (look: boolean) =>
      api<SuggestionsResponse>(`/api/books/${book.id}/cover-suggestions${look ? '?look=1' : ''}`),
    [book.id],
  );

  // What there already is to offer, on arrival: the other format's own
  // cover, a lookup made before, or - when an admin has turned suggestions
  // on - a lookup made now. Asked only for a book with no cover.
  useEffect(() => {
    setData(null);
    setChanging(false);
    setAt(0);
    if (!canCurate || book.hasCover) return;
    let cancelled = false;
    ask(false).then(
      (res) => {
        if (!cancelled) setData(res);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [ask, book.hasCover, canCurate]);

  /** Ask the catalogues an admin chose, now. Resolves to whether anything was found. */
  const look = async (): Promise<boolean> => {
    setBusy('look');
    try {
      const res = await ask(true);
      setData(res);
      setAt(0);
      if (res.suggestions.length === 0) toast.show(t('library.cover.nothing'));
      return res.suggestions.length > 0;
    } catch (err) {
      toast.show(failureMessage(err, t('library.cover.lookFailed'), t));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const suggestions = wanted && data?.state === 'found' ? data.suggestions : [];
  const shown = suggestions[at] ?? null;

  const use = async () => {
    if (!shown) return;
    setBusy('use');
    try {
      const res = await api<{ book: BookSummary }>(
        `/api/books/${book.id}/cover-suggestions/${shown.n}/accept`,
        { method: 'POST' },
      );
      setData(null);
      setChanging(false);
      onChanged(res.book);
      toast.show(t('library.cover.saved'));
    } catch (err) {
      toast.show(failureMessage(err, t('library.cover.failed'), t));
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async () => {
    if (changing) {
      setChanging(false);
      setData(null);
      return;
    }
    setBusy('dismiss');
    try {
      await api(`/api/books/${book.id}/cover-suggestions/dismiss`, { method: 'POST' });
      setData((d) => (d ? { ...d, state: 'dismissed', suggestions: [] } : d));
      toast.show(t('library.cover.dismissed'));
    } catch (err) {
      toast.show(failureMessage(err, t('library.cover.failed'), t));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      const res = await api<{ book: BookSummary }>(`/api/books/${book.id}/found-cover`, {
        method: 'DELETE',
      });
      setChanging(false);
      onChanged(res.book);
      toast.show(t('library.cover.removed'));
    } catch (err) {
      toast.show(failureMessage(err, t('library.cover.failed'), t));
    } finally {
      setBusy(null);
    }
  };

  const from = (s: Suggestion) =>
    s.source === 'edition'
      ? t(book.kind === 'ebook' ? 'library.cover.fromAudiobook' : 'library.cover.fromEbook')
      : t('library.cover.from', { source: COVER_SOURCE_NAME[s.source] });

  /** Look for another cover for one picked before; the picked one stays until another is chosen. */
  const change = async () => {
    setChanging(true);
    if (!(await look())) setChanging(false);
  };

  return (
    <div className={`covercol${shown ? ' is-suggesting' : ''}`}>
      <span className={`book-hero__coverwrap ${book.hidden ? 'is-hidden' : ''}`}>
        {shown ? (
          <>
            <img
              key={`${book.id}-${shown.n}`}
              className="book-hero__cover covercol__suggestion"
              src={`/api/books/${book.id}/cover-suggestions/${shown.n}/image`}
              alt={t('library.cover.suggestedAlt', { title: book.title })}
            />
            <span className="covercol__tag">{t('library.cover.suggested')}</span>
          </>
        ) : (
          <Cover book={book} className="book-hero__cover" />
        )}
        {children}
      </span>

      {shown ? (
        <div className="covercol__panel" role="group" aria-label={t('library.cover.suggested')}>
          <span className="covercol__from">{from(shown)}</span>
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy !== null}
            onClick={() => void use()}
          >
            <IconCheck size={15} />
            {busy === 'use' ? t('library.cover.saving') : t('library.cover.use')}
          </button>
          {suggestions.length > 1 && (
            <span className="covercol__step">
              <button
                type="button"
                className="icon-btn covercol__arrow"
                aria-label={t('library.cover.previous')}
                disabled={at === 0}
                onClick={() => setAt((i) => Math.max(0, i - 1))}
              >
                <IconChevronLeft size={16} />
              </button>
              <span aria-live="polite">
                {t('library.cover.of', { n: at + 1, total: suggestions.length })}
              </span>
              <button
                type="button"
                className="icon-btn covercol__arrow"
                aria-label={t('library.cover.next')}
                disabled={at >= suggestions.length - 1}
                onClick={() => setAt((i) => Math.min(suggestions.length - 1, i + 1))}
              >
                <IconChevronRight size={16} />
              </button>
            </span>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy !== null}
            onClick={() => void dismiss()}
          >
            <IconClose size={14} />
            {changing ? t('library.cover.keep') : t('library.cover.notThese')}
          </button>
        </div>
      ) : canCurate && coverless ? (
        data?.canLook && (
          <button
            type="button"
            className="btn btn--secondary btn--sm covercol__find"
            disabled={busy !== null}
            onClick={() => void look()}
          >
            <IconSearch size={15} />
            {busy === 'look' ? t('library.cover.finding') : t('library.cover.find')}
          </button>
        )
      ) : canCurate && book.coverFound ? (
        <p className="covercol__note">
          {book.coverFound === 'edition'
            ? t(
                book.kind === 'ebook'
                  ? 'library.cover.pickedFromAudiobook'
                  : 'library.cover.pickedFromEbook',
              )
            : t('library.cover.pickedFrom', { source: COVER_SOURCE_NAME[book.coverFound] })}{' '}
          <button
            type="button"
            className="covercol__link"
            disabled={busy !== null}
            onClick={() => void change()}
          >
            {busy === 'look' ? t('library.cover.finding') : t('library.cover.change')}
          </button>
          {' · '}
          <button
            type="button"
            className="covercol__link"
            disabled={busy !== null}
            onClick={() => void remove()}
          >
            {t('library.cover.remove')}
          </button>
        </p>
      ) : null}
    </div>
  );
}
