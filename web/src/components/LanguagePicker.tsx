import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { languageFlag } from '@readport/shared';
import { useLocale, useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { languageName } from '../lib/languageName';
import { languageNames, searchLanguages } from '../lib/languageSearch';
import { useFocusTrap, useScrollLock } from './ui';
import { IconCheck, IconClose, IconGlobe, IconSearch } from './icons';

export interface LanguageOption {
  /** The facet value, lower-cased: a language code, or the unknown sentinel. */
  value: string;
  /** Books in this language, in the shelf being shown. */
  count: number;
}

/**
 * One language at a time, picked from the library's own.
 *
 * A button at the end of the format control - the globe, or the chosen
 * language's flag - that opens the languages the shelf holds in the same
 * floating panel the reader searches a book in: a search field on top and
 * the list under it, each language with its flag and how many books it has,
 * the chosen one ticked. A language answers to its name in the app's
 * language, in its own and in English. Choosing closes the panel.
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
  const name = selected ? f.languageListName(selected) : t('library.lang.allLanguages');
  const flag = selected ? languageFlag(selected) : '';

  return (
    <div className="langpick">
      <button
        type="button"
        className={`langpick__btn${selected ? ' is-on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('library.lang.button', { name })}
        title={t('library.lang.button', { name })}
        onClick={() => setOpen(true)}
      >
        {flag ? (
          <span className="langpick__flag" aria-hidden="true">
            {flag}
          </span>
        ) : (
          <IconGlobe size={18} />
        )}
        <span className="langpick__name">{name}</span>
        {selected && (
          <span className="langpick__code" aria-hidden="true">
            {selected.length <= 3 ? selected.toUpperCase() : ''}
          </span>
        )}
      </button>
      {open && (
        <LanguageSpotlight
          options={options}
          selected={selected}
          onClose={() => setOpen(false)}
          onSelect={(value) => {
            onSelect(value);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

interface Entry {
  value: string | null;
  label: string;
  /** The language's name in itself, when that is not what the label already says. */
  own: string | null;
  flag: string;
  count: number;
  names: string[];
}

const optionId = (value: string | null) => `langspot-${value ?? 'all'}`;

function LanguageSpotlight({
  options,
  selected,
  onSelect,
  onClose,
}: {
  options: LanguageOption[];
  selected: string | null;
  onSelect: (value: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useFocusTrap(ref, onClose);
  useScrollLock();

  // Typed into straight away where there is a keyboard to type with. On a
  // phone the list is the thing: focusing the field would put the keyboard
  // over half of it before anyone asked to search.
  useEffect(() => {
    if (typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches)
      input.current?.focus();
  }, []);

  const entries = useMemo<Entry[]>(() => {
    const all = t('library.lang.allLanguages');
    return [
      {
        value: null,
        label: all,
        own: null,
        flag: '',
        count: options.reduce((n, o) => n + o.count, 0),
        names: [all],
      },
      ...options.map((o) => {
        const label = f.languageListName(o.value);
        // "Русский" under "Russian": how its own readers would look for it.
        const itself = o.value.includes('+') ? label : languageName(o.value, o.value);
        return {
          value: o.value,
          label,
          own: itself !== label ? itself : null,
          flag: languageFlag(o.value),
          count: o.count,
          names: languageNames(o.value, locale),
        };
      }),
    ];
  }, [options, f, locale, t]);

  const shown = useMemo(() => searchLanguages(entries, query), [entries, query]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      entries.findIndex((e) => e.value === selected),
    ),
  );
  // A new query starts at its best match.
  useEffect(() => {
    if (query) setActive(0);
  }, [query]);
  const current = shown[Math.min(active, shown.length - 1)] ?? null;

  useEffect(() => {
    if (current)
      document.getElementById(optionId(current.value))?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length === 0) return;
      const at = Math.min(active, shown.length - 1);
      setActive(
        e.key === 'ArrowDown' ? (at + 1) % shown.length : (at - 1 + shown.length) % shown.length,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current) onSelect(current.value);
    }
  };

  return createPortal(
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="spot langspot"
        role="dialog"
        aria-modal="true"
        aria-label={t('library.lang.group')}
        tabIndex={-1}
        ref={ref}
      >
        <div className="spot__field">
          <IconSearch size={20} />
          <input
            ref={input}
            className="spot__input"
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls="langspot-list"
            aria-autocomplete="list"
            aria-activedescendant={current ? optionId(current.value) : undefined}
            aria-label={t('library.lang.search')}
            placeholder={t('library.lang.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
          />
          {query ? (
            <button
              type="button"
              className="spot__clear"
              onClick={() => {
                setQuery('');
                input.current?.focus();
              }}
              aria-label={t('library.lang.clear')}
            >
              <IconClose size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="spot__clear langspot__close"
              onClick={onClose}
              aria-label={t('common.close')}
            >
              <IconClose size={12} />
            </button>
          )}
        </div>
        <div className="spot__results">
          <p className="langspot__title" id="langspot-title">
            {t('library.lang.menuTitle')}
          </p>
          {shown.length === 0 ? (
            <p className="spot__none" role="status">
              {t('library.lang.noMatch')}
            </p>
          ) : (
            <ul
              id="langspot-list"
              className="langspot__list"
              role="listbox"
              aria-labelledby="langspot-title"
            >
              {shown.map((e, i) => (
                // A listbox's options are chosen through the field (arrows and
                // Enter) or by pointer; the field keeps focus throughout.
                <li
                  key={e.value ?? 'all'}
                  id={optionId(e.value)}
                  role="option"
                  aria-selected={e.value === selected}
                  className={`langspot__item${e === current ? ' is-active' : ''}`}
                  onPointerMove={() => setActive(i)}
                  onClick={() => onSelect(e.value)}
                >
                  <span className="langpick__bubble" aria-hidden="true">
                    {e.flag || <IconGlobe size={15} />}
                  </span>
                  <span className="langspot__names">
                    <span className="langspot__name">{e.label}</span>
                    {e.own && (
                      <span className="langspot__own" lang={e.value ?? undefined}>
                        {e.own}
                      </span>
                    )}
                  </span>
                  <span className="langpick__count">
                    <span aria-hidden="true">{f.number(e.count)}</span>
                    <span className="visually-hidden">{t('common.books', { n: e.count })}</span>
                  </span>
                  <IconCheck size={16} className="langspot__tick" />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
