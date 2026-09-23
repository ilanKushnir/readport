import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type Locator, type TranslationPassage, type TranslationTitle } from '@readport/shared';
import { api, ApiError } from '../api/client';
import { Sheet, useToast } from '../components/ui';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { recordCheckpoint } from '../progress/engine';
import { bookOf } from './continue';
import './translations.css';

type Load =
  | { status: 'loading' }
  | { status: 'ok'; passage: TranslationPassage }
  | { status: 'unmatched' }
  | { status: 'failed' };

/**
 * A passage as another language has it.
 *
 * The reader selects some words, or asks from the languages sheet, and the
 * matching paragraphs of the other edition come up underneath, in that
 * edition's language and direction, set like the book. The passage it
 * matches is marked on the page behind (`onSource`), so which paragraph
 * this is the translation of is never a guess. From here the reader can
 * carry on in the other language at that paragraph.
 */
export function PeekSheet({
  bookId,
  language,
  titles,
  initial,
  spineIdx,
  start,
  end,
  from,
  onSource,
  onClose,
}: {
  bookId: string;
  /** This book's language, for the greeting on the other side. */
  language: string | null;
  /** The other languages that have an ebook to show a passage from. */
  titles: TranslationTitle[];
  initial?: TranslationTitle;
  spineIdx: number;
  start: number;
  end: number;
  /** The place in this book the passage was asked from: recorded when the reader carries on elsewhere. */
  from: Locator;
  /** The passage of this book the one shown matches: mark it on the page. Null to clear. */
  onSource: (span: { spineIdx: number; start: number; end: number } | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const navigate = useNavigate();
  const [which, setWhich] = useState<TranslationTitle>(initial ?? titles[0]!);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const ebook = bookOf(which, 'ebook');
  const name = f.languageName(which.language);
  // Held in a ref: the mark follows the passage shown, not the parent's renders.
  const sourceRef = useRef(onSource);
  sourceRef.current = onSource;

  useEffect(() => {
    if (!ebook) return;
    let alive = true;
    setLoad({ status: 'loading' });
    api<TranslationPassage>(
      `/api/books/${bookId}/translations/passage?to=${encodeURIComponent(ebook.id)}` +
        `&spine=${spineIdx}&start=${start}&end=${Math.max(end, start + 1)}`,
    )
      .then((passage) => {
        if (!alive) return;
        setLoad({ status: 'ok', passage });
        sourceRef.current(passage.source);
      })
      .catch((err) => {
        if (!alive) return;
        sourceRef.current(null);
        setLoad(
          err instanceof ApiError && err.code === 'not-matched'
            ? { status: 'unmatched' }
            : { status: 'failed' },
        );
      });
    return () => {
      alive = false;
    };
    // The span is fixed for the life of the sheet; only the language changes.
  }, [bookId, ebook?.id, spineIdx, start, end]);

  // The mark on the page goes with the sheet.
  useEffect(() => () => sourceRef.current(null), []);

  const carryOn = (passage: TranslationPassage) => {
    // The place left is recorded, so the way back finds it.
    void recordCheckpoint(bookId, 'switch', from);
    const to = passage.to;
    navigate(
      `/read/${passage.bookId}?spine=${to.spineIdx}&char=${to.charOffset ?? 0}` +
        (to.sentenceId ? `&sentence=${encodeURIComponent(to.sentenceId)}` : '') +
        `&handoff=1&via=translation&granularity=${passage.precision}` +
        (language ? `&fromLang=${encodeURIComponent(language)}` : ''),
    );
  };

  return (
    <Sheet
      title={t('translations.peek.title', { language: name })}
      onClose={onClose}
      head={
        titles.length > 1 ? (
          <div className="sheet-tabs" role="tablist" aria-label={t('translations.continue.title')}>
            {titles.map((title) => (
              <button
                key={title.books[0]!.id}
                role="tab"
                aria-selected={title === which}
                onClick={() => setWhich(title)}
              >
                {f.languageName(title.language)}
              </button>
            ))}
          </div>
        ) : undefined
      }
    >
      <p className="peek__from">
        <bdi lang={which.language ?? undefined}>{which.title}</bdi>
      </p>
      {load.status === 'loading' && (
        <div className="peek__loading" role="status">
          <div className="skeleton" style={{ height: 18, marginBlockEnd: 10 }} />
          <div className="skeleton" style={{ height: 18, marginBlockEnd: 10, width: '92%' }} />
          <div className="skeleton" style={{ height: 18, width: '64%' }} />
          <span className="visually-hidden">{t('translations.peek.loading')}</span>
        </div>
      )}
      {load.status === 'unmatched' && (
        <p className="peek__note">{t('translations.peek.notMatched')}</p>
      )}
      {load.status === 'failed' && <p className="peek__note">{t('translations.peek.failed')}</p>}
      {load.status === 'ok' && (
        <>
          <blockquote
            className="peek"
            lang={load.passage.language ?? undefined}
            dir={load.passage.direction}
          >
            {load.passage.paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </blockquote>
          {load.passage.precision === 'proportional' && (
            <p className="peek__note">{t('translations.peek.approximate')}</p>
          )}
          <button
            type="button"
            className="btn peek__continue"
            onClick={() => {
              if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                toast.show(t('translations.continue.offline'));
                return;
              }
              carryOn(load.passage);
            }}
          >
            {t('translations.peek.continue', { language: name })}
          </button>
        </>
      )}
    </Sheet>
  );
}
