/**
 * A quotation on its way out of the reader.
 *
 * What is shared is a message, not a passage: someone reading it in a chat
 * gets the gist and a link, not two screens of text. So the quote is cut to
 * about a paragraph, at a word, with an ellipsis that says it was cut.
 */

/** About four sentences: enough to be worth sending, short enough to be read where it lands. */
export const QUOTE_MAX = 600;

/** The quote as it should read in a message: one line of prose, trimmed at a word. */
export function trimQuote(text: string, max = QUOTE_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const cut = head.lastIndexOf(' ');
  // A cut that would throw away most of the room is a cut through a very
  // long token, and the token is cut instead.
  const kept = cut > max * 0.6 ? head.slice(0, cut) : head;
  return `${kept.replace(/[\s,;:-]+$/, '')}…`;
}
