import {
  createContext,
  useCallback,
  useMemo,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { type BookSummary } from '@readport/shared';
import { coverSrc } from '../lib/cover';
import { useT } from '../i18n';
import { IconClose } from './icons';
import {
  dragDismisses,
  dragOffset,
  NARROW_SHEET,
  SHEET_EASE_IN,
  SHEET_EASE_OUT,
  SHEET_EXIT_MS,
  SHEET_SETTLE_MS,
} from './sheetMotion';
import { Art, type ArtName } from './Art';
import clothOchre from '../assets/art/cloth-ochre.webp';
import clothOlive from '../assets/art/cloth-olive.webp';
import clothPlum from '../assets/art/cloth-plum.webp';
import clothSlate from '../assets/art/cloth-slate.webp';
import clothTerracotta from '../assets/art/cloth-terracotta.webp';
import clothWine from '../assets/art/cloth-wine.webp';

/* ----------------------------------------------------------------- Sheet */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog focus-trap Tab handling, extracted for direct testing. Wrapping
 * treats the DIALOG CONTAINER ITSELF as a boundary: when initial focus is
 * the container (tabIndex=-1), Shift+Tab wraps to the LAST focusable
 * control and Tab enters at the first - focus can never escape the dialog.
 */
export function trapTabFocus(
  e: { shiftKey: boolean; preventDefault: () => void },
  dialog: { contains: (n: Node | null) => boolean; focus: () => void },
  focusables: { focus: () => void }[],
  active: Node | null,
): void {
  if (focusables.length === 0) {
    e.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const atContainer = active === (dialog as unknown as Node);
  if (e.shiftKey) {
    if (atContainer || active === (first as unknown as Node) || !dialog.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (atContainer || active === (last as unknown as Node) || !dialog.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Focus trap for a modal surface: Tab cycles inside it, Escape closes, and
 * the control that opened it gets focus back. Shared by the Sheet and the
 * Drawer rather than copied, so the two can never drift apart.
 */
/**
 * Stop the page behind a dialog from scrolling.
 *
 * Without this, a flick anywhere on a sheet that is not itself scrollable
 * scrolls the library underneath it - so closing the sheet drops you
 * somewhere else entirely. Counted, because a sheet can open another one and
 * the first to close must not unlock the page for the second.
 */
let scrollLocks = 0;
let restoreOverflow = '';
let restorePaddingRight = '';

export function useScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    if (scrollLocks === 0) {
      const body = document.body;
      restoreOverflow = body.style.overflow;
      restorePaddingRight = body.style.paddingRight;
      // Removing the scrollbar shifts the layout under the dialog; hold the
      // width. Zero on the phones this mostly matters for, harmless anywhere.
      const gap = window.innerWidth - document.documentElement.clientWidth;
      if (gap > 0) body.style.paddingRight = `${gap}px`;
      body.style.overflow = 'hidden';
    }
    scrollLocks += 1;
    return () => {
      scrollLocks -= 1;
      if (scrollLocks === 0) {
        document.body.style.overflow = restoreOverflow;
        document.body.style.paddingRight = restorePaddingRight;
      }
    };
  }, [active]);
}

export function useFocusTrap(ref: { current: HTMLElement | null }, onClose: () => void): void {
  // The latest onClose lives in a ref so a parent re-render (the player
  // re-renders on every timeupdate) never re-runs the focus effect and
  // yanks focus away from the control the user is on.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A control inside the dialog may have used the key already - a grab
        // being cancelled, a rename being abandoned - and then the dialog
        // stays. Closing it as well threw away the list under the reader.
        if (!e.defaultPrevented) onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = ref.current;
      if (!dialog) return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      trapTabFocus(e, dialog, focusables, document.activeElement);
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog.
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [ref]);
}

/**
 * The open sheet's own way of closing: animated, as its close button's is.
 * For a control inside a sheet that closes it as a side effect - a link to a
 * shelf, say - which would otherwise pull it off the screen in one frame.
 */
const SheetCloseContext = createContext<(() => void) | null>(null);
export const useSheetClose = () => useContext(SheetCloseContext);

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrowSheet = () => typeof matchMedia === 'function' && matchMedia(NARROW_SHEET).matches;

/**
 * A bottom sheet on a phone, a card at the corner on anything wider.
 *
 * On a phone it rises out of the bottom edge and goes back down into it -
 * from the close button, Escape, a tap outside, or a finger: the handle and
 * the title row can be dragged, and a sheet let go of far enough down, or
 * flicked, closes; anything less settles back. The owner's `onClose` runs
 * once it has gone, so the owner never has to know it moved at all.
 */
export function Sheet({
  title,
  onClose,
  children,
  head,
  docked = false,
  closeRef,
  host,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** What stands in the head instead of the title: a row of tabs, say, that must stay put while the body scrolls. */
  head?: ReactNode;
  /**
   * On a phone, stands on the tab bar rather than over it, and reaches
   * nearly to the top: the tab bar stays in reach, in the sheet's colour,
   * so the button that opened the sheet can close it. For the shelves.
   */
  docked?: boolean;
  /** Filled with this sheet's own animated close, for a control outside it. */
  closeRef?: React.RefObject<(() => void) | null>;
  /**
   * Where the sheet is drawn, when not over everything: the docked shelves
   * go inside the app's own frame, so the tab bar - in the same frame - can
   * stand in front of them while they rise from behind it.
   */
  host?: Element | null;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const leaving = useRef(false);

  const close = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    const sheet = ref.current;
    if (!sheet || reducedMotion()) {
      onCloseRef.current();
      return;
    }
    const narrow = narrowSheet();
    // Whatever it is doing - arriving, or following a finger - it leaves
    // from where it is now.
    sheet.style.animation = 'none';
    sheet.style.transition = `transform ${SHEET_EXIT_MS}ms ${SHEET_EASE_OUT}, opacity ${SHEET_EXIT_MS}ms linear`;
    void sheet.offsetHeight;
    sheet.style.transform = narrow ? 'translateY(100%)' : 'translateY(24px)';
    if (!narrow) sheet.style.opacity = '0';
    const scrim = backdrop.current;
    if (scrim) {
      scrim.style.animation = 'none';
      scrim.style.pointerEvents = 'none';
      scrim.style.transition = `opacity ${SHEET_EXIT_MS}ms linear`;
      scrim.style.opacity = '0';
    }
    window.setTimeout(() => onCloseRef.current(), SHEET_EXIT_MS);
  }, []);

  useFocusTrap(ref, close);
  useScrollLock();
  useEffect(() => {
    if (!closeRef) return;
    closeRef.current = close;
    return () => {
      closeRef.current = null;
    };
  }, [closeRef, close]);

  // A finger on the handle or the title row. Followed directly - no React
  // render per move - and judged on letting go (sheetMotion.ts).
  const drag = useRef<{
    id: number;
    y: number;
    lastY: number;
    lastT: number;
    speed: number;
  } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || leaving.current || !narrowSheet()) return;
    if ((e.target as Element).closest('button, a, input, select, textarea, [role="tab"]')) return;
    const sheet = ref.current;
    if (!sheet) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      id: e.pointerId,
      y: e.clientY,
      lastY: e.clientY,
      lastT: e.timeStamp,
      speed: 0,
    };
    sheet.style.animation = 'none';
    sheet.style.transition = 'none';
    if (backdrop.current) {
      backdrop.current.style.animation = 'none';
      backdrop.current.style.transition = 'none';
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const sheet = ref.current;
    if (!d || e.pointerId !== d.id || !sheet) return;
    const dy = dragOffset(e.clientY - d.y);
    sheet.style.transform = `translateY(${dy}px)`;
    if (backdrop.current)
      backdrop.current.style.opacity = String(1 - Math.max(0, dy) / sheet.offsetHeight);
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.speed = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    const sheet = ref.current;
    if (!d || e.pointerId !== d.id || !sheet) return;
    drag.current = null;
    // A long pause before letting go is not a flick, whatever the last move was.
    const speed = e.timeStamp - d.lastT > 90 ? 0 : d.speed;
    if (dragDismisses(e.clientY - d.y, sheet.offsetHeight, speed)) {
      close();
      return;
    }
    sheet.style.transition = `transform ${SHEET_SETTLE_MS}ms ${SHEET_EASE_IN}`;
    sheet.style.transform = '';
    if (backdrop.current) {
      backdrop.current.style.transition = `opacity ${SHEET_SETTLE_MS}ms linear`;
      backdrop.current.style.opacity = '';
    }
  };
  const handle = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  };

  const panel = (
    <div
      className={`sheet${docked ? ' sheet--docked' : ''}`}
      role="dialog"
      // Docked, the tab bar beside it stays usable: not modal, then.
      aria-modal={docked ? undefined : 'true'}
      aria-label={title}
      tabIndex={-1}
      ref={ref}
    >
      <div className="sheet__grab" aria-hidden="true" {...handle} />
      <div
        className={`sheet__header${head ? ' sheet__header--tabs' : ''}`}
        {...(head ? {} : handle)}
      >
        {head ?? <span className="sheet__title">{title}</span>}
        <button className="icon-btn" onClick={close} aria-label={t('common.close')}>
          <IconClose />
        </button>
      </div>
      <SheetCloseContext.Provider value={close}>
        <div className="sheet__body">{children}</div>
      </SheetCloseContext.Provider>
    </div>
  );
  return createPortal(
    <>
      <div
        ref={backdrop}
        className={`sheet-backdrop${docked ? ' sheet-backdrop--docked' : ''}`}
        onClick={close}
        aria-hidden="true"
      />
      {panel}
    </>,
    host ?? document.body,
  );
}

