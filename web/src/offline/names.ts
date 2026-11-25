/**
 * The cache a downloaded book is kept in: written by the download manager,
 * read by the service worker (public/sw.js, which names it again - the two
 * must agree), and amended by the marks on their way out (marks/outbox.ts).
 * On its own so that naming the cache does not load the download manager.
 */
export const OFFLINE_CACHE = 'rp-offline-v1';
