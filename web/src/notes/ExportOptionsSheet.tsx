import { useMemo, useState } from 'react';
import { type Annotation } from '@readport/shared';
import { Sheet } from '../components/ui';
import { useI18n, useT } from '../i18n';
import { type MessageKey } from '../i18n/messages/en';
import { useFormat } from '../i18n/useFormat';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../reader/marks';
import {
  LOOKS,
  MARK_KINDS,
  PAGE_SIZES,
  TEXT_SIZES,
  selectForExport,
  type ExportOptions,
  type Look,
  type PageSize,
  type TextSize,
} from './exportOptions';
import { countByKind, SORT_ORDERS, type MarkKind } from './organise';
import { useMarkLabels } from './useMarkLabels';

/**
 * The sheet behind "Export as PDF…": how the pages should look, what size
 * they are, what goes on them and in what order, with one line at the foot
 * saying what will come out - "12 highlights, 2 notes, 1 bookmark · only
 * plum and sky" - so nobody prints forty pages to find the notes were left
 * out. Every control changes that line at once; the primary button hands
 * the finished options back and the caller decides where they go (to the
 * print sheet from the marks page, into the preview from the export page).
 */

const LOOK_LABELS: Record<Look, [MessageKey, MessageKey]> = {
  paper: ['notes.export.look.paper', 'notes.export.look.paperHint'],
  night: ['notes.export.look.night', 'notes.export.look.nightHint'],
};

const PAGE_LABELS: Record<PageSize, [MessageKey, MessageKey]> = {
  a4: ['notes.export.page.a4', 'notes.export.page.a4Hint'],
  letter: ['notes.export.page.letter', 'notes.export.page.letterHint'],
  phone: ['notes.export.page.phone', 'notes.export.page.phoneHint'],
};

const TEXT_LABELS: Record<TextSize, MessageKey> = {
  compact: 'notes.export.text.compact',
  comfortable: 'notes.export.text.comfortable',
  large: 'notes.export.text.large',
};

const COUNT_LABELS: Record<MarkKind, MessageKey> = {
  highlight: 'notes.book.highlights',
  note: 'notes.book.notes',
  bookmark: 'notes.book.bookmarks',
};

const WITH_LABELS: Record<'cover' | 'heads' | 'where' | 'notes', MessageKey> = {
  cover: 'notes.export.include.cover',
  heads: 'notes.export.include.heads',
  where: 'notes.export.include.where',
  notes: 'notes.export.include.notes',
};

