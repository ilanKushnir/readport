/**
 * Keeping the screen on, for as long as something needs it.
 *
 * A phone locks itself after a minute or so without a touch, and a locked
 * phone stops the page: a download in a web app on iOS ends there, and a
 * chapter being read along to goes dark in the middle of a sentence. The
 * Screen Wake Lock is the browser's own way to ask for the screen to stay
 * on. The browser lets go of it whenever the page leaves the front, and
 * the system may let go of it at other times, so it is taken again when
 * the page comes back and when it is let go of while the page is still in
 * front. Where there is no Wake Lock, nothing happens: the phone sleeps as
 * it always has.
 *
 * Returns the way to let go.
 */
export function holdAwake(): () => void {
  type Sentinel = {
    released?: boolean;
    release: () => Promise<void>;
    addEventListener?: (type: 'release', listener: () => void) => void;
  };
  const wl =
    typeof navigator !== 'undefined'
      ? (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } })
          .wakeLock
      : undefined;
  if (!wl || typeof document === 'undefined') return () => {};
  let sentinel: Sentinel | null = null;
  let taking = false;
  let stopped = false;
  const take = () => {
    if (stopped || taking || document.visibilityState !== 'visible') return;
    if (sentinel && !sentinel.released) return;
    taking = true;
    wl.request('screen').then(
      (s) => {
        taking = false;
        if (stopped) {
          void s.release().catch(() => {});
          return;
        }
        sentinel = s;
        // Let go of by the system while the page is still in front - a
        // battery saver, a moment it decides it needs the screen back.
        s.addEventListener?.('release', () => {
          if (sentinel === s) sentinel = null;
          queueMicrotask(take);
        });
      },
      () => {
        taking = false;
      },
    );
  };
  document.addEventListener('visibilitychange', take);
  take();
  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', take);
    const held = sentinel;
    sentinel = null;
    void held?.release().catch(() => {});
  };
}
