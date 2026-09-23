import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WebKit repaints a range when it goes into or comes out of a Highlight, and
 * did not repaint when a registry entry was replaced or deleted. These pin
 * down that the reader only ever does the first: a highlight registered once
 * per name, emptied and refilled in place, never swapped out or deleted.
 */

type Op = string;
let log: Op[];

class FakeHighlight extends Set<AbstractRange> {
  add(r: AbstractRange) {
    log.push(`add ${String((r as unknown as { id: string }).id)}`);
    return super.add(r);
  }
  clear() {
    log.push('clear');
    super.clear();
  }
  delete(r: AbstractRange) {
    log.push('delete');
    return super.delete(r);
  }
}

class FakeRegistry extends Map<string, FakeHighlight> {
  set(k: string, v: FakeHighlight) {
    log.push(`register ${k} (${v.size})`);
    return super.set(k, v);
  }
  delete(k: string) {
    log.push(`unregister ${k}`);
    return super.delete(k);
  }
}

const range = (id: string) => ({ id }) as unknown as AbstractRange;
const ids = (h: FakeHighlight | undefined) =>
  [...(h ?? [])].map((r) => (r as unknown as { id: string }).id);

let registry: FakeRegistry;

async function load() {
  vi.resetModules();
  return import('./paint');
}

beforeEach(() => {
  log = [];
  registry = new FakeRegistry();
  vi.stubGlobal('CSS', { highlights: registry });
  vi.stubGlobal('Highlight', FakeHighlight);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('paintRanges', () => {
  it('registers an empty highlight once, then adds the ranges to it', async () => {
    const { paintRanges } = await load();
    paintRanges('rp-hl-amber', [range('a'), range('b')]);
    expect(log).toEqual(['register rp-hl-amber (0)', 'add a', 'add b']);
    expect(ids(registry.get('rp-hl-amber'))).toEqual(['a', 'b']);
  });

  it('takes a removed range out of the same highlight instead of replacing it', async () => {
    const { paintRanges } = await load();
    paintRanges('rp-hl-amber', [range('a'), range('b')]);
    const first = registry.get('rp-hl-amber');
    log = [];
    paintRanges('rp-hl-amber', [range('a')]);
    expect(log).toEqual(['clear', 'add a']);
    expect(registry.get('rp-hl-amber')).toBe(first);
    expect(ids(first)).toEqual(['a']);
  });

  it('leaves an emptied name registered, with nothing in it', async () => {
    const { paintRanges } = await load();
    paintRanges('rp-note', [range('n')]);
    log = [];
    paintRanges('rp-note', []);
    expect(log).toEqual(['clear']);
    expect(registry.has('rp-note')).toBe(true);
    expect(registry.get('rp-note')?.size).toBe(0);
  });

  it('does nothing to a name that is already empty', async () => {
    const { paintRanges } = await load();
    paintRanges('rp-found', []);
    log = [];
    paintRanges('rp-found', []);
    expect(log).toEqual([]);
  });

  it('empties a highlight something else put under the name before taking the name over', async () => {
    const { paintRanges } = await load();
    const foreign = new FakeHighlight([range('old')]);
    registry.set('rp-handoff', foreign);
    log = [];
    paintRanges('rp-handoff', [range('new')]);
    expect(log).toEqual(['clear', 'register rp-handoff (0)', 'add new']);
    expect(foreign.size).toBe(0);
    expect(ids(registry.get('rp-handoff'))).toEqual(['new']);
  });

  it('keeps to itself in a browser without the highlight API', async () => {
    vi.stubGlobal('Highlight', undefined);
    const { canPaint, paintRanges } = await load();
    expect(canPaint()).toBe(false);
    expect(() => paintRanges('rp-hl-amber', [range('a')])).not.toThrow();
    expect(log).toEqual([]);
  });
});
