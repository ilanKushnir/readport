import { type Annotation } from '@readport/shared';
import { Link } from 'react-router-dom';
import { IconTrash } from '../components/icons';
import { useT } from '../i18n';
import { colorOf } from '../reader/marks';
import { hrefOf } from './organise';

/**
 * One mark, wherever it is listed: the passage in the reading face with the
 * highlight's colour as a bar down its side, the reader's own words beneath
 * it in the interface face, and where in the book it came from.
 *
 * The passage and the note each set their own direction (`dir="auto"`): a
 * Hebrew quotation reads right-to-left inside an English interface, and an
 * English one left-to-right inside a Hebrew interface, whatever the shell
 * around them is doing.
 */
export function MarkCard({
  mark,
  where,
  date,
  bookTitle,
  onDelete,
}: {
  mark: Annotation;
  /** "Chapter 4 · 37%", or the percentage alone when the chapter is not known. */
  where: string;
  date: string;
  /** Named when the list spans books, so "Open in book" says which one. */
  bookTitle?: string;
  onDelete?: () => void;
}) {
  const t = useT();
  const color = mark.kind === 'highlight' ? colorOf(mark) : undefined;
  return (
    <li className={`notes-mark notes-mark--${mark.kind}`} data-mark-color={color}>
      <span className="notes-mark__bar" aria-hidden="true" />
      <div className="notes-mark__body">
        {mark.selectedText && (
          <blockquote className="notes-mark__quote" dir="auto">
            {mark.selectedText}
          </blockquote>
        )}
        {mark.note && (
          <p className="notes-mark__note" dir="auto">
            {mark.note}
          </p>
        )}
        {!mark.selectedText && !mark.note && (
          <p className="notes-mark__plain">
            {mark.kind === 'bookmark' ? t('notes.bookmarkedPage') : t('notes.markedPassage')}
          </p>
        )}
        <div className="notes-mark__foot">
          <bdi className="notes-mark__where">{where}</bdi>
          <span className="notes-mark__date">{date}</span>
          <Link
            className="notes-mark__open"
            to={hrefOf(mark)}
            aria-label={
              bookTitle ? t('notes.openIn', { kind: mark.kind, title: bookTitle }) : undefined
            }
          >
            {t('notes.openInBook')}
          </Link>
          {onDelete && (
            <button
              type="button"
              className="icon-btn notes-mark__delete"
              aria-label={t('common.delete')}
              onClick={onDelete}
            >
              <IconTrash size={15} />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
