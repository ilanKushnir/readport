/**
 * Asking for the What's new dialog after it has been dismissed.
 *
 * The dialog belongs to the shell and decides on its own when to appear;
 * the version at the foot of Settings is the one other way in, for the
 * person who dismissed it on the way to a book and wants to read it now.
 */
export const WHATS_NEW_EVENT = 'rp:whatsnew';

export function openWhatsNew(): void {
  document.dispatchEvent(new CustomEvent(WHATS_NEW_EVENT));
}
