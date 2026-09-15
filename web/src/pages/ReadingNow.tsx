import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type BookSummary } from '@readport/shared';
import { Cover, Sheet } from '../components/ui';
import { IconBookOpen, IconHeadphones } from '../components/icons';
import { resetBookProgress } from '../progress/engine';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import './reading-now.css';

/**
 * The compact list behind the Reading Now shelf: one row per edition in
 * progress, with the way back in and the way out.
 *
 * The way out is honest about what it is. There is no "hide" here - progress
 * is the only thing that puts a book on this list, so leaving it means
 * erasing that progress, and the button says so before the dialog does.
 */
export function ReadingNow({
  books,
  onReset,
}: {
  books: BookSummary[];
  onReset: (id: string) => void;
}) {
  const t = useT();
  const f = useFormat();
  const [selected, setSelected] = useState<BookSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <ul className="reading-now" aria-label={t('library.readingNow.listLabel')}>
        {books.map((book) => {
          const isEbook = book.kind === 'ebook';
          const pct = book.progress?.pct ?? 0;
          const left = !isEbook && book.durationMs ? f.duration(book.durationMs * (1 - pct)) : null;
          return (
            <li className="reading-now__row" key={book.id}>
              <Link
                to={`/book/${book.id}`}
                aria-label={t('library.readingNow.details', { title: book.title, kind: book.kind })}
              >
                <Cover book={book} className="reading-now__cover" />
              </Link>
              <div className="reading-now__body">
                <h3>{book.title}</h3>
                {book.author && <p className="reading-now__author">{book.author}</p>}
                <p className="reading-now__meta">
                  {isEbook ? <IconBookOpen size={13} /> : <IconHeadphones size={13} />}
                  <span>
                    {isEbook ? t('common.ebook') : t('common.audiobook')} · {f.percent(pct)}
                    {left ? ` · ${t('format.left', { duration: left })}` : ''}
                  </span>
                  {book.progress?.updatedAt && (
                    <span className="reading-now__when">{f.ago(book.progress.updatedAt)}</span>
                  )}
                </p>
                <span className="progressbar" aria-hidden="true">
                  <span style={{ width: `${pct * 100}%` }} />
                </span>
                <div className="reading-now__actions">
                  <Link
                    className="btn btn--secondary"
                    to={isEbook ? `/read/${book.id}` : `/listen/${book.id}`}
                  >
                    {t('library.hero.resume', { kind: book.kind })}
                  </Link>
                  <button
                    className="btn btn--ghost"
                    onClick={() => {
                      setSelected(book);
                      setFailed(false);
                    }}
                  >
                    {t('library.readingNow.resetButton')}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {selected && (
        <Sheet
          title={t('library.readingNow.resetTitle')}
          onClose={() => {
            if (!busy) setSelected(null);
          }}
        >
          <p>{t('library.readingNow.resetBody', { title: selected.title, kind: selected.kind })}</p>
          <p>
            {selected.pair && selected.pair.status !== 'candidate'
              ? `${t('library.readingNow.pairedKeepsProgress')} `
              : ''}
            {t('library.readingNow.resetKeeps')}
          </p>
          {failed && <p role="alert">{t('library.readingNow.resetFailed')}</p>}
          <div className="reading-now__actions">
            <button
              className="btn btn--secondary"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              {t('common.cancel')}
            </button>
            <button
              className="btn btn--danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setFailed(false);
                try {
                  await resetBookProgress(selected.id);
                  onReset(selected.id);
                  setSelected(null);
                } catch {
                  setFailed(true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? t('library.readingNow.resetting') : t('library.readingNow.resetConfirm')}
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
