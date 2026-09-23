import { useEffect, useMemo, useState } from 'react';
import {
  getDownloadState,
  listDownloads,
  subscribeDownloads,
  type DownloadState,
} from './downloads';

/**
 * A download as it is right now, kept current: whichever page or tab
 * started it, it is heard here (see subscribeDownloads). `undefined` until
 * this device has been asked; null when the book has never been saved.
 */
export function useDownloadState(bookId: string | null): DownloadState | null | undefined {
  const [state, setState] = useState<DownloadState | null | undefined>(undefined);
  useEffect(() => {
    setState(undefined);
    if (!bookId) {
      setState(null);
      return;
    }
    let alive = true;
    const read = () =>
      void getDownloadState(bookId).then((s) => {
        if (alive) setState(s);
      });
    read();
    const off = subscribeDownloads((id, s) => {
      if (id === bookId) setState(s);
      else if (id === '*') read();
    });
    return () => {
      alive = false;
      off();
    };
  }, [bookId]);
  return state;
}

const running = (d: DownloadState) => d.status === 'downloading';

/** Every download running on this device - in this tab or another - newest first. */
export function useActiveDownloads(): DownloadState[] {
  const [byBook, setByBook] = useState<Map<string, DownloadState>>(new Map());
  useEffect(() => {
    let alive = true;
    const read = () =>
      void listDownloads().then((all) => {
        if (alive) setByBook(new Map(all.filter(running).map((d) => [d.bookId, d])));
      });
    read();
    const off = subscribeDownloads((id, s) => {
      if (id === '*') return read();
      setByBook((current) => {
        const had = current.has(id);
        if (!(s && running(s)) && !had) return current;
        const next = new Map(current);
        if (s && running(s)) next.set(id, s);
        else next.delete(id);
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return useMemo(
    () => [...byBook.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [byBook],
  );
}
