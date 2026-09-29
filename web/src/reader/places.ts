import { z } from 'zod';
import { type ReadingPlace, readingPlaceSchema } from '@readport/shared';
import { api } from '../api/client';

/**
 * A reader's places in a book (see places.ts in the shared package), as the
 * server last said, and kept in this browser too: the way back to one's
 * place is wanted most on a train, which is where the server is not.
 */

const listSchema = z.array(readingPlaceSchema);
const keyFor = (bookId: string) => `rp-places:${bookId}`;

function keep(bookId: string, places: ReadingPlace[]): ReadingPlace[] {
  try {
    localStorage.setItem(keyFor(bookId), JSON.stringify(places));
  } catch {
    /* private mode: kept for as long as the page is open */
  }
  return places;
}

/** The places as this browser last heard them. */
export function cachedPlaces(bookId: string): ReadingPlace[] {
  try {
    const raw = localStorage.getItem(keyFor(bookId));
    const parsed = raw ? listSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export async function fetchPlaces(bookId: string): Promise<ReadingPlace[]> {
  const res = await api<{ places: unknown }>(`/api/books/${encodeURIComponent(bookId)}/places`);
  const parsed = listSchema.safeParse(res.places);
  return parsed.success ? keep(bookId, parsed.data) : cachedPlaces(bookId);
}

export async function forgetPlace(bookId: string, placeId: string): Promise<ReadingPlace[]> {
  const res = await api<{ places: unknown }>(
    `/api/books/${encodeURIComponent(bookId)}/places/${encodeURIComponent(placeId)}`,
    { method: 'DELETE' },
  );
  const parsed = listSchema.safeParse(res.places);
  return keep(bookId, parsed.success ? parsed.data : []);
}