/**
 * A panel that slides in from the inline start. Used at tablet widths where
 * the shelf rail does not fit but the book grid still needs its pixels; the
 * same content renders in the rail, in here, and in a Sheet on a phone.
 */
export function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  useScrollLock();
  return createPortal(
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="sheet__header">
          <span className="sheet__title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <IconClose />
          </button>
        </div>
        <div className="drawer__body">{children}</div>
      </div>
    </>,
    document.body,
  );
}

/* ----------------------------------------------------------------- Toast */

export interface ToastAction {
  label: string;
  onClick: () => void;
}
export interface ToastOptions {
  /**
   * Stays until the reader acts on it or closes it. For the one message
   * that is an offer rather than a report - another device is further
   * along, jump there? - which a person may want to consider after they
   * have read to the end of the paragraph, not within eight seconds.
   */
  sticky?: boolean;
}
interface ToastCtx {
  show: (msg: string, action?: ToastAction, opts?: ToastOptions) => void;
  /** Take the toast down, whatever it says: the surface that raised it is leaving. */
  dismiss: () => void;
}
const ToastContext = createContext<ToastCtx>({ show: () => {}, dismiss: () => {} });
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [toast, setToast] = useState<{
    msg: string;
    action?: ToastAction;
    sticky: boolean;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    setToast(null);
  }, []);
  const show = useCallback((msg: string, action?: ToastAction, opts?: ToastOptions) => {
    setToast({ msg, action, sticky: opts?.sticky === true });
    if (timer.current) clearTimeout(timer.current);
    timer.current = opts?.sticky
      ? undefined
      : setTimeout(() => setToast(null), action ? 8000 : 3200);
  }, []);
  const ctx = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={ctx}>
      {children}
      {toast &&
        createPortal(
          <div className="toast" role="status" aria-live="polite">
            <div>
              {toast.msg}
              {toast.action && (
                <button
                  className="toast__action"
                  onClick={() => {
                    toast.action?.onClick();
                    dismiss();
                  }}
                >
                  {toast.action.label}
                </button>
              )}
              {toast.sticky && (
                <button
                  className="toast__close"
                  type="button"
                  aria-label={t('common.dismiss')}
                  onClick={dismiss}
                >
                  <IconClose size={14} />
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

/* ----------------------------------------------------------------- Cover */

const COVER_TINTS = ['#8C3F1F', '#5E4A8A', '#2F4A5C', '#6B3A44', '#4E5A2E', '#8A6A2F'];
/**
 * The bookcloth a book with no cover of its own is bound in, one for each
 * tint and in the same order: terracotta with waves, plum with gulls, slate
 * with lighthouses, wine with anchors, olive with shells, ochre with stars.
 */
const COVER_CLOTHS = [clothTerracotta, clothPlum, clothSlate, clothWine, clothOlive, clothOchre];

export function Cover({
  book,
  className,
}: {
  book: Pick<BookSummary, 'id' | 'title' | 'author' | 'hasCover' | 'kind' | 'coverV'>;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  let hash = 0;
  for (const c of book.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const binding = hash % COVER_TINTS.length;
  const tint = COVER_TINTS[binding];

  if (book.hasCover && !failed) {
    return (
      <img
        // The book's own colour stands in until the cover arrives, and the
        // cover resolves out of it rather than replacing a blank rectangle.
        // Kept on the <img> itself: wrapping it would change the layout of
        // every place a cover appears.
        className={`cover-img ${loaded ? 'is-loaded' : ''} ${className ?? ''}`}
        style={{ backgroundColor: tint }}
        src={coverSrc(book)}
        alt=""
        loading="lazy"
        decoding="async"
        ref={(el) => {
          // Already in the cache: it is on screen this frame, so do not play
          // a transition for something that never looked any other way.
          if (el?.complete) setLoaded(true);
        }}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    );
  }
  // Bound in cloth, with the title on a paper label, the way a book with no
  // printed jacket has always carried its name.
  return (
    <span
      className={`book-card__fallback ${className ?? ''}`}
      style={
        {
          '--cover-tint': tint,
          '--cover-cloth': `url("${COVER_CLOTHS[binding]}")`,
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      <span className="book-card__label">
        <span className="book-card__label-title">{book.title}</span>
        {book.author && <span className="book-card__label-author">{book.author}</span>}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------ EmptyState */

export function EmptyState({
  icon,
  art,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  /** A print from the house set, in place of the icon. */
  art?: ArtName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`empty-state${art ? ' empty-state--art' : ''}`}>
      {art ? <Art name={art} /> : icon}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/* -------------------------------------------------------------- Segmented */

export function ChipRow<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="chip-row" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          className="chip"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
