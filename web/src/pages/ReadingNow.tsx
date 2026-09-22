import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type BookSummary } from '@readport/shared';
import { Cover, Sheet } from '../components/ui';
import { IconBookOpen, IconHeadphones } from '../components/icons';
import { resetBookProgress } from '../progress/engine';
import { useT, type TranslateFn } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import './reading-now.css';

/** The settled half of a pair, or nothing. A `candidate` is only a guess. */
function settledPair(book: BookSummary) {
  return book.pair && book.pair.status !== 'candidate' ? book.pair : null;
}

/**
 * Where the reader stands in the edition this row is NOT showing, in the
 * words the book page already uses for the edition it is.
 *
 * Null when they have never opened it: "Audiobook · 0%" would be a claim
 * about a book nobody has touched, and the row already offers to open it.
 */
function otherEditionState(
  book: BookSummary,
  t: TranslateFn,
  percent: (n: number) => string,
): string | null {
  const pair = settledPair(book);
  const state = pair?.otherProgress;
  if (!pair || !state) return null;
  const kind = pair.otherKind === 'ebook' ? t('common.ebook') : t('common.audiobook');
  const where = state.finished
    ? t('library.card.finished')
    : t('library.book.progress', { pct: percent(state.pct), kind: pair.otherKind });
  return `${kind} · ${where}`;
}

/**
 * The compact list behind the Reading Now shelf: one row per TITLE in
 * progress, with the way back in, the way across and the way out.
 *
 * A title owned in both formats is one row, not two. The row stands for the
 * edition this reader moved in most recently - the server chooses it, because
 * only the server knows both positions - and names the other one rather than
 * swallowing it: progress is stored per edition, so the audiobook really is
 * somewhere else in the book, and saying so is the difference between
 * collapsing a duplicate and losing a position.
 *
 * The way out is honest about what it is. There is no "hide" here - progress
 * is the only thing that puts a book on this list, so leaving it means
 * erasing that progress, and the button says so before the dialog does. It
 * erases THIS edition's progress, which is the granularity the store has; the
 * dialog names the edition and says the other one keeps its own.
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
  const selectedOther = selected && otherEditionState(selected, t, f.percent);
  return (
    <>
      <ul className="reading-now" aria-label={t('library.readingNow.listLabel')}>
        {books.map((book) => {
          const isEbook = book.kind === 'ebook';
          const pct = book.progress?.pct ?? 0;
          const left = !isEbook && book.durationMs ? f.duration(book.durationMs * (1 - pct)) : null;
          const pair = settledPair(book);
          const other = otherEditionState(book, t, f.percent);
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
                {/* The edition this row is not showing. Without it a reader
                    who finished the ebook and is half way through the
                    audiobook would see one row and no sign of the other
                    position - which is the whole risk of collapsing. */}
                {other && (
                  <p className="reading-now__meta">
                    {pair!.otherKind === 'ebook' ? (
                      <IconBookOpen size={13} />
                    ) : (
                      <IconHeadphones size={13} />
                    )}
                    <span>{other}</span>
                  </p>
                )}
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
                  {/* The same crossing the Continue band and the book page
                      offer, in the same words. */}
                  {pair && (
                    <Link
                      className="btn btn--ghost"
                      to={`/book/${book.id}?switch=1`}
                      title={
                        pair.switchable
                          ? t('library.hero.switchSameSpot')
                          : t('library.hero.otherEdition')
                      }
                    >
                      {t('library.hero.instead', { kind: book.kind })}
                    </Link>
                  )}
                  <button
                    className="btn btn--ghost"
                    /* A row standing for a linked pair is one title and two
                       editions, so the label has to name the one it resets.
                       An unpaired row does not: the shorter word is better
                       when there is nothing to disambiguate. */
                    onClick={() => {
                      setSelected(book);
                      setFailed(false);
                    }}
                  >
                    {book.pair
                      ? t('library.readingNow.resetEdition', {
                          kind: isEbook ? 'ebook' : 'audio',
                        })
                      : t('library.readingNow.resetButton')}
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
            {settledPair(selected)
              ? // What "keeps its own progress" actually means, in numbers,
                // when there is a number to give: a reader about to erase one
                // position should be able to see the one that survives.
                `${t('library.readingNow.pairedKeepsProgress')}${selectedOther ? ` (${selectedOther})` : ''} `
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
