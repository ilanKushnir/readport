/**
 * How well an audiobook's running time agrees with the length of the text.
 *
 * One definition, because the scorer and the card that explains the score
 * disagreed: a ratio of 0.56 — an audiobook barely half as long as the text
 * implies — earned full marks from the scorer AND a green tick on the card,
 * next to a title agreement of 37%. The band it passed (0.55–1.9) was wide
 * enough to admit a different book by the same author.
 *
 * The ratio is `actual audio ms ÷ ms the text would take to narrate`. Editions
 * vary, narrators vary, and front/back matter is not always in both — so this
 * is generous around 1.0 and falls away steeply outside it, rather than being
 * a cliff at an arbitrary edge.
 */

/** Ratios inside this are unremarkable: normal edition-to-edition variation. */
export const LENGTH_RATIO_GOOD = { min: 0.8, max: 1.25 } as const;

/** 0–1: how much the running time supports these being the same work. */
export function lengthRatioScore(ratio: number): number {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return 0.5; // unknown, not evidence
  if (ratio >= LENGTH_RATIO_GOOD.min && ratio <= LENGTH_RATIO_GOOD.max) return 1;
  // Symmetric in log space: half as long is exactly as suspicious as twice.
  const drift = Math.abs(
    Math.log(ratio / (ratio < 1 ? LENGTH_RATIO_GOOD.min : LENGTH_RATIO_GOOD.max)),
  );
  // Scaled so agreement runs out around 0.6x / 1.7x — beyond that the two
  // are not the same work unabridged, whatever the metadata says.
  return Math.max(0, 1 - drift / 0.29);
}

/**
 * Whether to show this ratio as agreement or as a warning.
 *
 * Derived from the score rather than a second band of its own, so the card
 * can never contradict the number it is explaining — which is exactly what
 * it did when a 0.56 ratio earned a tick beside a 37% title.
 */
export function lengthRatioOk(ratio: number): boolean {
  return lengthRatioScore(ratio) >= 0.5;
}

/**
 * Titles must agree for two files to be the same book.
 *
 * Below this, nothing else can carry the pair. Sharing an author is not
 * evidence when you own a dozen books by them — it is true of every wrong
 * combination as well as the right one — and it was worth a quarter of the
 * score, enough to push "$100M Leads" and "$100M Offers" over the line
 * together at 61%.
 */
export const TITLE_FLOOR = 0.5;
