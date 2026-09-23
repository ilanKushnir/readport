/** `0.9.7` sorts below `0.13.0`: numerically, per part, never as strings. */
export function olderThan(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false; // unparseable: say nothing
    if (x !== y) return x < y;
  }
  return false;
}
