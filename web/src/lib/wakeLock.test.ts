import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdAwake } from './wakeLock';

/**
 * Keeping the screen on: taken while the page is in front, taken again
 * when the page comes back or the system lets go, and let go when asked.
 * The browser here is a stand-in with a Wake Lock that counts.
 */

type Listener = () => void;

function stage(visible = true) {
  const docListeners = new Set<Listener>();
  const doc = {
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener: (_: string, l: Listener) => docListeners.add(l),
    removeEventListener: (_: string, l: Listener) => docListeners.delete(l),
  };
  const held: { released: boolean; onRelease: Listener[]; release: () => Promise<void> }[] = [];
  const request = vi.fn(async () => {
    const s = {
      released: false,
      onRelease: [] as Listener[],
      release: async () => {
        s.released = true;
        for (const l of s.onRelease) l();
      },
      addEventListener: (_: string, l: Listener) => s.onRelease.push(l),
    };
    held.push(s);
    return s;
  });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', { wakeLock: { request } });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const show = (on: boolean) => {
    doc.visibilityState = on ? 'visible' : 'hidden';
    for (const l of [...docListeners]) l();
  };
  return { request, held, settle, show, docListeners };
}

afterEach(() => vi.unstubAllGlobals());

describe('holdAwake', () => {
  it('keeps the screen on while held, and lets go when asked', async () => {
    const { request, held, settle, docListeners } = stage();
    const letGo = holdAwake();
    await settle();
    expect(request).toHaveBeenCalledWith('screen');
    expect(held).toHaveLength(1);
    letGo();
    await settle();
    expect(held[0]!.released).toBe(true);
    expect(docListeners.size).toBe(0);
    // Let go of on purpose: not taken again.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('waits for the page to be in front, and takes it again when it comes back', async () => {
    const { request, held, settle, show } = stage(false);
    const letGo = holdAwake();
    await settle();
    expect(request).not.toHaveBeenCalled();
    show(true);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    // The browser lets go when the page leaves; coming back takes it again.
    await held[0]!.release();
    show(false);
    await settle();
    show(true);
    await settle();
    expect(held.filter((s) => !s.released)).toHaveLength(1);
    letGo();
  });

  it('takes it again when the system lets go while the page is still in front', async () => {
    const { request, held, settle } = stage();
    const letGo = holdAwake();
    await settle();
    await held[0]!.release();
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(held[1]!.released).toBe(false);
    letGo();
  });

  it('does nothing where there is no Wake Lock', () => {
    vi.stubGlobal('navigator', {});
    expect(() => holdAwake()()).not.toThrow();
  });
});
