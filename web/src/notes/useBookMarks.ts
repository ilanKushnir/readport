import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { type Annotation } from '@readport/shared';
import { api } from '../api/client';
import { type BookDetail } from '../lib/types';

/**
 * One book and everything marked in it, for the per-book view and the
 * printed page alike. The book's detail carries the cover, the author and
 * the chapter list the marks are grouped by; the marks come from the
 * book's own annotations endpoint. A book that will not load is an error;
 * marks that will not load are simply none.
 */
export function useBookMarks(bookId: string): {
  detail: BookDetail | null;
  marks: Annotation[];
  setMarks: Dispatch<SetStateAction<Annotation[]>>;
  state: 'loading' | 'ready' | 'error';
} {
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [marks, setMarks] = useState<Annotation[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    setState('loading');
    setDetail(null);
    setMarks([]);
    void (async () => {
      try {
        const [d, a] = await Promise.all([
          api<BookDetail>(`/api/books/${bookId}`),
          api<{ annotations: Annotation[] }>(`/api/books/${bookId}/annotations`).catch(() => ({
            annotations: [] as Annotation[],
          })),
        ]);
        if (!alive) return;
        setDetail(d);
        setMarks(a.annotations);
        setState('ready');
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [bookId]);

  return { detail, marks, setMarks, state };
}
