import { type HandoffStatus, type PairStatus } from '@readport/shared';
import { formatPct } from './format';

/**
 * Honest paired-edition status line. Claims are grounded in what the
 * alignment actually provides:
 *  - switchable + handoff: quotes the measured exact-sentence coverage.
 *  - candidate: a possible match awaiting review.
 *  - linked but not yet aligned: switching is UNAVAILABLE until alignment
 *    exists - no accuracy of any kind is promised (a linked pair without an
 *    alignment cannot resolve positions at all).
 */
export function pairStatusLabel(pair: {
  status: PairStatus;
  switchable: boolean;
  handoff: HandoffStatus | null;
}): string {
  if (pair.switchable && pair.handoff) {
    return `Read/listen handoff is ready - ${formatPct(
      pair.handoff.exactSentenceCoverage,
    )} of sentences switch exactly; the rest is approximate or unavailable.`;
  }
  if (pair.status === 'candidate') {
    return 'A possible matching edition was found - review it in Pairing.';
  }
  return 'Paired edition linked. Switching between text and audio is unavailable until alignment completes.';
}

/**
 * Pairing-page copy for a linked-but-unaligned pair. With no alignment the
 * resolver returns nothing at all (granularity 'none'), so switching is
 * UNAVAILABLE - it is never "approximate", and the UI must not claim any
 * accuracy.
 */
export const UNALIGNED_PAIR_NOTE =
  'Not aligned yet - switching between editions is unavailable until alignment completes.';

/** Manual-link sheet copy; same honesty rule as UNALIGNED_PAIR_NOTE. */
export const MANUAL_LINK_NOTE =
  'Choose an ebook and an audiobook of the same work. Alignment runs after linking; switching between editions is unavailable until alignment completes.';

/**
 * What switching between the two editions will actually do, in one sentence.
 *
 * The book page used to head this "Sync ready" and then, underneath, admit
 * that 4% of sentences switch exactly. Both halves were true and together
 * they said nothing: "sync" is a word this app invented, and a reader cannot
 * tell what "ready" promises when the next clause takes most of it back.
 *
 * So: no invented nouns, no percentage in the headline, and the sentence says
 * what happens rather than what state something is in. The number is still
 * available - on the Pairing page, where someone is judging the match.
 */
export function switchNote(
  pair: { status: PairStatus; switchable: boolean; handoff: HandoffStatus | null },
  isEbook: boolean,
): string {
  const other = isEbook ? 'the audiobook' : 'the ebook';
  if (!pair.switchable || !pair.handoff) {
    return `You own ${other} too. Timing the two together has not finished, so moving between them will start at the beginning for now.`;
  }
  // Most sentences land exactly: worth saying plainly, because it is the
  // thing that makes reading and listening interchangeable.
  if (pair.handoff.exactSentenceCoverage >= 0.6) {
    return `You own ${other} too, and switching between them picks up at the same sentence.`;
  }
  // Otherwise be straight about it rather than calling it ready.
  return `You own ${other} too. Switching lands close to where you are, though not always on the exact sentence.`;
}
