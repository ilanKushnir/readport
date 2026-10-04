/**
 * What a key press on a page of the app is for: the page's own shortcut, or
 * something the browser, the system or a focused control should have.
 *
 * Shared by the reader and the player, whose shortcuts are single keys -
 * Space, the arrows - that the rest of the page also has uses for.
 */

/**
 * Elements that took the focus from a pointer - clicked, tapped, dragged -
 * rather than from the keyboard.
 *
 * The browser's own judgement (`:focus-visible`) cannot be asked at the
 * moment it matters: Chrome counts any key pressed while an element has the
 * focus as keyboard use, so by the time a keydown arrives every focused
 * button and slider claims to have been reached from the keyboard. How the
 * focus arrived is recorded when it arrives instead.
 */
const pointerFocused = new WeakSet<EventTarget>();
let lastPointerDownAt = -Infinity;
let lastKeyDownAt = -Infinity;
/** A focus this soon after a pointer press, with no key pressed since, came from it. */
const POINTER_FOCUS_MS = 600;

if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    () => {
      lastPointerDownAt = performance.now();
    },
    true,
  );
  // Tab pressed straight after a click moves the focus by the keyboard.
  document.addEventListener(
    'keydown',
    () => {
      lastKeyDownAt = performance.now();
    },
    true,
  );
  document.addEventListener(
    'focusin',
    (e) => {
      if (!e.target) return;
      const now = performance.now();
      if (lastPointerDownAt > lastKeyDownAt && now - lastPointerDownAt < POINTER_FOCUS_MS)
        pointerFocused.add(e.target);
      else pointerFocused.delete(e.target);
    },
    true,
  );
}

/** Whether `el` was reached from the keyboard (Tab, or a script with no click before it). */
function keyboardFocused(el: Element): boolean {
  return !pointerFocused.has(el);
}

/**
 * Typing: in a field, a text box, a menu of choices or anything editable.
 *
 * A slider counts only when it was reached from the keyboard. Its arrows
 * move it a step, which is what someone who tabbed to it wants; but a
 * slider just dragged with the mouse - the player's position bar - keeps the
 * focus, and then the arrows meant for the narration nudged the bar a second
 * at a time instead.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLInputElement && target.type === 'range') return keyboardFocused(target);
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * A control that was reached from the keyboard, which keeps Space for itself.
 *
 * Space presses the focused button - that is how someone who moves through
 * the page with Tab uses it, and it must keep working for them. But a button
 * merely clicked with the mouse keeps the focus too, and then Space, meant
 * for the narration, pressed that button again instead: the speed menu
 * opened, or play toggled twice and nothing happened. Only a button reached
 * from the keyboard keeps Space.
 */
export function isKeyboardFocusedControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const control = target.closest('button, a[href], [role="button"], summary');
  return control ? keyboardFocused(control) : false;
}

/**
 * ⌘, Ctrl or ⌥ held: the browser's and the system's. ⌘← is Back in a Mac
 * browser, Ctrl+Space switches input source - a reading shortcut answering
 * to them would act on top of what the person meant.
 */
export function hasCommandModifier(
  e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey'>,
): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}
