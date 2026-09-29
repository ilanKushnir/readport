import { describe, expect, it } from 'vitest';
import {
  EMPTY_PLACES_DOC,
  PLACE_MAX,
  type PlacesDoc,
  foldReadingPlace,
  forgetReadingPlace,
  mainThread,
  readingPlaces,
} from './places.js';

/**
 * A reader's place, as the checkpoints of their reading move it: reading on
 * keeps it, looking elsewhere does not take it, and reading elsewhere for a
 * while keeps both until the reader has plainly gone back.
 */

const BOOK = 500_000;
const T0 = Date.parse('2026-09-01T20:00:00.000Z');

let ids = 0;
const newId = () => `t${++ids}`;

const loc = (pct: number) => ({
  medium: 'ebook' as const,
  spineIdx: Math.floor(pct * 20),
  charOffset: Math.round(pct * BOOK),
  pct,
});

/** A reader: where they are, and when. Each page is a thousand characters and a minute. */
function reader() {
  let doc: PlacesDoc = EMPTY_PLACES_DOC;
  let now = T0;
  let pct = 0;
  const step = (to: number, afterMs: number) => {
    now += afterMs;
    pct = to;
    doc = foldReadingPlace(
      doc,
      { at: new Date(now).toISOString(), locator: loc(pct) },
      BOOK,
      newId,
    );
  };
  return {
    /** Read on a number of pages, a minute each. */
    read(pages: number, msPerPage = 60_000) {
      for (let i = 0; i < pages; i++) step(pct + 1000 / BOOK, msPerPage);
    },
    /** Jump somewhere, after a moment. */
    jump(to: number, afterMs = 5_000) {
      step(to, afterMs);
    },
    wait(ms: number) {
      now += ms;
    },
    get doc() {
      return doc;
    },
    get pct() {
      return pct;
    },
    places: () => readingPlaces(doc),
  };
}

describe('the reader’s own place', () => {
  it('is where reading on from the start has got to, once it has been read a while', () => {
    const r = reader();
    r.jump(0);
    expect(r.places()).toEqual([]);
    r.read(30);
    const [place] = r.places();
    expect(place).toMatchObject({ main: true, current: true });
    expect(place!.thread.to).toBeCloseTo(r.pct, 6);
    expect(place!.thread.readMs).toBe(30 * 60_000);
  });

  it('is not taken by a glance at a quotation far along the book', () => {
    const r = reader();
    r.jump(0);
    r.read(100);
    const before = r.pct;
    // The link: open at a passage halfway, read it, turn a page, go back.
    r.jump(0.5);
    r.read(1, 20_000);
    r.jump(before);
    const places = r.places();
    expect(places).toHaveLength(1);
    expect(places[0]!.thread.to).toBeCloseTo(before, 6);
    expect(r.doc.threads).toHaveLength(1);
  });

  it('carries on the same thread across the next chapter and a page read again', () => {
    const r = reader();
    r.jump(0.1);
    r.read(10);
    r.jump(r.pct + 3_000 / BOOK); // the next chapter's start, past its title page
    r.read(3);
    r.jump(r.pct - 2_000 / BOOK); // back two pages for a name
    r.read(5);
    expect(r.doc.threads).toHaveLength(1);
  });
});

describe('a place the reader went on to read', () => {
  function readerAtAFifth() {
    const r = reader();
    r.jump(0);
    r.read(100); // 100 minutes, to 20%
    return r;
  }

  it('is kept beside the reader’s own, which stays theirs', () => {
    const r = readerAtAFifth();
    const own = r.pct;
    r.jump(0.5);
    r.read(10);
    const places = r.places();
    expect(places).toHaveLength(2);
    expect(places[0]).toMatchObject({ main: true, current: false });
    expect(places[0]!.thread.to).toBeCloseTo(own, 6);
    expect(places[1]).toMatchObject({ main: false, current: true });
  });

  it('is picked up again where it stopped, not started over', () => {
    const r = readerAtAFifth();
    r.jump(0.5);
    r.read(10);
    const side = r.pct;
    r.jump(0.2 + 1000 / BOOK);
    r.read(2);
    r.jump(side);
    r.read(2);
    expect(r.doc.threads).toHaveLength(2);
    expect(r.places().find((p) => !p.main)!.thread.readMs).toBe(12 * 60_000);
  });

  it('is let go once the reader has gone back to their own place and read on there', () => {
    const r = readerAtAFifth();
    const own = r.pct;
    r.jump(0.5);
    r.read(10);
    r.jump(own);
    r.read(14);
    expect(r.places()).toHaveLength(2);
    r.read(2);
    const places = r.places();
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ main: true, current: true });
  });

  it('is joined to the reader’s own when reading on reaches it', () => {
    const r = readerAtAFifth();
    const own = r.pct;
    r.jump(own + 14_000 / BOOK); // a little way on, past a chapter
    r.read(5);
    expect(r.places()).toHaveLength(2);
    r.jump(own);
    r.read(20, 30_000); // on through where the other stopped, before it is let go
    const places = r.places();
    expect(places).toHaveLength(1);
    expect(places[0]!.thread.readMs).toBe((100 + 5 + 10) * 60_000);
  });

  it('joins the reader’s own when read on as far as it', () => {
    // Going back to read an early chapter again, and on from there.
    const r = readerAtAFifth();
    const own = r.pct;
    r.jump(0.1);
    r.read(55);
    const places = r.places();
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ main: true, current: true });
    expect(places[0]!.thread.from).toBe(0);
    expect(places[0]!.thread.to).toBeGreaterThan(own);
  });

  it('becomes the reader’s own when it has been read more', () => {
    const r = reader();
    r.jump(0);
    r.read(20);
    r.jump(0.5);
    r.read(21);
    const main = mainThread(r.doc.threads)!;
    expect(main.from).toBe(0.5);
    // And the old one goes the way of any other place left behind.
    r.read(15);
    expect(r.places()).toHaveLength(1);
  });

  it('is let go when it has not been read for months', () => {
    const r = readerAtAFifth();
    const own = r.pct;
    r.jump(0.5);
    r.read(5);
    r.jump(own);
    r.wait(91 * 86_400_000);
    r.read(1);
    expect(r.places()).toHaveLength(1);
  });
});

describe('places kept', () => {
  it('are at most a handful, the least recently read let go first', () => {
    const r = reader();
    r.jump(0);
    r.read(100);
    for (let i = 1; i <= PLACE_MAX + 2; i++) {
      r.jump(0.3 + i * 0.05);
      r.read(2);
    }
    expect(r.doc.threads).toHaveLength(PLACE_MAX);
    expect(mainThread(r.doc.threads)!.from).toBe(0);
    // The first two excursions went, the latest stayed.
    const froms = r.doc.threads.map((t) => t.from);
    expect(froms).not.toContain(0.35);
    expect(froms).toContain(0.3 + (PLACE_MAX + 2) * 0.05);
  });

  it('can be forgotten one at a time', () => {
    const r = reader();
    r.jump(0);
    r.read(10);
    r.jump(0.5);
    r.read(2);
    const side = r.places().find((p) => !p.main)!;
    const doc = forgetReadingPlace(r.doc, side.thread.id);
    expect(readingPlaces(doc)).toHaveLength(1);
    expect(doc.current).toBeNull();
  });
});
