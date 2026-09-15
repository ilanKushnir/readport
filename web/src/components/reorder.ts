import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useT } from '../i18n';

/**
 * Re-ordering a list, with the keyboard path as the PRIMARY mechanism and the
 * pointer path built on the same state machine. Drag is the alternative, not
 * the requirement: grab with Space, move with the arrows, drop with Space.
 *
 * The hook owns only order. What a drop means - one PATCH naming the item's
 * new neighbour - is the caller's `onCommit`.
 */

/** Move `id` so that it sits at `to` in the array. Pure, and the unit under test. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved!);
  return next;
}

/** The id an item now follows, or null when it is first. This is what the API wants. */
export function afterIdFor(ids: string[], id: string): string | null {
  const i = ids.indexOf(id);
  return i <= 0 ? null : ids[i - 1]!;
}

/**
 * Where a dragged row belongs, from where the OTHER rows are.
 *
 * The slot is the number of other rows whose middle is above the dragged
 * row's middle. Measured, not calculated from a fixed row height: rows with
 * a note are taller than rows without, the list has gaps between rows, and
 * a pitch multiplied by a count was one row out after five of them.
 */
export function slotFor(othersMidY: number[], draggedMidY: number): number {
  let slot = 0;
  for (const mid of othersMidY) if (mid < draggedMidY) slot += 1;
  return slot;
}

/**
 * How fast to scroll a list whose edge a drag is pressing against, in
 * pixels per frame: nothing outside the zone, and the deeper in, the faster.
 */
export function autoscrollSpeed(
  pointerY: number,
  top: number,
  bottom: number,
  zone: number,
  max = 18,
): number {
  if (pointerY < top + zone) return -Math.ceil(Math.min(1, (top + zone - pointerY) / zone) * max);
  if (pointerY > bottom - zone)
    return Math.ceil(Math.min(1, (pointerY - (bottom - zone)) / zone) * max);
  return 0;
}

export interface ReorderApi {
  /** The order to render: the live one while a grab is in progress. */
  ids: string[];
  /** The id being moved, or null. */
  grabbed: string | null;
  /** True while a pointer or touch drag is actually moving. */
  dragging: boolean;
  /**
   * Pixels to translate the grabbed row by so it stays under the finger. The
   * list renders in its live order, so the row is already in its new slot;
   * this is the difference between that slot and where the finger is.
   */
  offset: number;
  /** What a screen reader is told; also rendered in a live region. */
  announcement: string;
  /** Props for the drag handle of one row. */
  handleProps: (id: string) => {
    onKeyDown: (e: ReactKeyboardEvent) => void;
    onPointerDown: (e: ReactPointerEvent) => void;
    onContextMenu: (e: ReactPointerEvent | { preventDefault: () => void }) => void;
    onBlur: () => void;
    'aria-pressed': boolean;
    'aria-label': string;
    'aria-describedby'?: string;
  };
  /** The overflow menu's four moves - the fastest route from 20th to 1st. */
  moveTo: (id: string, to: 'top' | 'up' | 'down' | 'bottom') => void;
  /** Register the DOM node of a row so drag distances can be measured. */
  register: (id: string, el: HTMLElement | null) => void;
}

/** How far a finger must travel before a press becomes a grab. */
const TOUCH_DRAG_THRESHOLD_PX = 8;
/** The band along a scroller's edge that scrolls it while a drag sits there. */
const AUTOSCROLL_ZONE_PX = 64;
/** The phone tab bar covers the last of the main pane; the band sits above it. */
const PHONE_TABBAR_PX = 96;

/** The translateY a row is currently rendered with, transition and all. */
function renderedShift(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  try {
    return new DOMMatrix(t).m42;
  } catch {
    return 0;
  }
}

function scrollOwnerOf(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
  return node;
}

