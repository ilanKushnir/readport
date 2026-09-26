import { useMemo, useRef, useState } from 'react';
import { BOOK_LANGUAGES, BULK_ADD_MAX, type BookSummary } from '@readport/shared';
import { api, failureMessage } from '../api/client';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { useSession } from '../state/session';
import { useShelves } from '../state/shelves';
import { Sheet, useToast } from './ui';
import { LanguageSpotlight } from './LanguagePicker';
import {
  IconBookmark,
  IconCheck,
  IconClose,
  IconEye,
  IconEyeOff,
  IconLanguages,
  IconLibrary,
  IconLink,
  IconList,
  IconPlus,
  IconShelf,
} from './icons';

/** What changed, so the page can load the list again and let go of books that left it. */
export type EditChange = 'language' | 'shelved' | 'removed' | 'hidden' | 'shown';

/** Many books in requests the server takes: never more than it accepts at once. */
async function inParts<T>(ids: string[], run: (part: string[]) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += BULK_ADD_MAX)
    out.push(await run(ids.slice(i, i + BULK_ADD_MAX)));
  return out;
}

/**
 * The library's Edit mode, at the foot of the grid while books are chosen:
 * how many there are, a way to choose all of them, and the changes that
 * make sense for many books at once - their language (curators), a shelf
 * or the reading list (everyone), off this shelf (its owner), hidden or
 * shown (admins). Each change is one request, and the grid stays in Edit
 * mode with the same books chosen, so a second change is one tap more.
 */
