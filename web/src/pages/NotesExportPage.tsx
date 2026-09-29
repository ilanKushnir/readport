import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { type NotesExportResult } from '@readport/shared';
import { api, ApiError } from '../api/client';
import { IconAlert, IconBack, IconDownload, IconSettings } from '../components/icons';
import { useI18n, useT } from '../i18n';
import { type MessageKey } from '../i18n/messages/en';
import { useFormat } from '../i18n/useFormat';
import { buildExportDocument, exportFileName } from '../notes/exportDocument';
import { ExportOptionsSheet } from '../notes/ExportOptionsSheet';
import {
  exportOptionsFromParams,
  exportOptionsToParams,
  preferencesOf,
  readPreferences,
  rememberPreferences,
  selectForExport,
  viewOfOptions,
  type Look,
  type PageSize,
} from '../notes/exportOptions';
import { chapterStarts, viewToParams } from '../notes/organise';
import { pdfFromBase64, savePdf } from '../notes/savePdf';
import { useBookMarks } from '../notes/useBookMarks';
import { useMarkLabels } from '../notes/useMarkLabels';
import { useSession } from '../state/session';
import '../styles/notes.css';

const PAGE_NAMES: Record<PageSize, MessageKey> = {
  a4: 'notes.export.page.a4',
  letter: 'notes.export.page.letter',
  phone: 'notes.export.page.phone',
};
const LOOK_NAMES: Record<Look, MessageKey> = {
  paper: 'notes.export.look.paper',
  night: 'notes.export.look.night',
};

interface Made {
  /** The document these pages were made from, to tell a stale answer from a fresh one. */
  key: string;
  pageCount: number;
  /** The first pages, as picture URLs. */
  pages: string[];
  pdf: Blob;
}

/**
 * `/notes/:bookId/export` - one book's marks as the pages of a PDF.
 *
 * The pages are set by the server (Typst, see server/typst/notes.typ) from
 * a document the app writes in the reader's language, and what is shown
 * here is those very pages - the first few, drawn from the same typesetting
 * as the PDF - with the PDF itself already made, so "Save PDF" hands it
 * over at once: the share sheet on a phone, a download elsewhere. It used
 * to be the browser's print dialog, which on an iPhone cannot print a dark
 * page to its edges, and everywhere else asked the reader to find "Save as
 * PDF" in a list of printers.
 *
 * Everything about the export rides in the URL (see `exportOptions`): a
 * reload, a shared link and the Back button all make the same pages.
 */
