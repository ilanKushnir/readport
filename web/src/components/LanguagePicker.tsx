import { useCallback, useEffect, useRef, useState } from 'react';
import { languageFlag } from '@readport/shared';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { IconCheck, IconChevronDown, IconGlobe } from './icons';

export interface LanguageOption {
  /** The facet value, lower-cased: a language code, or the unknown sentinel. */
  value: string;
  /** Books in this language, in the shelf being shown. */
  count: number;
}

/**
 * One language at a time, picked from a short list.
 *
 * The library used to show every language as a chip, any number of them on
 * at once: a row that ran off a phone's screen and a filter nobody reached
 * for twice. This is one button beside the format control - "All
 * languages" until a language is chosen, then that language - and a card
 * that opens under it with the languages the shelf holds, each with its
 * count, the chosen one ticked. Choosing closes the card.
 *
 * A menu of radio items: arrows move through it, Home and End jump, Escape
 * closes it and puts focus back on the button, a click outside closes it.
 */
export function LanguagePicker({
  options,
  selected,
  onSelect,
}: {
  options: LanguageOption[];
  selected: string | null;
  onSelect: (value: string | null) => void;
}) {
  const t = useT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const name = selected ? f.languageName(selected) : t('library.lang.allLanguages');
  const flag = selected ? languageFlag(selected) : '';

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  const toggle = () => {
    if (open) return close();
    const r = trigger.current?.getBoundingClientRect();
    // Hang from the end edge when the start edge would run the card off the
    // screen - which, beside the format control on a phone, it always does.
    setAlignEnd(!!r && r.left + 272 > window.innerWidth);
    setOpen(true);
  };

  const items = () =>
    Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);

  useEffect(() => {
    if (!open) return;
    // The ticked item first, so a second visit starts where the first ended.
    const all = items();
    (all.find((b) => b.getAttribute('aria-checked') === 'true') ?? all[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === 'Tab') {
        close(false);
        return;
      }
      const all = items();
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      const to =
        e.key === 'ArrowDown'
          ? (at + 1) % all.length
          : e.key === 'ArrowUp'
            ? (at - 1 + all.length) % all.length
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? all.length - 1
                : -1;
      if (to < 0) return;
      e.preventDefault();
      all[to]?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, close]);

  const choose = (value: string | null) => {
    onSelect(value);
    close();
  };

  return (
    <div className="langpick" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`langpick__btn${selected ? ' is-on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('library.lang.button', { name })}
        title={t('library.lang.button', { name })}
        onClick={toggle}
      >
        {flag ? (
          <span className="langpick__flag" aria-hidden="true">
            {flag}
          </span>
        ) : (
          <IconGlobe size={17} />
        )}
        <span className="langpick__name">{name}</span>
        {selected && (
          <span className="langpick__code" aria-hidden="true">
            {selected.length <= 3 ? selected.toUpperCase() : ''}
          </span>
        )}
        <IconChevronDown size={14} className="langpick__chev" />
      </button>
      {open && (
        <div
          ref={list}
          className={`langpick__pop${alignEnd ? ' is-end' : ''}`}
          role="menu"
          aria-label={t('library.lang.group')}
        >
          <p className="langpick__title" aria-hidden="true">
            {t('library.lang.menuTitle')}
          </p>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selected === null}
            className="langpick__item"
            onClick={() => choose(null)}
          >
            <span className="langpick__bubble" aria-hidden="true">
              <IconGlobe size={15} />
            </span>
            <span className="langpick__label">{t('library.lang.allLanguages')}</span>
            <IconCheck size={16} className="langpick__tick" />
          </button>
          {options.map((o) => {
            const on = selected === o.value;
            const oflag = languageFlag(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className="langpick__item"
                onClick={() => choose(o.value)}
              >
                <span className="langpick__bubble" aria-hidden="true">
                  {oflag || <IconGlobe size={15} />}
                </span>
                <span className="langpick__label">{f.languageName(o.value)}</span>
                <span className="langpick__count">
                  <span aria-hidden="true">{f.number(o.count)}</span>
                  <span className="visually-hidden">{t('common.books', { n: o.count })}</span>
                </span>
                <IconCheck size={16} className="langpick__tick" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
