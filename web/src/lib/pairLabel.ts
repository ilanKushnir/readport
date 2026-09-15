import { type HandoffStatus, type PairStatus } from '@readport/shared';
import { type MessageKey } from '../i18n/messages/en';
import { type MessageValues } from '../i18n/format';

/**
 * A sentence for the interface to say, as its catalog key and the values it
 * needs. Translated where it is shown: `t(message.key, message.values)`.
 */
export interface PairMessage {
  key: MessageKey;
  values?: MessageValues;
}

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
}): PairMessage {
  if (pair.switchable && pair.handoff) {
    return {
      key: 'library.pair.handoffReady',
      values: {
        pct: Math.round(Math.min(1, Math.max(0, pair.handoff.exactSentenceCoverage)) * 100),
      },
    };
  }
  if (pair.status === 'candidate') {
    return { key: 'library.pair.candidate' };
  }
  return { key: 'library.pair.linkedUnaligned' };
}

/**
 * Pairing-page copy for a linked-but-unaligned pair. With no alignment the
 * resolver returns nothing at all (granularity 'none'), so switching is
 * UNAVAILABLE - it is never "approximate", and the UI must not claim any
 * accuracy.
 */
export const UNALIGNED_PAIR_NOTE: MessageKey = 'library.pair.unalignedNote';

/** Manual-link sheet copy; same honesty rule as UNALIGNED_PAIR_NOTE. */
export const MANUAL_LINK_NOTE: MessageKey = 'library.pair.manualLinkNote';

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
): PairMessage {
  const values = { kind: isEbook ? 'ebook' : 'audio' };
  if (!pair.switchable || !pair.handoff) {
    return { key: 'library.pair.switchUnaligned', values };
  }
  // Most sentences land exactly: worth saying plainly, because it is the
  // thing that makes reading and listening interchangeable.
  if (pair.handoff.exactSentenceCoverage >= 0.6) {
    return { key: 'library.pair.switchExact', values };
  }
  // Otherwise be straight about it rather than calling it ready.
  return { key: 'library.pair.switchClose', values };
}