export function ExportOptionsSheet({
  initial,
  marks,
  submitLabel,
  onClose,
  onSubmit,
}: {
  initial: ExportOptions;
  /** Every mark in the book: the sheet counts what the options leave in. */
  marks: readonly Annotation[];
  submitLabel: string;
  onClose: () => void;
  onSubmit: (options: ExportOptions) => void;
}) {
  const t = useT();
  const f = useFormat();
  const { tag } = useI18n();
  const labels = useMarkLabels();
  const [options, setOptions] = useState(initial);
  const patch = (change: Partial<ExportOptions>) =>
    setOptions((current) => ({ ...current, ...change }));

  const inBook = useMemo(() => countByKind(marks), [marks]);
  const chosen = useMemo(() => selectForExport(marks, options), [marks, options]);
  const counts = useMemo(() => countByKind(chosen), [chosen]);

  const toggleKind = (kind: MarkKind) =>
    patch({
      kinds: options.kinds.includes(kind)
        ? options.kinds.filter((k) => k !== kind)
        : MARK_KINDS.filter((k) => k === kind || options.kinds.includes(k)),
    });
  const toggleColor = (c: HighlightColor) =>
    patch({
      colors: options.colors.includes(c)
        ? options.colors.filter((x) => x !== c)
        : HIGHLIGHT_COLORS.filter((x) => x === c || options.colors.includes(x)),
    });

  // "12 highlights, 2 notes, 1 bookmark": a unit list, so each language
  // gets its own separator rather than an English comma.
  const summary = useMemo(() => {
    if (chosen.length === 0) return t('notes.export.nothing');
    const parts = MARK_KINDS.filter((k) => counts[k] > 0).map((k) =>
      t(COUNT_LABELS[k], { n: counts[k] }),
    );
    let countsText: string;
    try {
      countsText = new Intl.ListFormat(tag, { style: 'short', type: 'unit' }).format(parts);
    } catch {
      countsText = parts.join(', ');
    }
    if (options.colors.length === 0) return countsText;
    const scope = t('notes.export.summary.colours', {
      list: f.list(options.colors.map(labels.colourName)),
    });
    return t('notes.export.summary', { counts: countsText, scope });
  }, [chosen.length, counts, options.colors, t, f, tag, labels]);

  return (
    <Sheet title={t('notes.export.sheetTitle')} onClose={onClose}>
      <div className="export-sheet">
        <div className="export-sheet__group" role="group" aria-labelledby="export-look">
          <span className="export-sheet__label" id="export-look">
            {t('notes.export.look')}
          </span>
          <div className="export-look">
            {LOOKS.map((look) => (
              <button
                key={look}
                type="button"
                className="export-look__opt"
                aria-pressed={options.look === look}
                onClick={() => patch({ look })}
              >
                <span className={`export-look__page export-look__page--${look}`} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span className="export-look__text">
                  <strong>{t(LOOK_LABELS[look][0])}</strong>
                  <small>{t(LOOK_LABELS[look][1])}</small>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="export-sheet__group" role="group" aria-labelledby="export-page">
          <span className="export-sheet__label" id="export-page">
            {t('notes.export.page')}
          </span>
          <div className="segmented">
            {PAGE_SIZES.map((page) => (
              <button
                key={page}
                type="button"
                aria-pressed={options.page === page}
                onClick={() => patch({ page })}
              >
                {t(PAGE_LABELS[page][0])}
              </button>
            ))}
          </div>
          <p className="hint">{t(PAGE_LABELS[options.page][1])}</p>
        </div>

        <div className="export-sheet__group" role="group" aria-labelledby="export-include">
          <span className="export-sheet__label" id="export-include">
            {t('notes.export.include')}
          </span>
          <ul className="export-checks">
            {MARK_KINDS.map((kind) => (
              <li key={kind}>
                <label>
                  <input
                    type="checkbox"
                    checked={options.kinds.includes(kind)}
                    disabled={inBook[kind] === 0}
                    onChange={() => toggleKind(kind)}
                  />
                  <span>
                    {labels.kindName(kind)} <small>{f.number(inBook[kind])}</small>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {inBook.highlight > 0 && options.kinds.includes('highlight') && (
            <div
              className="swatches export-sheet__swatches"
              role="group"
              aria-label={t('notes.highlightColour')}
            >
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch swatch--${c}`}
                  aria-pressed={options.colors.includes(c)}
                  aria-label={t('notes.onlyColour', { color: c })}
                  onClick={() => toggleColor(c)}
                />
              ))}
            </div>
          )}
          <ul className="export-checks export-checks--with">
            {(Object.keys(WITH_LABELS) as (keyof typeof WITH_LABELS)[]).map((flag) => (
              <li key={flag}>
                <label>
                  <input
                    type="checkbox"
                    checked={options[flag]}
                    onChange={(e) => patch({ [flag]: e.target.checked })}
                  />
                  <span>{t(WITH_LABELS[flag])}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>

        <div className="export-sheet__group" role="group" aria-labelledby="export-order">
          <span className="export-sheet__label" id="export-order">
            {t('notes.export.order')}
          </span>
          <div className="segmented">
            {SORT_ORDERS.map((sort) => (
              <button
                key={sort}
                type="button"
                aria-pressed={options.sort === sort}
                onClick={() => patch({ sort })}
              >
                {labels.sortName(sort)}
              </button>
            ))}
          </div>
        </div>

        <div className="export-sheet__group" role="group" aria-labelledby="export-text">
          <span className="export-sheet__label" id="export-text">
            {t('notes.export.textSize')}
          </span>
          <div className="segmented">
            {TEXT_SIZES.map((text) => (
              <button
                key={text}
                type="button"
                aria-pressed={options.text === text}
                onClick={() => patch({ text })}
              >
                {t(TEXT_LABELS[text])}
              </button>
            ))}
          </div>
        </div>

        <div className="export-sheet__foot">
          <p
            className={`export-sheet__summary${chosen.length === 0 ? ' export-sheet__summary--empty' : ''}`}
            aria-live="polite"
          >
            <bdi>{summary}</bdi>
          </p>
          <div className="sheet__actions">
            <button
              type="button"
              className="btn"
              disabled={chosen.length === 0}
              onClick={() => onSubmit(options)}
            >
              {submitLabel}
            </button>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