export function EditBar({
  selected,
  allSelected,
  shelf,
  hiddenShelf,
  onSelectAll,
  onSelectNone,
  onChanged,
}: {
  selected: BookSummary[];
  /** Every book shown is chosen: the link offers none instead of all. */
  allSelected: boolean;
  /** The reader's own shelf being looked at: books can come off it. */
  shelf: { id: string; name: string } | null;
  /** The Hidden shelf, where books can be shown again. */
  hiddenShelf: boolean;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onChanged: (change: EditChange, ids: string[]) => void;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const { user } = useSession();
  const [sheet, setSheet] = useState<'language' | 'add' | 'hide' | null>(null);
  const [busy, setBusy] = useState(false);
  const n = selected.length;
  const ids = selected.map((b) => b.id);
  const canCurate = user?.role === 'admin' || user?.role === 'curator';
  const isAdmin = user?.role === 'admin';
  const anyShown = selected.some((b) => !b.hidden);
  const anyHidden = selected.some((b) => b.hidden);
  const showHide = isAdmin && (n === 0 ? !hiddenShelf : anyShown);
  const showShow = isAdmin && (n === 0 ? hiddenShelf : anyHidden);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      toast.show(failureMessage(err, t('library.edit.failed'), t));
    } finally {
      setBusy(false);
    }
  };

  // The languages ReadPort knows, by their names in the reader's language.
  const languages = useMemo(
    () =>
      [...BOOK_LANGUAGES]
        .map((l) => ({ value: l.code, name: f.languageListName(l.code) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ value }) => ({ value })),
    [f],
  );
  // Ticked in the list when every book chosen already has it.
  const common = n > 0 && selected.every((b) => b.language === selected[0]!.language);
  const current = common ? (selected[0]!.language ?? undefined) : undefined;

  const setLanguage = (language: string | null) =>
    run(async () => {
      setSheet(null);
      await inParts(ids, (bookIds) =>
        api('/api/books/language', { method: 'POST', body: { bookIds, language } }),
      );
      toast.show(
        language
          ? t('library.edit.languageDone', { n, name: f.languageName(language) })
          : t('library.edit.languageAutoDone', { n }),
      );
      onChanged('language', ids);
    });

  const takeOff = () =>
    run(async () => {
      if (!shelf) return;
      await inParts(ids, (bookIds) =>
        api(`/api/shelves/${shelf.id}/remove`, { method: 'POST', body: { bookIds } }),
      );
      const gone = ids;
      toast.show(t('library.edit.removed', { n, shelf: shelf.name }), {
        label: t('shell.addTo.undo'),
        onClick: () =>
          void inParts(gone, (bookIds) =>
            api(`/api/shelves/${shelf.id}/books`, { method: 'POST', body: { bookIds } }),
          ).then(() => onChanged('shelved', gone)),
      });
      onChanged('removed', ids);
    });

  const setHidden = (hidden: boolean) =>
    run(async () => {
      setSheet(null);
      await inParts(ids, (bookIds) =>
        api('/api/books/hidden', { method: 'POST', body: { bookIds, hidden } }),
      );
      toast.show(hidden ? t('library.edit.hidden', { n }) : t('library.edit.shown', { n }));
      onChanged(hidden ? 'hidden' : 'shown', ids);
    });

  return (
    <>
      <div className="editbar" role="toolbar" aria-label={t('library.edit.toolbar', { n })}>
        <div className="editbar__head">
          <span className="editbar__count" aria-live="polite">
            {n === 0 ? t('library.edit.pick') : t('library.edit.selected', { n })}
          </span>
          <button
            type="button"
            className="editbar__link"
            onClick={allSelected ? onSelectNone : onSelectAll}
          >
            {allSelected ? t('library.edit.selectNone') : t('library.edit.selectAll')}
          </button>
        </div>
        <div className="editbar__actions">
          {canCurate && (
            <button
              type="button"
              className="editbar__action"
              disabled={n === 0 || busy}
              onClick={() => setSheet('language')}
            >
              <IconLanguages size={19} />
              <span>{t('library.edit.language')}</span>
            </button>
          )}
          <button
            type="button"
            className="editbar__action"
            disabled={n === 0 || busy}
            onClick={() => setSheet('add')}
          >
            <IconShelf size={19} />
            <span>{t('library.card.addTo')}</span>
          </button>
          {shelf && (
            <button
              type="button"
              className="editbar__action"
              disabled={n === 0 || busy}
              onClick={() => void takeOff()}
            >
              <IconClose size={19} />
              <span>{t('library.edit.remove')}</span>
            </button>
          )}
          {showHide && (
            <button
              type="button"
              className="editbar__action"
              disabled={n === 0 || busy}
              onClick={() => setSheet('hide')}
            >
              <IconEyeOff size={19} />
              <span>{t('library.edit.hide')}</span>
            </button>
          )}
          {showShow && (
            <button
              type="button"
              className="editbar__action"
              disabled={n === 0 || busy}
              onClick={() => void setHidden(false)}
            >
              <IconEye size={19} />
              <span>{t('library.edit.show')}</span>
            </button>
          )}
        </div>
      </div>

      {sheet === 'language' && (
        <LanguageSpotlight
          options={languages}
          selected={current}
          first={{
            label: t('library.edit.languageAuto'),
            hint: t('library.edit.languageAutoHint'),
          }}
          title={t('library.edit.languageTitle', { n })}
          label={t('library.edit.languageTitle', { n })}
          onSelect={(value) => void setLanguage(value)}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'add' && (
        <AddManySheet
          ids={ids}
          onClose={() => setSheet(null)}
          onAdded={() => onChanged('shelved', ids)}
        />
      )}
      {sheet === 'hide' && (
        <Sheet
          size="narrow"
          title={t('library.edit.hideTitle', { n })}
          onClose={() => setSheet(null)}
        >
          <ul className="hide-points">
            <li>
              <IconLibrary size={17} />
              <span>{t('library.edit.hideShelves', { n })}</span>
            </li>
            <li>
              <IconLink size={17} />
              <span>{t('library.edit.hideLinks', { n })}</span>
            </li>
            <li>
              <IconBookmark size={17} />
              <span>{t('library.edit.hideKept', { n })}</span>
            </li>
          </ul>
          {selected.some((b) => b.pair && b.pair.status !== 'candidate') && (
            <p className="hint">{t('library.edit.hidePairs')}</p>
          )}
          <div className="sheet__actions">
            <button className="btn" disabled={busy} onClick={() => void setHidden(true)}>
              <IconEyeOff size={16} /> {t('library.edit.hideConfirm', { n })}
            </button>
            <button className="btn btn--ghost" onClick={() => setSheet(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

/**
 * "Add to…" for many books: the reading list or a shelf, one tap each. Books
 * already there stay where they are, and the note says how many were.
 */
function AddManySheet({
  ids,
  onClose,
  onAdded,
}: {
  ids: string[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const { overview, refresh, createShelf } = useShelves();
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const n = ids.length;

  const add = async (
    key: string,
    to: (bookIds: string[]) => Promise<{ added: number; skipped: number }>,
    done: (added: number) => string,
  ) => {
    setBusy(key);
    try {
      const parts = await inParts(ids, to);
      const added = parts.reduce((s, p) => s + p.added, 0);
      const skipped = parts.reduce((s, p) => s + p.skipped, 0);
      toast.show(
        skipped > 0
          ? `${done(added)} · ${t('library.edit.alreadyThere', { n: skipped })}`
          : done(added),
      );
      await refresh();
      onAdded();
      onClose();
    } catch (err) {
      toast.show(failureMessage(err, t('shell.addTo.saveFailed'), t));
    } finally {
      setBusy(null);
    }
  };

  const toShelf = (shelf: { id: string; name: string }) =>
    add(
      shelf.id,
      (bookIds) =>
        api<{ added: number; skipped: number }>(`/api/shelves/${shelf.id}/books`, {
          method: 'POST',
          body: { bookIds },
        }),
      (added) => t('library.edit.addedTo', { n: added, shelf: shelf.name }),
    );

  const toQueue = () =>
    add(
      'queue',
      (bookIds) =>
        api<{ added: number; skipped: number }>('/api/reading-list/add', {
          method: 'POST',
          body: { bookIds },
        }),
      (added) => t('library.edit.queued', { n: added }),
    );

  const submitNew = async (e: React.FormEvent) => {
    e.preventDefault();
    const wanted = name.trim();
    if (!wanted || busy) return;
    try {
      const shelf = await createShelf(wanted);
      await toShelf(shelf);
    } catch (err) {
      toast.show(
        (err as Error).message.includes('shelf-name-taken')
          ? t('shell.shelves.nameTaken')
          : failureMessage(err, t('shell.shelves.createFailed'), t),
      );
    }
  };

  const shelves = overview?.shelves ?? [];
  return (
    <Sheet size="narrow" title={t('library.edit.addTitle', { n })} onClose={onClose}>
      <div className="addto">
        <button className="list-row" disabled={busy !== null} onClick={() => void toQueue()}>
          <IconList size={18} />
          <span className="grow">{t('shelves.readingList')}</span>
          {busy === 'queue' ? <IconCheck size={17} /> : <IconPlus size={17} />}
        </button>
        <div className="addto__rule" role="presentation" />
        {shelves.length === 0 && !creating && (
          <p className="addto__empty">{t('shell.addTo.noShelves')}</p>
        )}
        {shelves.map((s) => (
          <button
            key={s.id}
            className="list-row"
            disabled={busy !== null}
            onClick={() => void toShelf(s)}
          >
            <IconShelf size={18} />
            <span className="grow">{s.name}</span>
            <span className="soft">{f.number(s.count)}</span>
          </button>
        ))}
        {creating ? (
          <form className="addto__new" onSubmit={submitNew}>
            <label className="visually-hidden" htmlFor="addmany-shelf-name">
              {t('shell.shelves.name')}
            </label>
            <input
              id="addmany-shelf-name"
              ref={inputRef}
              className="input"
              autoFocus
              value={name}
              maxLength={60}
              placeholder={t('shell.shelves.name')}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              className="btn btn--secondary"
              type="submit"
              disabled={!name.trim() || busy !== null}
            >
              {t('shell.add')}
            </button>
          </form>
        ) : (
          <button className="list-row" onClick={() => setCreating(true)}>
            <IconPlus size={18} />
            <span className="grow">{t('shell.addTo.newShelf')}</span>
          </button>
        )}
      </div>
    </Sheet>
  );
}
