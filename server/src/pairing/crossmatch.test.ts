import { describe, expect, it } from 'vitest';
import { CANDIDATE_THRESHOLD, chooseRivalPairs, scorePair } from './score.js';

/**
 * The wrong book, suggested with confidence.
 *
 * Two books by one author, both owned in both formats: "Tenfold Harvests"
 * (ebook) was offered as a match for "Tenfold Cellars" (audiobook) at 61%,
 * with a green tick beside the length ratio, so the shelf showed the two
 * correct pairs and the two crossed ones, indistinguishable at a glance.
 * (Invented titles, as every book in these tests is.)
 *
 * Three things went wrong together and all three are pinned here:
 *  - sharing an author was worth a quarter of the score, when someone who
 *    owns a dozen books by one writer scores 100% on every wrong combination;
 *  - a length ratio of 0.56 — an audiobook half as long as the text implies —
 *    passed a band that ran from 0.55 to 1.9 and scored full marks;
 *  - nothing made the candidates compete, so one file could be suggested
 *    against several others at once.
 */

/** ~360k characters: a practical book of a few hundred pages. */
const HARVESTS_CHARS = 360_000;
const CELLARS_CHARS = 300_000;
/** A short narration: under four hours, well below what the text implies. */
const CELLARS_AUDIO_MS = (3 * 3600 + 41 * 60 + 15) * 1000;
const HARVESTS_AUDIO_MS = Math.round((HARVESTS_CHARS / 16.5) * 1000);

const ebook = (title: string, totalChars: number) => ({
  title,
  author: 'Tobiah Quenell',
  language: null,
  series: null,
  identifiers: {},
  totalChars,
});
const audio = (title: string, durationMs: number) => ({
  title,
  author: 'Tobiah Quenell',
  language: null,
  series: null,
  identifiers: {},
  durationMs,
});

const HARVESTS_E = ebook('Tenfold Harvests: How to Plan an Orchard That Pays for Itself', HARVESTS_CHARS);
const CELLARS_E = ebook(
  'Tenfold Cellars: How to Store a Season So Nothing Goes to Waste',
  CELLARS_CHARS,
);
const HARVESTS_A = audio(
  'Tenfold Harvests: How to Plan an Orchard That Pays for Itself',
  HARVESTS_AUDIO_MS,
);
const CELLARS_A = audio(
  'Tenfold Cellars: How to Store a Season So Nothing Goes to Waste',
  CELLARS_AUDIO_MS,
);

describe('two books by one author, both owned in both formats', () => {
  it('does not suggest Harvests against the Cellars narration', () => {
    const { score, evidence } = scorePair({ ebook: HARVESTS_E, audio: CELLARS_A });
    // It used to score 0.61 against a 0.55 bar.
    expect(score).toBeLessThan(CANDIDATE_THRESHOLD);
    expect(evidence.titleScore).toBeLessThan(0.5);
    // The author agreeing perfectly must not be what carries it.
    expect(evidence.authorScore).toBe(1);
  });

  it('still recognises each book against its own narration', () => {
    for (const [e, a] of [
      [HARVESTS_E, HARVESTS_A],
      [CELLARS_E, CELLARS_A],
    ] as const) {
      const { score } = scorePair({ ebook: e, audio: a });
      expect(score).toBeGreaterThan(0.85);
    }
  });

  it('scores the right pair far above the crossed one', () => {
    const right = scorePair({ ebook: HARVESTS_E, audio: HARVESTS_A }).score;
    const crossed = scorePair({ ebook: HARVESTS_E, audio: CELLARS_A }).score;
    expect(right - crossed).toBeGreaterThan(0.3);
  });

  it('says why, rather than just scoring low', () => {
    const { evidence } = scorePair({ ebook: HARVESTS_E, audio: CELLARS_A });
    expect(evidence.notes.join(' ')).toMatch(/titles are too different/i);
  });
});

describe('length ratio', () => {
  it('no longer treats an audiobook half the implied length as agreement', () => {
    // 0.56x used to score a full 1.0 and show a tick.
    const { evidence } = scorePair({ ebook: HARVESTS_E, audio: CELLARS_A });
    expect(evidence.durationPagesRatio).toBeLessThan(0.7);
    expect(evidence.notes.join(' ')).toMatch(/shorter than the text suggests/i);
  });

  it('still tolerates a brisk or a slow narrator of the same book', () => {
    for (const pace of [0.85, 1.0, 1.2]) {
      const { score } = scorePair({
        ebook: HARVESTS_E,
        audio: audio(HARVESTS_E.title, Math.round((HARVESTS_CHARS / 16.5) * 1000 * pace)),
      });
      expect(score, `pace ${pace}`).toBeGreaterThan(0.85);
    }
  });
});

describe('chooseRivalPairs', () => {
  const p = (ebookId: string, audioId: string, score: number) => ({
    ebookId,
    audioId,
    score,
    item: `${ebookId}~${audioId}`,
  });
  const kept = (out: { item: string }[]) => out.map((x) => x.item).sort();

  it('drops the crossed pairs and keeps the right ones', () => {
    // Exactly that shelf: two books, both owned twice.
    const out = chooseRivalPairs([
      p('harvests-e', 'harvests-a', 0.95),
      p('cellars-e', 'cellars-a', 0.94),
      p('harvests-e', 'cellars-a', 0.61),
      p('cellars-e', 'harvests-a', 0.6),
    ]);
    expect(kept(out)).toEqual(['cellars-e~cellars-a', 'harvests-e~harvests-a']);
  });

  it('keeps both when two are a genuine toss-up', () => {
    // Two editions of the same book — a reissue, a boxed set — score within a
    // hair of each other, and a person should be shown both.
    const out = chooseRivalPairs([p('e1', 'a1', 0.93), p('e1', 'a2', 0.91)]);
    expect(kept(out)).toEqual(['e1~a1', 'e1~a2']);
  });

  it('offers nothing for a book that is already linked', () => {
    const out = chooseRivalPairs([p('e1', 'a1', 0.9), p('e1', 'a2', 0.89)], {
      settledEbooks: new Set(['e1']),
    });
    expect(out).toEqual([]);
  });

  it('leaves an audiobook alone once it belongs to something', () => {
    const out = chooseRivalPairs([p('e1', 'a1', 0.9), p('e2', 'a1', 0.88)], {
      settledAudios: new Set(['a1']),
    });
    expect(out).toEqual([]);
  });

  it('keeps a lone suggestion that has no rival at all', () => {
    expect(kept(chooseRivalPairs([p('e1', 'a1', 0.7)]))).toEqual(['e1~a1']);
  });

  it('lets a weaker pair through when the leader wants a different partner', () => {
    // a1 is e1's best. e2 has only a2, more weakly — that is still e2's and
    // a2's own best, so it survives on its own merits.
    const out = chooseRivalPairs([p('e1', 'a1', 0.95), p('e2', 'a2', 0.7)]);
    expect(kept(out)).toEqual(['e1~a1', 'e2~a2']);
  });

  it('handles an empty shelf', () => {
    expect(chooseRivalPairs([])).toEqual([]);
  });
});
