import { useCallback, useEffect, useRef, useState } from 'react';
import { api, failureMessage } from '../api/client';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { useShelves } from '../state/shelves';
import { Sheet, useToast } from './ui';
import { IconCheck, IconListPlus, IconPlus, IconShelf } from './icons';

/**
 * "Add to…": two taps to shelve a book, two to queue it. The panel STAYS
 * OPEN as rows are toggled, so putting one book on three shelves is three
 * taps rather than three trips through the menu.
 */

interface Membership {
  shelfIds: string[];
  onReadingList: boolean;
}

export function AddToSheet({
  bookId,
  title,
  onClose,
  onChanged,
}: {
  bookId: string;
  title: string;
  onClose: () => void;
  /** The book page redraws its membership chips from this. */
  onChanged?: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const { overview, refresh, createShelf } = useShelves();
  const toast = useToast();
  const [member, setMember] = useState<Membership | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setMember(await api<Membership>(`/api/books/${bookId}/shelves`));
    } catch {
      setMember({ shelfIds: [], onReadingList: false });
    }
  }, [bookId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const after = useCallback(async () => {
    await load();
    await refresh();
    onChanged?.();
  }, [load, refresh, onChanged]);

  const toggleShelf = async (id: string, shelfName: string) => {
    if (!member || busy) return;
    const on = member.shelfIds.includes(id);
    setBusy(id);
    try {
      await api(`/api/shelves/${id}/books/${bookId}`, { method: on ? 'DELETE' : 'PUT' });
      await after();
      if (on) {
        toast.show(t('shell.addTo.takenOff', { shelf: shelfName }), {
          label: t('shell.addTo.undo'),
          onClick: () => {
            void api(`/api/shelves/${id}/books/${bookId}`, { method: 'PUT' }).then(after);
          },
        });
      } else {
        toast.show(t('shell.addTo.addedTo', { shelf: shelfName }), {
          label: t('shell.addTo.undo'),
          onClick: () => {
            void api(`/api/shelves/${id}/books/${bookId}`, { method: 'DELETE' }).then(after);
          },
        });
      }
    } catch (err) {
      toast.show(failureMessage(err, t('shell.addTo.saveFailed'), t));
    } finally {
      setBusy(null);
    }
  };

  const queue = async (position: 'top' | 'end') => {
    if (!member || busy) return;
    setBusy('queue');
    try {
      if (member.onReadingList && position === 'end') {
        await api(`/api/reading-list/${bookId}`, { method: 'DELETE' });
        await after();
        toast.show(t('shell.addTo.takenOffReadingList'));
      } else {
        const res = await api<{ moved: boolean; position: number | null; count: number }>(
          `/api/reading-list/${bookId}`,
          { method: 'PUT', body: { position } },
        );
        await after();
        // The server reports where it actually landed, and the confirmation
        // repeats that rather than the intent. A book that was already 7th
        // and has now been moved to the front should say it moved.
        toast.show(
          position === 'top'
            ? res.moved
              ? t('shell.addTo.movedToFront')
              : t('shell.addTo.nextUp')
            : res.position !== null
              ? t('shell.addTo.queuedAt', { n: res.position })
              : t('shell.addTo.addedToReadingList'),
        );
      }
    } catch (err) {
      toast.show(failureMessage(err, t('shell.addTo.saveFailed'), t));
    } finally {
      setBusy(null);
    }
  };

  const submitNew = async (e: React.FormEvent) => {
    e.preventDefault();
    const wanted = name.trim();
    if (!wanted || busy) return;
    setBusy('new');
    try {
      const shelf = await createShelf(wanted);
      await api(`/api/shelves/${shelf.id}/books/${bookId}`, { method: 'PUT' });
      await after();
      setName('');
      setCreating(false);
      toast.show(t('shell.addTo.addedTo', { shelf: shelf.name }));
    } catch (err) {
      toast.show(
        (err as Error).message.includes('shelf-name-taken')
          ? t('shell.shelves.nameTaken')
          : failureMessage(err, t('shell.shelves.createFailed'), t),
      );
    } finally {
      setBusy(null);
    }
  };

  const shelves = overview?.shelves ?? [];

  return (
    <Sheet size="narrow" title={title} onClose={onClose}>
      <div className="addto">
        <button
          className="list-row"
          onClick={() => void queue('top')}
          disabled={busy !== null || !member}
        >
          <IconListPlus size={17} />
          <span className="grow">{t('shell.addTo.readNext')}</span>
          <span className="soft">{t('shell.addTo.frontOfQueue')}</span>
        </button>
        <button
          className="list-row"
          onClick={() => void queue('end')}
          disabled={busy !== null || !member}
          aria-pressed={member?.onReadingList ?? false}
        >
          <IconListPlus size={17} />
          <span className="grow">
            {member?.onReadingList
              ? t('shell.addTo.onReadingList')
              : t('shell.addTo.addToReadingList')}
          </span>
          {member?.onReadingList && <IconCheck size={17} />}
        </button>

        <div className="addto__rule" role="presentation" />

        {shelves.length === 0 && !creating && (
          <p className="addto__empty">{t('shell.addTo.noShelves')}</p>
        )}
        {shelves.map((s) => {
          const on = member?.shelfIds.includes(s.id) ?? false;
          return (
            <button
              key={s.id}
              className="list-row"
              onClick={() => void toggleShelf(s.id, s.name)}
              disabled={busy !== null || !member}
              aria-pressed={on}
            >
              <IconShelf size={17} />
              <span className="grow">{s.name}</span>
              {on ? <IconCheck size={17} /> : <span className="soft">{f.number(s.count)}</span>}
            </button>
          );
        })}

        {creating ? (
          <form className="addto__new" onSubmit={submitNew}>
            <label className="visually-hidden" htmlFor="addto-shelf-name">
              {t('shell.shelves.name')}
            </label>
            <input
              id="addto-shelf-name"
              ref={inputRef}
              className="input"
              value={name}
              maxLength={60}
              placeholder={t('shell.shelves.name')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setCreating(false);
                  setName('');
                }
              }}
            />
            <button className="btn btn--secondary" type="submit" disabled={!name.trim()}>
              {t('shell.add')}
            </button>
          </form>
        ) : (
          <button className="list-row" onClick={() => setCreating(true)}>
            <IconPlus size={17} />
            <span className="grow">{t('shell.addTo.newShelf')}</span>
          </button>
        )}
      </div>
    </Sheet>
  );
}
