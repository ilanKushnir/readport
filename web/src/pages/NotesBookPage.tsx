import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { type Annotation } from '@readport/shared';
import { api } from '../api/client';
import { Cover, EmptyState, useToast } from '../components/ui';
import { IconAlert, IconBack, IconDownload } from '../components/icons';
import { HIGHLIGHT_COLORS } from '../reader/marks';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { type MessageKey } from '../i18n/messages/en';
import {
  exportHref,
  optionsForView,
  preferencesOf,
  readPreferences,
  rememberPreferences,
} from '../notes/exportOptions';
import { ExportOptionsSheet } from '../notes/ExportOptionsSheet';
import { MarkCard } from '../notes/MarkCard';
import {
  applyFilters,
  chapterStarts,
  countByKind,
  KIND_FILTERS,
  organise,
  SORT_ORDERS,
  viewFromParams,
  viewToParams,
  type KindFilter,
  type MarksView,
  type SortOrder,
} from '../notes/organise';
import { useBookMarks } from '../notes/useBookMarks';
import { useMarkLabels } from '../notes/useMarkLabels';
import '../styles/notes.css';

/**
 * `/notes/:bookId` - one book's marks, and nothing from any other.
 *
 * Laid out the way the book is: by default the marks run in reading order
 * under the chapters they were made in, so the page reads like the book's
 * own margin. Newest-first is for finding what you wrote last night;
 * by-colour is for a reader whose colours mean something - one for
 * quotations, one for arguments to come back to. The filters and the sort
 * live in the URL, so Back returns to the same view, and "Export as PDF…"
 * opens a sheet prefilled from that view - what is on screen is what the
 * pages start from, and the reader adjusts from there.
 */

const KIND_LABELS: Record<KindFilter, MessageKey> = {
  all: 'notes.filter.all',
  highlight: 'notes.filter.highlights',
  note: 'notes.filter.notes',
  bookmark: 'notes.filter.bookmarks',
};

const SORT_LABELS: Record<SortOrder, MessageKey> = {
  position: 'notes.sort.position',
  newest: 'notes.sort.newest',
  color: 'notes.sort.color',
};

