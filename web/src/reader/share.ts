/**
 * A quotation on its way out of the reader.
 *
 * What is shared is a message, not a passage: someone reading it in a chat
 * gets the gist and a link, not two screens of text. So the quote is cut to
 * about a paragraph, at a word, with an ellipsis that says it was cut.
 */

/**
 * A ceiling, not a target: a selection is sent whole, because a reader who
 * chose a passage wants the passage to arrive. The cap only stops a
 * runaway selection of a chapter from being handed to a share tray.
 */
export const QUOTE_MAX = 20_000;

/** The quote as it should read in a message: paragraphs kept, runs of space collapsed, cut at a word only past the ceiling. */
export function trimQuote(text: string, max = QUOTE_MAX): string {
  const clean = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const cut = head.lastIndexOf(' ');
  // A cut that would throw away most of the room is a cut through a very
  // long token, and the token is cut instead.
  const kept = cut > max * 0.6 ? head.slice(0, cut) : head;
  return `${kept.replace(/[\s,;:-]+$/, '')}…`;
}
