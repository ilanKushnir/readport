import { type ReactNode } from 'react';
import { UNKNOWN_LANGUAGE } from '@readport/shared';
import { Cover } from './ui';
import { useFormat } from '../i18n/useFormat';
import '../translations/translations.css';

/** One edition in a list: its cover, its language, its title, and what can be done with it. */
export function EditionRow({
  id,
  kind,
  hasCover,
  title,
  author,
  language,
  formats,
  note,
  children,
  dimmed = false,
}: {
  id: string;
  kind: 'ebook' | 'audio';
  hasCover: boolean;
  title: string;
  author: string | null;
  language: string | null;
  formats: string;
  note?: ReactNode;
  children?: ReactNode;
  dimmed?: boolean;
}) {
  const f = useFormat();
  return (
    <li className={`edition-row${dimmed ? ' is-dimmed' : ''}`}>
      <span className="edition-cover edition-cover--sm">
        <Cover book={{ id, kind, hasCover, title, author }} />
      </span>
      <div className="edition-row__body">
        <span className="edition-row__meta">
          {/* An audiobook often says nothing of its language; "Unknown" in
              every row would say nothing either. */}
          {language && language !== UNKNOWN_LANGUAGE && (
            <>
              <strong>{f.languageName(language)}</strong>
              <span aria-hidden="true"> · </span>
            </>
          )}
          {formats}
        </span>
        <bdi className="edition-row__title" lang={language ?? undefined}>
          {title}
        </bdi>
        {author && (
          <bdi className="edition-row__author" lang={language ?? undefined}>
            {author}
          </bdi>
        )}
        {note && <span className="edition-row__note">{note}</span>}
      </div>
      {children && <div className="edition-row__actions">{children}</div>}
    </li>
  );
}