export function NotesBookPage() {
  const t = useT();
  const f = useFormat();
  const labels = useMarkLabels();
  const toast = useToast();
  const navigate = useNavigate();
  const { bookId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const view = useMemo(() => viewFromParams(params), [params]);
  const [exportOpen, setExportOpen] = useState(false);
  const { detail, marks, setMarks, state } = useBookMarks(bookId);

  const starts = useMemo(() => chapterStarts(detail?.chapters ?? []), [detail]);
  const shown = useMemo(() => applyFilters(marks, view), [marks, view]);
  const sections = useMemo(() => organise(shown, view.sort, starts), [shown, view.sort, starts]);
  const counts = useMemo(() => countByKind(marks), [marks]);

  const setView = useCallback(
    (patch: Partial<MarksView>) =>
      setParams(viewToParams({ ...view, ...patch }), { replace: true }),
    [view, setParams],
  );
  const pickKind = (kind: KindFilter) =>
    // A note has no colour: keeping a colour filter on would hide everything.
    setView({ kind, colors: kind === 'all' || kind === 'highlight' ? view.colors : [] });
  const toggleColor = (c: (typeof HIGHLIGHT_COLORS)[number]) =>
    setView({
      colors: view.colors.includes(c) ? view.colors.filter((x) => x !== c) : [...view.colors, c],
    });

  const remove = async (a: Annotation) => {
    try {
      await api(`/api/annotations/${a.id}`, { method: 'DELETE' });
      setMarks((list) => list.filter((x) => x.id !== a.id));
    } catch {
      toast.show(t('notes.deleteFailed'));
    }
  };

  const back = (
    <Link className="notes-backlink" to="/notes">
      <IconBack size={16} /> {t('notes.allBooks')}
    </Link>
  );

  if (state === 'error') {
    return (
      <main className="app-main notes-book" id="main-content" tabIndex={-1}>
        {back}
        <div className="banner banner--error" role="alert">
          <IconAlert size={18} /> {t('notes.bookLoadFailed')}
        </div>
      </main>
    );
  }
  if (!detail) {
    return (
      <main className="app-main notes-book" id="main-content" tabIndex={-1} aria-busy="true">
        {back}
        <div className="notes-hero">
          <div className="skeleton notes-hero__coverwrap" />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 30, maxWidth: 320 }} />
            <div className="skeleton" style={{ height: 16, maxWidth: 180, marginTop: 12 }} />
          </div>
        </div>
      </main>
    );
  }

  const { book } = detail;
  const openHref = book.kind === 'ebook' ? `/read/${book.id}` : `/listen/${book.id}`;

  return (
    <main className="app-main notes-book" id="main-content" tabIndex={-1}>
      {back}
      <header className="notes-hero">
        <span className="notes-hero__coverwrap">
          <Cover book={book} className="notes-hero__cover" />
        </span>
        <div className="notes-hero__body">
          <h1>
            <bdi>{book.title}</bdi>
          </h1>
          {book.author && (
            <p className="notes-hero__author">
              <bdi>{book.author}</bdi>
            </p>
          )}
          {marks.length > 0 && (
            <p className="notes-hero__counts">
              <bdi>{labels.counts(counts)}</bdi>
            </p>
          )}
          <div className="notes-hero__actions">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setExportOpen(true)}
              disabled={marks.length === 0}
            >
              <IconDownload size={17} /> {t('notes.exportPdf')}
            </button>
            <Link className="btn btn--ghost" to={`/book/${book.id}`}>
              {t('notes.bookPage')}
            </Link>
          </div>
        </div>
      </header>

      {marks.length === 0 ? (
        <EmptyState
          art="notes-empty"
          title={t('notes.bookEmptyTitle')}
          action={
            <Link className="btn" to={openHref}>
              {t('notes.readBook', { kind: book.kind })}
            </Link>
          }
        >
          {t('notes.bookEmptyBody')}
        </EmptyState>
      ) : (
        <>
          <div className="notes-controls">
            <div
              className="segmented notes-controls__kind"
              role="group"
              aria-label={t('notes.kind')}
            >
              {KIND_FILTERS.map((k) => (
                <button key={k} aria-pressed={view.kind === k} onClick={() => pickKind(k)}>
                  {t(KIND_LABELS[k])}
                </button>
              ))}
            </div>
            {(view.kind === 'all' || view.kind === 'highlight') && (
              <div className="swatches" role="group" aria-label={t('notes.highlightColour')}>
                {HIGHLIGHT_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`swatch swatch--${c}`}
                    aria-pressed={view.colors.includes(c)}
                    aria-label={t('notes.onlyColour', { color: c })}
                    onClick={() => toggleColor(c)}
                  />
                ))}
              </div>
            )}
            <div
              className="segmented segmented--inline notes-controls__sort"
              role="group"
              aria-label={t('notes.sort')}
            >
              {SORT_ORDERS.map((s) => (
                <button key={s} aria-pressed={view.sort === s} onClick={() => setView({ sort: s })}>
                  {t(SORT_LABELS[s])}
                </button>
              ))}
            </div>
          </div>

          {shown.length === 0 && <p className="empty-state">{t('notes.noMatch')}</p>}

          {sections.map((s) => {
            const title = labels.sectionTitle(s.head);
            return (
              <section
                className="marks-section"
                key={s.key}
                aria-label={title ?? t('notes.marksLabel')}
              >
                {title && (
                  <h2 className="marks-section__head">
                    <bdi>{title}</bdi>
                    <span className="marks-section__count">{f.number(s.marks.length)}</span>
                  </h2>
                )}
                <ul className="marks-list">
                  {s.marks.map((a) => (
                    <MarkCard
                      key={a.id}
                      mark={a}
                      where={labels.where(a, starts)}
                      date={f.date(a.createdAt)}
                      onDelete={() => void remove(a)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}

      {exportOpen && (
        <ExportOptionsSheet
          initial={optionsForView(view, readPreferences(navigator.language))}
          marks={marks}
          submitLabel={t('notes.export.go')}
          onClose={() => setExportOpen(false)}
          onSubmit={(options) => {
            rememberPreferences(preferencesOf(options));
            navigate(exportHref(bookId, options, true));
          }}
        />
      )}
    </main>
  );
}
