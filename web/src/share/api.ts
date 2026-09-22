import { api } from '../api/client';
import type {
  CreateShareResponse,
  JoinRequestDto,
  JoinRequestInput,
  JoinStatusResponse,
  RecommendedBy,
  SharePeek,
  SharedBook,
} from '@readport/shared';

/**
 * The share API, as the web calls it. The public calls (peek, ask to join,
 * check on a request) answer without a session and never 401, which
 * matters: a 401 anywhere else trips the app's revocation handling, and a
 * stranger on a share page has nothing to revoke.
 */

export type { CreateShareResponse, JoinRequestDto, JoinStatusResponse, RecommendedBy, SharePeek };
export type { SharedBook };

const enc = encodeURIComponent;

/** The caller's link for this book, made on first ask. */
export const createShare = (bookId: string) =>
  api<CreateShareResponse>(`/api/books/${enc(bookId)}/share`, { method: 'POST' });

/** The caller's link for this book if one is live, without making one. */
export const currentShare = (bookId: string) =>
  api<{ url: string | null; token: string | null }>(`/api/books/${enc(bookId)}/share`);

/** Withdraw a link: the next share makes a fresh one. */
export const revokeShare = (token: string) =>
  api<{ ok: true }>(`/api/share/${enc(token)}`, { method: 'DELETE' });

export const peekShare = (token: string) => api<SharePeek>(`/api/share/${enc(token)}`);

/** The shared book onto the caller's reading list, credited to the sharer. */
export const addSharedBook = (token: string) =>
  api<{ added: boolean; bookId: string }>(`/api/share/${enc(token)}/add`, { method: 'POST' });

export const askToJoin = (token: string, body: JoinRequestInput) =>
  api<{ status: 'pending' | 'approved' }>(`/api/share/${enc(token)}/join`, {
    method: 'POST',
    body,
  });

export const joinStatusFor = (token: string, email: string) =>
  api<JoinStatusResponse>(`/api/share/${enc(token)}/join?email=${enc(email)}`);

/** The cover as the share page may show it to someone without a session. */
export const shareCoverUrl = (token: string) => `/s/${enc(token)}/cover`;

/* --------------------------------------------------- the remembered address */

const JOIN_EMAIL_KEY = 'rp-join-email';

/**
 * The address a request was left with, kept in this browser so the page can
 * check on the request every time the link is opened again. Per browser by
 * nature: the link is what the person comes back to, on the device they
 * asked from.
 */
export function rememberedJoinEmail(): string | null {
  try {
    return localStorage.getItem(JOIN_EMAIL_KEY);
  } catch {
    return null;
  }
}

export function rememberJoinEmail(email: string | null): void {
  try {
    if (email) localStorage.setItem(JOIN_EMAIL_KEY, email);
    else localStorage.removeItem(JOIN_EMAIL_KEY);
  } catch {
    /* private mode: the request still went; they will type the address again */
  }
}
