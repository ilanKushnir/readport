import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type BookSummary } from '@readport/shared';
import { Cover, Sheet } from '../components/ui';
import { resetBookProgress } from '../progress/engine';
import { formatPct } from '../lib/format';
import './reading-now.css';

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
      <ul className="reading-now" aria-label="Books you are reading">
        {books.map((book) => (
          <li className="reading-now__row" key={book.id}>
            <Link to={`/book/${book.id}`} aria-label={`${book.title} details`}>
              <Cover book={book} className="reading-now__cover" />
            </Link>
            <div className="reading-now__body">
              <h3>{book.title}</h3>
              <p>{book.author}</p>
              <p>
                {book.kind === 'ebook' ? 'Ebook' : 'Audiobook'} ·{' '}
                {formatPct(book.progress?.pct ?? 0)}
              </p>
              <div className="reading-now__actions">
                <Link
                  className="btn btn--secondary"
                  to={book.kind === 'ebook' ? `/read/${book.id}` : `/listen/${book.id}`}
                >
                  Resume {book.kind === 'ebook' ? 'reading' : 'listening'}
                </Link>
                <button
                  className="btn btn--ghost"
                  onClick={() => {
                    setSelected(book);
                    setError(null);
                  }}
                >
                  Remove from Reading Now
                </button>
              </div>
            </div>
          </li>
        ))}
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
            {selected.kind === 'ebook' ? 'ebook' : 'audiobook'})?
          </p>
          <p>
            The paired edition stays unchanged. Books, files, alignment, bookmarks, highlights,
            notes, shelves, reading list and downloads are kept. Nobody else’s progress changes.
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
              className="btn"
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
                    'Could not confirm the reset. The book stays here. Check your connection and retry.',
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
