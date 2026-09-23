import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Cover, useToast } from '../components/ui';
import { Art } from '../components/Art';
import { IconSearch } from '../components/icons';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../reader/marks';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { type MessageKey } from '../i18n/messages/en';
import { MarkCard } from '../notes/MarkCard';
import {
  applyFilters,
  booksOf,
  countByKind,
  KIND_FILTERS,
  type BookRow,
  type KindFilter,
  type Marked,
} from '../notes/organise';
import { useMarkLabels } from '../notes/useMarkLabels';
import '../styles/notes.css';

/**
 * Everything you have marked, book by book.
 *
 * The reader shows a book's own marks while you are in it. This is the
 * other half: the thing you wrote down six weeks ago in a book you have
 * since finished. Books are never mixed - the page opens on the books that
 * carry marks, most recently marked first, and each one opens on its own
 * marks. Typing in the search box is the exception, because "where was
 * that line about the weir" is a question asked across books: it turns
 * the page into a flat list of every matching mark, grouped by book, each
 * of which opens the book at exactly the place it came from.
 */

const KIND_LABELS: Record<KindFilter, MessageKey> = {
  // "All", not "Everything": four labels have to share a phone's width, and
  // this is the word the library filter already uses for the same idea.
  all: 'notes.filter.all',
  highlight: 'notes.filter.highlights',
  note: 'notes.filter.notes',
  bookmark: 'notes.filter.bookmarks',
};

export function NotesPage() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const [all, setAll] = useState<Marked[] | null>(null);
  const [kind, setKind] = useState<KindFilter>('all');
  const [colors, setColors] = useState<HighlightColor[]>([]);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api<{ annotations: Marked[] }>('/api/annotations');
      setAll(res.annotations);
    } catch {
      setAll([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Filtering happens here rather than on the server: the whole set is at most
  // a few hundred rows, and typing that filters instantly is the entire point
  // of a page like this.
  const shown = useMemo(
    () => applyFilters(all ?? [], { kind, colors, query }),
    [all, kind, colors, query],
  );
  const books = useMemo(() => booksOf(shown), [shown]);
  const counts = useMemo(() => countByKind(all ?? []), [all]);
  const searching = query.trim().length > 0;

  const remove = async (a: Marked) => {
    try {
      await api(`/api/annotations/${a.id}`, { method: 'DELETE' });
      setAll((list) => (list ?? []).filter((x) => x.id !== a.id));
    } catch {
      toast.show(t('notes.deleteFailed'));
    }
  };

  const pickKind = (k: KindFilter) => {
    setKind(k);
    // A note has no colour: keeping a colour filter on would hide everything.
    if (k === 'note' || k === 'bookmark') setColors([]);
  };

  return (
    <main className="app-main notes-page" id="main-content" tabIndex={-1}>
      <header className="page-head">
        <h1>{t('notes.title')}</h1>
        <p>
          {all === null
            ? t('common.loading')
            : all.length === 0
              ? t('notes.emptyLede')
              : t('notes.counts', counts)}
        </p>
      </header>

      {all !== null && all.length > 0 && (
        <div className="notes-filters">
          <div className="notes-search">
            <IconSearch size={16} />
            <input
              className="input"
              type="search"
              value={query}
              placeholder={t('notes.searchPlaceholder')}
              aria-label={t('notes.searchLabel')}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="segmented notes-filters__kind" role="group" aria-label={t('notes.kind')}>
            {KIND_FILTERS.map((k) => (
              <button key={k} aria-pressed={kind === k} onClick={() => pickKind(k)}>
                {t(KIND_LABELS[k])}
              </button>
            ))}
          </div>
          {(kind === 'all' || kind === 'highlight') && (
            <div className="swatches" role="group" aria-label={t('notes.highlightColour')}>
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch swatch--${c}`}
                  aria-pressed={colors.includes(c)}
                  aria-label={t('notes.onlyColour', { color: c })}
                  onClick={() =>
                    setColors((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]))
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}

      {all !== null && all.length === 0 && (
        <div className="empty-state empty-state--art">
          <Art name="notes-empty" />
          <h2>{t('notes.emptyTitle')}</h2>
          <p>{t('notes.emptyBody')}</p>
          <Link className="btn" to="/">
            {t('notes.openLibrary')}
          </Link>
        </div>
      )}

      {all !== null && all.length > 0 && shown.length === 0 && (
        <p className="empty-state">{t('notes.noMatch')}</p>
      )}

      {!searching && books.length > 0 && (
        <ul className="notes-books" aria-label={t('notes.books.label')}>
          {books.map((row) => (
            <BookCard key={row.bookId} row={row} />
          ))}
        </ul>
      )}

      {searching && shown.length > 0 && (
        <p className="notes-results" role="status">
          {t('notes.results.count', { n: shown.length })}
        </p>
      )}
      {searching &&
        books.map((row) => (
          <section className="notes-group" key={row.bookId} aria-label={row.title}>
            <h2 className="notes-group__head">
              <Link to={`/notes/${row.bookId}`}>
                <bdi>{row.title}</bdi>
              </Link>
              {row.author && (
                <span className="notes-group__author">
                  <bdi>{row.author}</bdi>
                </span>
              )}
            </h2>
            <ul className="marks-list">
              {row.marks.map((a) => (
                <MarkCard
                  key={a.id}
                  mark={a}
                  where={f.percent(a.locator.pct)}
                  date={f.date(a.createdAt)}
                  bookTitle={row.title}
                  onDelete={() => void remove(a)}
                />
              ))}
            </ul>
          </section>
        ))}
    </main>
  );
}

/**
 * One book on the overview: its cover, what has been marked in it, which
 * colours were used and when it was last touched. The whole card is the
 * link, and its text is its name, so nothing here is hidden from a screen
 * reader behind a label.
 */
function BookCard({ row }: { row: BookRow<Marked> }) {
  const t = useT();
  const f = useFormat();
  const labels = useMarkLabels();
  return (
    <li>
      <Link className="notes-bookcard" to={`/notes/${row.bookId}`}>
        <span className="notes-bookcard__coverwrap">
          <Cover
            book={{
              id: row.bookId,
              title: row.title,
              author: row.author,
              hasCover: row.hasCover,
              kind: row.kind,
            }}
            className="notes-bookcard__cover"
          />
        </span>
        <span className="notes-bookcard__body">
          {/* <bdi>, not dir="auto": a Hebrew title keeps its own order but the
              card keeps the interface's alignment, so the grid stays a grid. */}
          <span className="notes-bookcard__title">
            <bdi>{row.title}</bdi>
          </span>
          {row.author && (
            <span className="notes-bookcard__author">
              <bdi>{row.author}</bdi>
            </span>
          )}
          <span className="notes-bookcard__counts">
            <bdi>{labels.counts(row.counts)}</bdi>
          </span>
          <span className="notes-bookcard__meta">
            {row.colors.length > 0 && (
              <span
                className="notes-dots"
                role="img"
                aria-label={t('notes.book.colours', {
                  list: f.list(row.colors.map(labels.colourName)),
                })}
              >
                {row.colors.map((c) => (
                  <i key={c} data-mark-color={c} />
                ))}
              </span>
            )}
            <span>{t('notes.book.lastMarked', { when: f.ago(row.lastMarkedAt) })}</span>
          </span>
        </span>
      </Link>
    </li>
  );
}