export function useReorder(opts: {
  ids: string[];
  /** What each row is called, for the announcements. */
  labelOf: (id: string) => string;
  /** Persist the new order. `afterId` is null when the item became first. */
  onCommit: (id: string, afterId: string | null, ids: string[]) => void;
  /** Reordering is off while the server is unreachable. */
  disabled?: boolean;
}): ReorderApi {
  const { ids: source, labelOf, onCommit, disabled } = opts;
  const t = useT();
  const [live, setLive] = useState<string[] | null>(null);
  const [grabbed, setGrabbed] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [offset, setOffset] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const original = useRef<string[]>([]);
  const nodes = useRef(new Map<string, HTMLElement>());
  const pointer = useRef<{
    id: string;
    pointerId: number;
    handle: HTMLElement | null;
    startY: number;
    /** Where the row's middle and top were, on screen, when it was picked up. */
    startMidY: number;
    startTop: number;
    /** The finger's last known position, for frames the finger does not move in. */
    lastY: number;
  } | null>(null);
  /** Whether this gesture has passed the threshold and become a real grab. */
  const begunRef = useRef(false);
  const grabbedRef = useRef<string | null>(null);
  grabbedRef.current = grabbed;

  const ids = live ?? source;
  const idsRef = useRef(ids);
  idsRef.current = ids;

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  }, []);

  const say = useCallback(
    (id: string, how: 'dropped' | 'left' | 'moved', list: string[]) => {
      const at = list.indexOf(id) + 1;
      setAnnouncement(
        t(`shell.reorder.${how}` as const, { label: labelOf(id), at, total: list.length }),
      );
    },
    [labelOf, t],
  );

  const begin = useCallback(
    (id: string) => {
      if (disabled) return;
      original.current = idsRef.current.slice();
      setLive(idsRef.current.slice());
      setGrabbed(id);
      const at = idsRef.current.indexOf(id) + 1;
      setAnnouncement(
        t('shell.reorder.grabbed', { label: labelOf(id), at, total: idsRef.current.length }),
      );
    },
    [disabled, labelOf, t],
  );

  const drop = useCallback(
    (id: string) => {
      const list = idsRef.current;
      setGrabbed(null);
      setDragging(false);
      setOffset(0);
      setLive(null);
      const before = original.current;
      // A separator no id can contain, written as an ESCAPE. A literal NUL
      // byte in the source makes the file count as binary, so diffs stop
      // rendering and nobody reviews a change to it again.
      const SEP = '\u0000';
      if (before.join(SEP) !== list.join(SEP)) {
        onCommit(id, afterIdFor(list, id), list);
        say(id, 'dropped', list);
      } else {
        say(id, 'left', list);
      }
    },
    [onCommit, say],
  );

  const cancel = useCallback(
    (id: string) => {
      setLive(null);
      setGrabbed(null);
      setDragging(false);
      setOffset(0);
      setAnnouncement(t('shell.reorder.cancelled', { label: labelOf(id) }));
    },
    [labelOf, t],
  );

  const shift = useCallback((id: string, to: number) => {
    setLive((cur) => {
      const list = cur ?? idsRef.current;
      const next = moveItem(list, list.indexOf(id), to);
      idsRef.current = next;
      return next;
    });
  }, []);

  const moveTo = useCallback(
    (id: string, where: 'top' | 'up' | 'down' | 'bottom') => {
      if (disabled) return;
      const list = idsRef.current;
      const from = list.indexOf(id);
      if (from < 0) return;
      const to =
        where === 'top'
          ? 0
          : where === 'bottom'
            ? list.length - 1
            : where === 'up'
              ? Math.max(0, from - 1)
              : Math.min(list.length - 1, from + 1);
      if (to === from) return;
      const next = moveItem(list, from, to);
      idsRef.current = next;
      onCommit(id, afterIdFor(next, id), next);
      say(id, 'moved', next);
    },
    [disabled, onCommit, say],
  );

  const handleProps = useCallback(
    (id: string) => ({
      'aria-pressed': grabbed === id,
      'aria-label': t('shell.reorder.handle', {
        label: labelOf(id),
        at: ids.indexOf(id) + 1,
        total: ids.length,
      }),
      onKeyDown: (e: ReactKeyboardEvent) => {
        if (disabled) return;
        const list = idsRef.current;
        const at = list.indexOf(id);
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          if (grabbed === id) drop(id);
          else begin(id);
          return;
        }
        if (grabbed !== id) return;
        if (e.key === 'Escape') {
          // Handled here, and said so: a dialog holding this list closes on
          // Escape too, and must not when the key meant "put it back".
          e.preventDefault();
          e.stopPropagation();
          cancel(id);
        } else if (e.key === 'ArrowUp' && at > 0) {
          e.preventDefault();
          shift(id, at - 1);
          say(id, 'moved', moveItem(list, at, at - 1));
        } else if (e.key === 'ArrowDown' && at < list.length - 1) {
          e.preventDefault();
          shift(id, at + 1);
          say(id, 'moved', moveItem(list, at, at + 1));
        } else if (e.key === 'Home' && at > 0) {
          e.preventDefault();
          shift(id, 0);
          say(id, 'moved', moveItem(list, at, 0));
        } else if (e.key === 'End' && at < list.length - 1) {
          e.preventDefault();
          shift(id, list.length - 1);
          say(id, 'moved', moveItem(list, at, list.length - 1));
        }
      },
      // A keyboard grab that loses focus - a tap elsewhere, a tab away - is
      // left where it was, rather than holding the list open indefinitely.
      onBlur: () => {
        if (grabbedRef.current === id && !pointer.current) cancel(id);
      },
      onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
      onPointerDown: (e: ReactPointerEvent) => {
        if (disabled || e.button !== 0) return;
        const handle = e.currentTarget as HTMLElement;
        handle.setPointerCapture?.(e.pointerId);
        // A mouse press that is not prevented starts a text selection across
        // the rows as the drag goes on; a finger's press is left alone so the
        // sheet the list is in can still be scrolled from the grip.
        if (e.pointerType === 'mouse') {
          e.preventDefault();
          window.getSelection?.()?.removeAllRanges();
        }
        const row = nodes.current.get(id);
        const rect = row?.getBoundingClientRect();
        const shiftNow = row ? renderedShift(row) : 0;
        pointer.current = {
          id,
          pointerId: e.pointerId,
          handle,
          startY: e.clientY,
          lastY: e.clientY,
          startMidY: rect ? rect.top - shiftNow + rect.height / 2 : e.clientY,
          startTop: rect ? rect.top - shiftNow : e.clientY,
        };
        // A mouse press on a drag handle is unambiguous. A finger is not: the
        // same press starts a scroll of the sheet the list is in, so grabbing
        // on touch-down meant scrolling the Shelves sheet with a thumb
        // silently reordered the reader's shelves. Wait for real movement.
        begunRef.current = e.pointerType === 'mouse';
        if (begunRef.current) begin(id);
        setDragging(true);
      },
    }),
    [begin, cancel, disabled, drop, grabbed, ids, labelOf, say, shift, t],
  );

  // The pointer drag lives on the document so a fast gesture that leaves the
  // handle keeps working, and so the drop happens even if the row unmounts.
  useEffect(() => {
    if (!dragging) return;
    document.body.setAttribute('data-rp-dragging', '');
    let raf = 0;
    let scroller: HTMLElement | null = null;

    /** Place the row under the finger and put it in the slot it is over. */
    const update = () => {
      const p = pointer.current;
      if (!p || !begunRef.current) return;
      const dy = p.lastY - p.startY;
      const list = idsRef.current;
      const at = list.indexOf(p.id);
      // The slot is where the finger has carried the row's middle, measured
      // against where the other rows are NOW - whatever their heights, the
      // gaps between them, and however far the list has scrolled meanwhile.
      const midY = p.startMidY + dy;
      const others: number[] = [];
      for (const other of list) {
        if (other === p.id) continue;
        const r = nodes.current.get(other)?.getBoundingClientRect();
        if (r) others.push(r.top + r.height / 2);
      }
      const target = Math.max(0, Math.min(list.length - 1, slotFor(others, midY)));
      if (target !== at) shift(p.id, target);
      // The row renders in its slot; the offset is what is left to reach the
      // finger. Measured from where the row is laid out, not where a
      // half-finished transition has it.
      const row = nodes.current.get(p.id);
      if (row) {
        const rect = row.getBoundingClientRect();
        const laidOutTop = rect.top - renderedShift(row);
        setOffset(p.startTop + dy - laidOutTop);
      } else {
        setOffset(dy);
      }
    };

    /**
     * Edge scrolling, on a frame loop rather than on pointer events: a finger
     * held still at the bottom of the list used to scroll it exactly once,
     * by twelve pixels, and then wait for the finger to twitch.
     */
    const frame = () => {
      raf = 0;
      const p = pointer.current;
      if (!p || !begunRef.current) return;
      scroller ??= scrollOwnerOf(nodes.current.get(p.id) ?? null);
      const bounds = scroller?.getBoundingClientRect();
      const top = bounds?.top ?? 0;
      const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 743px)').matches;
      const bottom = (bounds?.bottom ?? window.innerHeight) - (phone ? PHONE_TABBAR_PX : 0);
      const speed = autoscrollSpeed(p.lastY, top, bottom, AUTOSCROLL_ZONE_PX);
      if (speed !== 0) {
        (scroller ?? window).scrollBy({ top: speed });
        update();
      }
      raf = requestAnimationFrame(frame);
    };

    const onMove = (e: PointerEvent) => {
      const p = pointer.current;
      if (!p || e.pointerId !== p.pointerId) return;
      p.lastY = e.clientY;
      const dy = e.clientY - p.startY;
      // Below the threshold this is still a scroll, not a grab.
      if (!begunRef.current) {
        if (Math.abs(dy) < TOUCH_DRAG_THRESHOLD_PX) return;
        begunRef.current = true;
        begin(p.id);
        if (!raf) raf = requestAnimationFrame(frame);
      }
      update();
    };
    const finish = (how: 'drop' | 'cancel') => {
      const p = pointer.current;
      pointer.current = null;
      const begun = begunRef.current;
      begunRef.current = false;
      try {
        if (p?.handle?.hasPointerCapture?.(p.pointerId))
          p.handle.releasePointerCapture(p.pointerId);
      } catch {
        /* already released */
      }
      if (!p) {
        setDragging(false);
        return;
      }
      if (!begun) setDragging(false);
      else if (how === 'drop') drop(p.id);
      else cancel(p.id);
    };
    const onUp = (e: PointerEvent) => {
      if (pointer.current && e.pointerId !== pointer.current.pointerId) return;
      finish('drop');
    };
    const onCancel = (e: PointerEvent) => {
      if (pointer.current && e.pointerId !== pointer.current.pointerId) return;
      finish('cancel');
    };
    // Escape during a pointer drag puts the row back. It used to reach only
    // a focused handle, and a finger never focuses one.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish('cancel');
    };
    const onAway = () => finish('cancel');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onAway);
    if (begunRef.current && !raf) raf = requestAnimationFrame(frame);
    return () => {
      document.body.removeAttribute('data-rp-dragging');
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onAway);
    };
  }, [begin, cancel, dragging, drop, shift]);

  return useMemo(
    () => ({
      ids,
      grabbed,
      dragging,
      offset,
      announcement,
      handleProps,
      moveTo,
      register,
    }),
    [ids, grabbed, dragging, offset, announcement, handleProps, moveTo, register],
  );
}