export function NotesExportPage() {
  const t = useT();
  const f = useFormat();
  const { tag, dir } = useI18n();
  const labels = useMarkLabels();
  const { user } = useSession();
  const navigate = useNavigate();
  const { bookId = '' } = useParams();
  const [params] = useSearchParams();
  const options = useMemo(() => exportOptionsFromParams(params), [params]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const { detail, marks, state } = useBookMarks(bookId);
  const starts = useMemo(() => chapterStarts(detail?.chapters ?? []), [detail]);
  const chosen = useMemo(() => selectForExport(marks, options), [marks, options]);
  const exportedAt = useMemo(() => new Date(), []);
  // A name the reader chose; a login name would read oddly on a keepsake.
  const reader = user?.displayName?.trim() || null;

  const written = useMemo(() => {
    if (!detail || chosen.length === 0) return null;
    return buildExportDocument({
      book: detail.book,
      bookDir: detail.direction,
      marks: chosen,
      starts,
      options,
      reader,
      now: exportedAt,
      ui: { tag, dir },
      words: {
        t,
        number: f.number,
        percent: f.percent,
        date: f.date,
        sectionTitle: labels.sectionTitle,
        counts: labels.counts,
        exportScope: labels.exportScope,
      },
    });
  }, [detail, chosen, starts, options, reader, exportedAt, tag, dir, t, f, labels]);
  const key = useMemo(() => (written ? JSON.stringify(written) : null), [written]);

  const [made, setMade] = useState<Made | null>(null);
  const [failure, setFailure] = useState<'failed' | 'busy' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const madeRef = useRef<Made | null>(null);
  madeRef.current = made;

  // Make the pages whenever the document changes: the first few to look
  // at, and the PDF to keep, from one typesetting.
  useEffect(() => {
    if (!written || !key) return;
    const ctl = new AbortController();
    setFailure(null);
    api<NotesExportResult>(`/api/books/${bookId}/notes/export`, {
      method: 'POST',
      body: written,
      signal: ctl.signal,
    })
      .then((r) => {
        if (ctl.signal.aborted) return;
        const pages = r.pages.map((svg) =>
          URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })),
        );
        setMade((was) => {
          for (const url of was?.pages ?? []) URL.revokeObjectURL(url);
          return { key, pageCount: r.pageCount, pages, pdf: pdfFromBase64(r.pdf) };
        });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setFailure(e instanceof ApiError && e.status === 503 ? 'busy' : 'failed');
      });
    return () => ctl.abort();
    // `key` stands for the document: the same words make the same pages.
  }, [key, bookId, attempt]);
  useEffect(
    () => () => {
      for (const url of madeRef.current?.pages ?? []) URL.revokeObjectURL(url);
    },
    [],
  );

  // The tab's title names the book.
  useEffect(() => {
    if (!detail) return;
    const before = document.title;
    document.title = t('notes.export.documentTitle', { title: detail.book.title });
    return () => {
      document.title = before;
    };
  }, [detail, t]);

  const ready = made !== null && made.key === key;
  const viewQuery = viewToParams(viewOfOptions(options)).toString();
  const backTo = `/notes/${bookId}${viewQuery ? `?${viewQuery}` : ''}`;
  const title = detail?.book.title ?? '';
  const fileName = exportFileName(title, t);

  const save = () => {
    if (!ready) return;
    void savePdf(made.pdf, fileName, t('notes.export.documentTitle', { title }));
  };
  const open = () => {
    if (!ready) return;
    const url = URL.createObjectURL(made.pdf);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const facts = [
    ready ? t('notes.export.pages', { n: made.pageCount }) : null,
    t(PAGE_NAMES[options.page]),
    t(LOOK_NAMES[options.look]),
  ].filter(Boolean);
  const waiting = !ready && !failure && chosen.length > 0 && state === 'ready';

  return (
    <main className="app-main notes-export" id="main-content" tabIndex={-1}>
      <div className="notes-export__bar">
        <Link className="btn btn--ghost" to={backTo} aria-label={t('notes.export.back')}>
          <IconBack size={17} />
        </Link>
        <div className="notes-export__title">
          <h1>
            <bdi>{title || t('notes.export.heading')}</bdi>
          </h1>
          <p>{facts.join(' · ')}</p>
        </div>
        <div className="notes-export__actions">
          <button
            type="button"
            className="btn btn--secondary"
            disabled={state !== 'ready'}
            onClick={() => setOptionsOpen(true)}
          >
            <IconSettings size={17} /> {t('notes.export.options')}
          </button>
          <button type="button" className="btn" disabled={!ready} onClick={save}>
            <IconDownload size={17} /> {t('notes.export.save')}
          </button>
        </div>
      </div>

      {state === 'error' && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={18} /> {t('notes.bookLoadFailed')}
        </div>
      )}
      {state === 'ready' && chosen.length === 0 && (
        <p className="notes-export__status">{t('notes.export.empty')}</p>
      )}
      {failure && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={18} />
          <span>{t(failure === 'busy' ? 'notes.export.busy' : 'notes.export.failed')}</span>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t('common.retry')}
          </button>
        </div>
      )}

      <section
        className="notes-export__pages"
        aria-label={t('notes.export.heading')}
        aria-busy={waiting}
      >
        {waiting && (
          <p className="notes-export__status" role="status">
            {t('notes.export.preparing')}
          </p>
        )}
        {ready
          ? made.pages.map((url, i) => (
              <figure
                className="export-page"
                data-page={options.page}
                data-look={options.look}
                key={url}
              >
                <img
                  src={url}
                  alt={t('notes.export.pageAlt', { n: i + 1, total: made.pageCount })}
                  decoding="async"
                  loading={i < 2 ? 'eager' : 'lazy'}
                />
              </figure>
            ))
          : (waiting || state === 'loading') &&
            [0, 1].map((i) => (
              <div
                className="export-page export-page--waiting"
                data-page={options.page}
                data-look={options.look}
                key={i}
                aria-hidden="true"
              />
            ))}
        {ready && (
          <div className="notes-export__more">
            {made.pageCount > made.pages.length && (
              <p>{t('notes.export.more', { n: made.pageCount - made.pages.length })}</p>
            )}
            <button type="button" className="btn btn--secondary" onClick={open}>
              {t('notes.export.open')}
            </button>
          </div>
        )}
      </section>

      {optionsOpen && (
        <ExportOptionsSheet
          initial={options}
          marks={marks}
          submitLabel={t('notes.export.apply')}
          onClose={() => setOptionsOpen(false)}
          onSubmit={(chosenOptions) => {
            rememberPreferences(preferencesOf(chosenOptions, readPreferences(navigator.language)));
            setOptionsOpen(false);
            navigate(
              { search: exportOptionsToParams(chosenOptions).toString() },
              { replace: true },
            );
          }}
        />
      )}
    </main>
  );
}
