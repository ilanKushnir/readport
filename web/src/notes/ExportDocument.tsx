import { useEffect, useState } from 'react';
import { type Annotation, type BookSummary } from '@readport/shared';
import { coverSrc } from '../lib/cover';
import { IconBookmark, ReadPortMark } from '../components/icons';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { COLOR_LABELS, HIGHLIGHT_COLORS, colorOf } from '../reader/marks';
import { type ExportOptions } from './exportOptions';
import { countByKind, type ChapterStart, type Section } from './organise';
import { useMarkLabels } from './useMarkLabels';

/**
 * The printed pages.
 *
 * A title page - the mark and the name small at the top, the cover with a
 * soft shadow (or a tinted card carrying the title when the book has none),
 * the title in the reading face, the author, a row of figures saying what
 * the export holds, and the five highlight colours with their names so the
 * bars on the pages after it can be read - and then the marks under their
 * running heads: each highlight a passage in Literata with its colour as a
 * bar down the start edge and the reader's note beneath in the interface
 * face, each bookmark a marker with its place, and under everything a
 * quiet line saying where in the book it came from and when.
 *
 * It is rendered by the browser's own print engine, not a PDF library: that
 * is what gets the bundled Literata, a Hebrew or Arabic passage inside an
 * English interface, and a page that mixes both, right - and "Save as PDF"
 * is native everywhere, the iOS share sheet included. The passage and the
 * note set their own direction (`dir="auto"`); the running heads and the
 * labels follow the interface. The look, the page and the text size are
 * attributes on <html> (set by the page around this) that notes.css reads.
 */
export function ExportDocument({
  book,
  sections,
  starts,
  options,
  exportedAt,
  onCoverReady,
}: {
  book: BookSummary;
  sections: Section<Annotation>[];
  starts: readonly ChapterStart[];
  options: ExportOptions;
  /** ISO time the export was made, printed at the foot of the title page. */
  exportedAt: string;
  /** Called once the cover is on the page (or has failed, or there is none): safe to print. */
  onCoverReady: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const labels = useMarkLabels();
  const [coverFailed, setCoverFailed] = useState(false);
  const wantCover = options.cover && book.hasCover;
  const showCover = wantCover && !coverFailed;
  const marks = sections.flatMap((s) => s.marks);
  const counts = countByKind(marks);
  const scope = labels.exportScope(options);
  const app = t('common.appName');
  const from = t('notes.export.from', { app });

  // Nothing to wait for when no cover is going on the page.
  useEffect(() => {
    if (!wantCover) onCoverReady();
  }, [wantCover, onCoverReady]);

  const figures = (
    [
      ['highlight', 'notes.export.figure.highlights'],
      ['note', 'notes.export.figure.notes'],
      ['bookmark', 'notes.export.figure.bookmarks'],
    ] as const
  ).filter(([kind]) => counts[kind] > 0);

  return (
    <article className="print-doc" aria-label={t('notes.export.heading')}>
      <header className="print-sheet print-doc__title">
        <div className="print-doc__masthead">
          <p className="print-doc__brand">
            <ReadPortMark size={17} />
            <span>{app}</span>
          </p>
          <p className="print-doc__eyebrow">{t('notes.export.heading')}</p>
        </div>

        <div className="print-doc__titleblock">
          {showCover ? (
            <span className="print-doc__coverwrap">
              <img
                className="print-doc__cover"
                src={coverSrc(book)}
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
            options.cover && (
              <span className="print-doc__coverwrap print-doc__coverwrap--plain" aria-hidden="true">
                <span className="print-doc__nocover">
                  <bdi>{book.title}</bdi>
                </span>
              </span>
            )
          )}
          <h1 className="print-doc__book">
            <bdi>{book.title}</bdi>
          </h1>
          {book.author && (
            <p className="print-doc__author">
              <bdi>{book.author}</bdi>
            </p>
          )}
          {figures.length > 0 && (
            <ul className="print-doc__figures" aria-label={t('notes.export.figures')}>
              {figures.map(([kind, key]) => (
                <li key={kind}>
                  <b>{f.number(counts[kind])}</b>
                  <span>{t(key, { n: counts[kind] })}</span>
                </li>
              ))}
            </ul>
          )}
          {scope.map((line) => (
            <p className="print-doc__scope" key={line}>
              {line}
            </p>
          ))}
          {counts.highlight > 0 && (
            <ul className="print-doc__legend" aria-label={t('notes.export.legend')}>
              {HIGHLIGHT_COLORS.map((c) => (
                <li key={c} data-mark-color={c}>
                  <i aria-hidden="true" />
                  {t(COLOR_LABELS[c])}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="print-doc__stamp">
          {from} · {f.date(exportedAt)}
        </p>
      </header>

      <div className="print-sheet print-doc__pages">
        {sections.map((s) => (
          <section className="print-doc__section" key={s.key}>
            {options.heads && s.head && (
              <h2 className="print-doc__head">
                <bdi>{labels.sectionTitle(s.head)}</bdi>
                <span className="print-doc__headcount">{f.number(s.marks.length)}</span>
              </h2>
            )}
            <ul className="print-doc__list">
              {s.marks.map((a) => (
                <PrintMark
                  key={a.id}
                  mark={a}
                  where={labels.where(a, starts)}
                  date={f.date(a.createdAt)}
                  options={options}
                />
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

/**
 * One mark on the page. A bookmark is a marker and a place; a highlight
 * is its passage, and its note when notes are wanted; a note that is the
 * mark itself always keeps its words, whatever the toggle says.
 */
function PrintMark({
  mark,
  where,
  date,
  options,
}: {
  mark: Annotation;
  where: string;
  date: string;
  options: ExportOptions;
}) {
  const t = useT();
  if (mark.kind === 'bookmark') {
    return (
      <li className="print-mark print-mark--bookmark">
        <p className="print-mark__marker">
          <IconBookmark size={13} filled />
          <span className="visually-hidden">{t('notes.export.bookmark')} </span>
          <bdi>{where}</bdi>
        </p>
        {mark.note && (
          <p className="print-mark__note" dir="auto">
            {mark.note}
          </p>
        )}
        {options.where && <p className="print-mark__where">{date}</p>}
      </li>
    );
  }
  const note = mark.kind === 'note' || options.notes ? mark.note : null;
  return (
    <li
      className={`print-mark print-mark--${mark.kind}`}
      data-mark-color={mark.kind === 'highlight' ? colorOf(mark) : undefined}
    >
      {mark.selectedText && (
        <blockquote className="print-mark__quote" dir="auto">
          {mark.selectedText}
        </blockquote>
      )}
      {note && (
        <p className="print-mark__note" dir="auto">
          {note}
        </p>
      )}
      {!mark.selectedText && !note && (
        <p className="print-mark__plain">{t('notes.markedPassage')}</p>
      )}
      {options.where && (
        <p className="print-mark__where">
          <bdi>{t('notes.export.whereWhen', { where, date })}</bdi>
        </p>
      )}
    </li>
  );
}
