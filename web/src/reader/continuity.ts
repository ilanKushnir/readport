export interface ReadingPoint {
  spineIdx: number;
  charOffset: number;
}
export type JumpReason =
  | 'toc'
  | 'search'
  | 'bookmark'
  | 'slider'
  | 'link'
  | 'progression'
  | 'resume'
  | 'narration'
  | 'return';
export interface ReturnPoint {
  origin: ReadingPoint & { label: string };
  destination: ReadingPoint;
}
export function landingOffset(
  target: { charOffset?: number; sentenceId?: string },
  sentences: { id: string; start: number }[],
): number {
  return target.charOffset ?? sentences.find((s) => s.id === target.sentenceId)?.start ?? 0;
}
export function returnAfterJump(
  origin: ReturnPoint['origin'],
  destination: ReadingPoint,
  reason: JumpReason,
): ReturnPoint | null {
  if (!['toc', 'search', 'bookmark', 'slider', 'link'].includes(reason) || origin.spineIdx < 0)
    return null;
  if (
    origin.spineIdx === destination.spineIdx &&
    Math.abs(origin.charOffset - destination.charOffset) < 1000
  )
    return null;
  return { origin, destination };
}
export function continuedAtDestination(point: ReturnPoint, current: ReadingPoint): boolean {
  return (
    current.spineIdx !== point.destination.spineIdx ||
    Math.abs(current.charOffset - point.destination.charOffset) >= 400
  );
}
export function markerOpacity(origin: ReadingPoint, current: ReadingPoint): number {
  if (origin.spineIdx !== current.spineIdx) return 0;
  return Math.max(0, 1 - Math.max(0, Math.abs(origin.charOffset - current.charOffset) - 80) / 600);
}
export function checkpointDue(last: number, now: number, changed: boolean): boolean {
  return changed && now - last >= 3000;
}

export interface AudioReturnPoint {
  originMs: number;
  destinationMs: number;
}
export function audioReturnAfterJump(
  originMs: number,
  destinationMs: number,
  reason: JumpReason,
): AudioReturnPoint | null {
  if (!['toc', 'search', 'bookmark', 'slider', 'link'].includes(reason)) return null;
  if (
    !Number.isFinite(originMs) ||
    originMs < 0 ||
    !Number.isFinite(destinationMs) ||
    Math.abs(destinationMs - originMs) <= 90000
  )
    return null;
  return { originMs, destinationMs };
}
export function audioContinued(point: AudioReturnPoint, currentMs: number): boolean {
  return Math.abs(currentMs - point.destinationMs) >= 30000;
}
