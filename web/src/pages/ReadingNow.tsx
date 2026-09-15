import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type BookSummary } from '@readport/shared';
import { Cover, Sheet } from '../components/ui';
import { IconBookOpen, IconHeadphones } from '../components/icons';
import { resetBookProgress } from '../progress/engine';
import { ago, formatDuration, formatPct } from '../lib/format';
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
  const [selected, setSelected] = useState<BookSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <ul className="reading-now" aria-label="Books you are reading or listening to">
        {books.map((book) => {
          const isEbook = book.kind === 'ebook';
          const pct = book.progress?.pct ?? 0;
          const edition = isEbook ? 'Ebook' : 'Audiobook';
          const left =
            !isEbook && book.durationMs ? formatDuration(book.durationMs * (1 - pct)) : null;
          return (
            <li className="reading-now__row" key={book.id}>
              <Link to={`/book/${book.id}`} aria-label={`${book.title}, ${edition} details`}>
                <Cover book={book} className="reading-now__cover" />
              </Link>
              <div className="reading-now__body">
                <h3>{book.title}</h3>
                {book.author && <p className="reading-now__author">{book.author}</p>}
                <p className="reading-now__meta">
                  {isEbook ? <IconBookOpen size={13} /> : <IconHeadphones size={13} />}
                  <span>
                    {edition} · {formatPct(pct)}
                    {left ? ` · ${left} left` : ''}
                  </span>
                  {book.progress?.updatedAt && (
                    <span className="reading-now__when">{ago(book.progress.updatedAt)}</span>
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
                    {isEbook ? 'Resume reading' : 'Resume listening'}
                  </Link>
                  <button
                    className="btn btn--ghost"
                    onClick={() => {
                      setSelected(book);
                      setError(null);
                    }}
                  >
                    Reset progress…
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {selected && (
        <Sheet
          title="Reset reading progress?"
          onClose={() => {
            if (!busy) setSelected(null);
          }}
        >
          <p>
            Reset your progress, checkpoints and reading history for “{selected.title}” (
            {selected.kind === 'ebook' ? 'ebook' : 'audiobook'})? It leaves Reading Now and opens
            from the beginning next time.
          </p>
          <p>
            {selected.pair && selected.pair.status !== 'candidate'
              ? 'The paired edition keeps its own progress. '
              : ''}
            The book, its files, alignment, bookmarks, highlights, notes, shelves, reading list and
            downloads are kept. Nobody else’s progress changes.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="reading-now__actions">
            <button
              className="btn btn--secondary"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              Cancel
            </button>
            <button
              className="btn btn--danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await resetBookProgress(selected.id);
                  onReset(selected.id);
                  setSelected(null);
                } catch {
                  setError(
                    'The reset could not be confirmed, so the book stays here. Trying again is safe.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Resetting…' : 'Reset reading progress'}
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
