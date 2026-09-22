import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconAlert, IconBack, IconDownload, IconSettings } from '../components/icons';
import { useT } from '../i18n';
import { ExportDocument } from '../notes/ExportDocument';
import { ExportOptionsSheet } from '../notes/ExportOptionsSheet';
import {
  exportOptionsFromParams,
  exportOptionsToParams,
  preferencesOf,
  rememberPreferences,
  selectForExport,
  viewOfOptions,
} from '../notes/exportOptions';
import { chapterStarts, organise, viewToParams } from '../notes/organise';
import { useBookMarks } from '../notes/useBookMarks';
import '../styles/notes.css';

/**
 * `/notes/:bookId/export` - one book's marks as pages.
 *
 * On screen it is a preview of what will print, in the look and at the
 * page size that were chosen, with the one button that matters, a way back,
 * and "Options…" to change the choices without leaving. In print
 * (`@media print` in notes.css) every piece of app chrome disappears and
 * only the pages remain. Arriving with `?print=1` - which is what the
 * sheet's "Export" does - opens the print sheet by itself once the cover
 * and the reading face are on the page, so the first page never comes out
 * with a blank cover or a fallback serif. Everything else about the export
 * rides in the same URL (see `exportOptions`): a reload, a shared link and
 * the Back button all show the same pages.
 */
export function NotesExportPage() {
  const t = useT();
  const navigate = useNavigate();
  const { bookId = '' } = useParams();
  const [params] = useSearchParams();
  const options = useMemo(() => exportOptionsFromParams(params), [params]);
  const autoPrint = params.get('print') === '1';
  const [optionsOpen, setOptionsOpen] = useState(false);
  const { detail, marks, state } = useBookMarks(bookId);

  const starts = useMemo(() => chapterStarts(detail?.chapters ?? []), [detail]);
  const sections = useMemo(
    () => organise(selectForExport(marks, options), options.sort, starts),
    [marks, options, starts],
  );
  const [coverReady, setCoverReady] = useState(false);
  const onCoverReady = useCallback(() => setCoverReady(true), []);
  const exportedAt = useMemo(() => new Date().toISOString(), []);
  const optionsQuery = exportOptionsToParams(options).toString();
  const viewQuery = viewToParams(viewOfOptions(options)).toString();
  const backTo = `/notes/${bookId}${viewQuery ? `?${viewQuery}` : ''}`;

  // While this page is up, the print stylesheet may strip the shell away,
  // and the look, page and text size are read from the root by notes.css.
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.setAttribute('data-print-view', '');
    html.setAttribute('data-print-look', options.look);
    html.setAttribute('data-print-page', options.page);
    html.setAttribute('data-print-text', options.text);
    return () => {
      for (const name of [
        'data-print-view',
        'data-print-look',
        'data-print-page',
        'data-print-text',
      ])
        html.removeAttribute(name);
    };
  }, [options.look, options.page, options.text]);

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

  // Print once per address that asks for it, then drop the flag: coming
  // back to this address, or reloading it, must not print again.
  const search = params.toString();
  const printedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!autoPrint || state !== 'ready' || !coverReady || printedFor.current === search) return;
    printedFor.current = search;
    void readyToPrint(sample).then(() => {
      if (!mounted.current) return;
      window.print();
      navigate({ search: optionsQuery }, { replace: true });
    });
  }, [autoPrint, state, coverReady, sample, navigate, optionsQuery, search]);

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
          className="btn btn--secondary"
          disabled={state !== 'ready'}
          onClick={() => setOptionsOpen(true)}
        >
          <IconSettings size={17} /> {t('notes.export.options')}
        </button>
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
          options={options}
          exportedAt={exportedAt}
          onCoverReady={onCoverReady}
        />
      )}

      {optionsOpen && (
        <ExportOptionsSheet
          initial={options}
          marks={marks}
          submitLabel={t('notes.export.apply')}
          onClose={() => setOptionsOpen(false)}
          onSubmit={(chosen) => {
            rememberPreferences(preferencesOf(chosen));
            setOptionsOpen(false);
            navigate({ search: exportOptionsToParams(chosen).toString() }, { replace: true });
          }}
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
