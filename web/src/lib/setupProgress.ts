import type { JobCount } from '@readport/shared';

/**
 * How far the first run has got, from the job totals.
 *
 * Two things make this less obvious than counting rows.
 *
 * `/api/jobs` returns only the newest 100 jobs. Indexing queues one job per
 * book, so on any library worth setting up the oldest job — the scan itself —
 * is pushed out of that window, and a client looking for it finds nothing.
 * The totals cover the whole table, so they are what this reads.
 *
 * And "set up" does not include alignment. An align job is queued the moment a
 * book is paired with its audio, and each one runs for minutes; treating them
 * as setup work leaves the wizard on "Reading your shelves" forever on exactly
 * the libraries it was written for. Reading and listening both work before a
 * single alignment finishes.
 */
export interface SetupProgress {
  /** Scanning and indexing have finished; alignment may still be running. */
  done: boolean;
  /** 0–100, by books indexed — the part of the wait a person actually feels. */
  percent: number;
  /** Index jobs still queued or running. */
  indexing: number;
  /** Alignments left to run in the background once setup is done. */
  aligningLater: number;
}

const PENDING = new Set(['queued', 'running']);

/** Scan, pairing and indexing are setup. Alignment is not — see above. */
function isSetupWork(type: string): boolean {
  return type === 'scan' || type === 'pair-scan' || type.startsWith('index');
}

export function setupProgress(
  totals: readonly JobCount[],
  hasRoots: boolean,
  /** Fallback while the scan job is still the only thing that exists. */
  scanProgress = 0.05,
): SetupProgress {
  const sum = (match: (c: JobCount) => boolean) =>
    totals.reduce((n, c) => (match(c) ? n + c.count : n), 0);
  const pending = (c: JobCount) => PENDING.has(c.state);

  const setupPending = sum((c) => isSetupWork(c.type) && pending(c));
  const scanFinished = sum((c) => c.type === 'scan' && !pending(c)) > 0;
  const indexTotal = sum((c) => c.type.startsWith('index'));
  const indexDone = sum((c) => c.type.startsWith('index') && !pending(c));

  const done = hasRoots && scanFinished && setupPending === 0;

  return {
    done,
    percent: done
      ? 100
      : indexTotal > 0
        ? Math.round((indexDone / indexTotal) * 100)
        : Math.round(scanProgress * 100),
    indexing: sum((c) => c.type.startsWith('index') && pending(c)),
    aligningLater: sum((c) => c.type === 'align' && pending(c)),
  };
}
