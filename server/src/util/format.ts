/**
 * Bytes in the unit a person would use.
 *
 * Same units and precision as the web client's formatter so the two never
 * disagree about the size of the same file - a 317 MB model reported as
 * "0.29 GB of 0.30 GB" reads like nothing is happening.
 */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
