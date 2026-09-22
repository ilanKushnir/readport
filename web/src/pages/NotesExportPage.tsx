import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconAlert, IconBack, IconDownload } from '../components/icons';
import { useT } from '../i18n';
import { ExportDocument } from '../notes/ExportDocument';
import {
  applyFilters,
  chapterStarts,
  organise,
  viewFromParams,
  viewToParams,
} from '../notes/organise';
import { useBookMarks } from '../notes/useBookMarks';
import '../styles/notes.css';

/**
 * `/notes/:bookId/export` - one book's marks as pages.
 *
 * On screen it is a preview of what will print, with the one button that
 * matters and a way back. In print (`@media print` in notes.css) every
 * piece of app chrome disappears and only the pages remain. Arriving with
 * `?print=1` - which is what "Export as PDF…" does - opens the print sheet
 * by itself once the cover and the reading face are on the page, so the
 * first page never comes out with a blank cover or a fallback serif. The
 * filters and sort ride in on the same URL the per-book view keeps them
 * in: exporting "just the plum ones" exports just the plum ones.
 */
export function NotesExportPage() {
  const t = useT();
  const navigate = useNavigate();
  const { bookId = '' } = useParams();
  const [params] = useSearchParams();
  const view = useMemo(() => viewFromParams(params), [params]);
  const autoPrint = params.get('print') === '1';
  const { detail, marks, state } = useBookMarks(bookId);

  const starts = useMemo(() => chapterStarts(detail?.chapters ?? []), [detail]);
  const sections = useMemo(
    () => organise(applyFilters(marks, view), view.sort, starts),
    [marks, view, starts],
  );
  const [coverReady, setCoverReady] = useState(false);
  const onCoverReady = useCallback(() => setCoverReady(true), []);
  const exportedAt = useMemo(() => new Date().toISOString(), []);
  const viewQuery = viewToParams(view).toString();
  const backTo = `/notes/${bookId}${viewQuery ? `?${viewQuery}` : ''}`;

  // While this page is up, the print stylesheet may strip the shell away.
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-print-view', '');
    return () => document.documentElement.removeAttribute('data-print-view');
  }, []);

  // The document's title is what the browser names the PDF.
  useEffect(() => {
    if (!detail) return;
    const before = document.title;
    document.title = t('notes.export.documentTitle', { title: detail.book.title });
    return () => {
      document.title = before;
    };
  }, [detail, t]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** The passages, for the font loader: Literata comes in per-script pieces. */
  const sample = useMemo(
    () =>
      marks
        .map((a) => a.selectedText ?? '')
        .join(' ')
        .slice(0, 400),
    [marks],
  );

  const printed = useRef(false);
  useEffect(() => {
    if (!autoPrint || printed.current || state !== 'ready' || !coverReady) return;
    printed.current = true;
    void readyToPrint(sample).then(() => {
      if (!mounted.current) return;
      window.print();
      // Drop the flag: coming back to this address must not print again.
      navigate({ search: viewQuery }, { replace: true });
    });
  }, [autoPrint, state, coverReady, sample, navigate, viewQuery]);

  return (
    <main
      className="app-main notes-export"
      id="main-content"
      tabIndex={-1}
      aria-busy={state === 'loading'}
    >
      <div className="notes-export__toolbar">
        <Link className="btn btn--ghost" to={backTo}>
          <IconBack size={17} /> {t('notes.export.back')}
        </Link>
        <p className="notes-export__hint">{t('notes.export.hint')}</p>
        <button
          type="button"
          className="btn"
          disabled={state !== 'ready'}
          onClick={() => void readyToPrint(sample).then(() => window.print())}
        >
          <IconDownload size={17} /> {t('notes.export.print')}
        </button>
      </div>

      {state === 'error' && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={18} /> {t('notes.bookLoadFailed')}
        </div>
      )}
      {state === 'loading' && <p className="hint">{t('common.loading')}</p>}
      {detail && (
        <ExportDocument
          book={detail.book}
          sections={sections}
          starts={starts}
          view={view}
          exportedAt={exportedAt}
          onCoverReady={onCoverReady}
        />
      )}
    </main>
  );
}

/**
 * Literata is loaded lazily and in per-script pieces (Latin, Cyrillic,
 * Greek…), so the piece a passage needs may still be on its way when the
 * page is ready. Ask for the faces the passages use and wait for them -
 * but not forever: a font that will not arrive is not a reason never to
 * print.
 */
async function readyToPrint(sample: string): Promise<void> {
  const fonts = document.fonts;
  if (!fonts) return;
  const text = sample || ' ';
  const settle = Promise.all([
    fonts.load("400 1em 'Literata'", text),
    fonts.load("italic 400 1em 'Literata'", text),
    fonts.ready,
  ]);
  const patience = new Promise<void>((resolve) => setTimeout(resolve, 3000));
  await Promise.race([settle, patience]).catch(() => undefined);
}
