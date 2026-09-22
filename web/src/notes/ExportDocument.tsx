import { useEffect, useState } from 'react';
import { type Annotation, type BookSummary } from '@readport/shared';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { colorOf } from '../reader/marks';
import { countByKind, type ChapterStart, type MarksView, type Section } from './organise';
import { useMarkLabels } from './useMarkLabels';

/**
 * The printed page.
 *
 * A title page - the cover, large and centred; the title in the reading
 * face; the author; what the export holds and when it was made - and then
 * the marks under their running heads, each with a thin bar in its colour,
 * the passage in Literata, the reader's note in the interface face, and a
 * quiet line saying where in the book it came from.
 *
 * It is rendered by the browser's own print engine, not a PDF library: that
 * is what gets the bundled Literata, a Hebrew or Arabic passage inside an
 * English interface, and a page that mixes both, right - and "Save as PDF"
 * is native everywhere, the iOS share sheet included. The passage and the
 * note set their own direction (`dir="auto"`); the running heads and the
 * labels follow the interface.
 */
export function ExportDocument({
  book,
  sections,
  starts,
  view,
  exportedAt,
  onCoverReady,
}: {
  book: BookSummary;
  sections: Section<Annotation>[];
  starts: readonly ChapterStart[];
  view: MarksView;
  /** ISO time the export was made, printed on the title page. */
  exportedAt: string;
  /** Called once the cover is on the page (or has failed, or there is none): safe to print. */
  onCoverReady: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const labels = useMarkLabels();
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = book.hasCover && !coverFailed;
  const marks = sections.flatMap((s) => s.marks);
  const scope = labels.scope(view);
  const from = t('notes.export.from', { app: t('common.appName') });

  // Nothing to wait for when there is no cover to load.
  useEffect(() => {
    if (!book.hasCover) onCoverReady();
  }, [book.hasCover, onCoverReady]);

  return (
    <article className="print-doc" aria-label={t('notes.export.heading')}>
      <header className="print-sheet print-doc__title">
        <p className="print-doc__eyebrow">{t('notes.export.heading')}</p>
        {showCover ? (
          <span className="print-doc__coverwrap">
            <img
              className="print-doc__cover"
              src={`/api/books/${book.id}/cover`}
              alt=""
              decoding="sync"
              onLoad={onCoverReady}
              onError={() => {
                setCoverFailed(true);
                onCoverReady();
              }}
              ref={(el) => {
                // Already in the cache: `load` fired before this listener existed.
                if (el?.complete && el.naturalWidth > 0) onCoverReady();
              }}
            />
          </span>
        ) : (
          <span className="print-doc__coverwrap print-doc__coverwrap--plain" aria-hidden="true">
            <span className="print-doc__nocover">
              <bdi>{book.title}</bdi>
            </span>
          </span>
        )}
        <h1 className="print-doc__book">
          <bdi>{book.title}</bdi>
        </h1>
        {book.author && (
          <p className="print-doc__author">
            <bdi>{book.author}</bdi>
          </p>
        )}
        <span className="print-doc__rule" aria-hidden="true" />
        <p className="print-doc__counts">
          <bdi>{labels.counts(countByKind(marks))}</bdi>
        </p>
        {scope && <p className="print-doc__scope">{scope}</p>}
        <p className="print-doc__stamp">
          {from} · {f.date(exportedAt)}
        </p>
      </header>

      <div className="print-sheet print-doc__pages">
        {sections.map((s) => (
          <section className="print-doc__section" key={s.key}>
            {s.head && (
              <h2 className="print-doc__head">
                <bdi>{labels.sectionTitle(s.head)}</bdi>
                <span className="print-doc__headcount">{f.number(s.marks.length)}</span>
              </h2>
            )}
            <ul className="print-doc__list">
              {s.marks.map((a) => (
                <li
                  key={a.id}
                  className={`print-mark print-mark--${a.kind}`}
                  data-mark-color={a.kind === 'highlight' ? colorOf(a) : undefined}
                >
                  {a.selectedText && (
                    <blockquote className="print-mark__quote" dir="auto">
                      {a.selectedText}
                    </blockquote>
                  )}
                  {a.note && (
                    <p className="print-mark__note" dir="auto">
                      {a.note}
                    </p>
                  )}
                  {!a.selectedText && !a.note && (
                    <p className="print-mark__plain">
                      {a.kind === 'bookmark' ? t('notes.bookmarkedPage') : t('notes.markedPassage')}
                    </p>
                  )}
                  <p className="print-mark__where">
                    <bdi>{labels.where(a, starts)}</bdi>
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {marks.length === 0 && <p className="print-doc__empty">{t('notes.export.empty')}</p>}
        <footer className="print-doc__foot">
          <bdi>{book.title}</bdi> · {from}
        </footer>
      </div>
    </article>
  );
}
