import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { type ProgressEvent } from '@readport/shared';

/**
 * What a title owned in BOTH formats looks like on the shelves made of
 * progress, and what the manual linker is allowed to offer.
 *
 * Progress is stored per book id, so the two editions really do sit in
 * different places in the same work. The shelves collapse them to one row
 * anyway - a reader owning both formats was seeing every such title twice -
 * and these tests pin down the part that makes that safe: which edition the
 * row stands for, and that the other one is still named rather than dropped.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-paired-shelves-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: tmp,
    cacheDir: tmp,
    sessionSecret: 'paired-shelves-test-secret-0123456789',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});

const request = (url: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', payload?: unknown) =>
  app.inject({
    url,
    method,
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': 'alice', 'x-rp-csrf': '1' },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

const ids = (res: { json(): { books: { id: string }[] } }) =>
  res
    .json()
    .books.map((b) => b.id)
    .sort();

interface Row {
  id: string;
  progress: { pct: number; finished: boolean } | null;
  pair: {
    otherBookId: string;
    otherKind: string;
    status: string;
    otherProgress: { pct: number; finished: boolean } | null;
  };
}

const book = (res: { json(): { books: { id: string }[] } }, id: string) =>
  res.json().books.find((b) => b.id === id) as Row | undefined;

const autoCount = async (shelf: string): Promise<number> =>
  (await request('/api/shelves')).json().auto.find((s: { id: string }) => s.id === shelf).count;

const event = (
  bookId: string,
  pct: number,
  intent: ProgressEvent['intent'] = 'open',
): ProgressEvent => ({
  eventId: crypto.randomUUID(),
  bookId,
  deviceId: 'phone',
  sessionId: `s-${bookId}`,
  seq: 1,
  occurredAt: new Date(Date.now() - 1000).toISOString(),
  intent,
  locator: bookId.endsWith('-a')
    ? { medium: 'audio', trackIdx: 0, positionMs: 5000, pct }
    : { medium: 'ebook', spineIdx: 1, sentenceId: 's1', charOffset: 10, pct },
});

const EBOOKS = ['both-e', 'fin-e', 'solo-e', 'cand-e', 'lone', 'free-e', 'auto-e', 'missing-e'];
const AUDIO = ['both-a', 'fin-a', 'solo-a', 'cand-a', 'free-a', 'auto-a'];

beforeAll(async () => {
  await app.ready();
  for (const id of [...EBOOKS, ...AUDIO]) {
    const audio = AUDIO.includes(id);
    db.prepare(
      'INSERT INTO books (id,kind,root_dir,rel_path,format,title,scan_state,added_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      id,
      audio ? 'audio' : 'ebook',
      tmp,
      id,
      audio ? 'm4b' : 'epub',
      id,
      id === 'missing-e' ? 'missing' : 'ready',
      new Date().toISOString(),
    );
  }
  const at = new Date().toISOString();
  for (const [id, e, a, status] of [
    ['p-both', 'both-e', 'both-a', 'confirmed'],
    ['p-fin', 'fin-e', 'fin-a', 'confirmed'],
    ['p-solo', 'solo-e', 'solo-a', 'confirmed'],
    ['p-auto', 'auto-e', 'auto-a', 'auto'],
    // A guess nobody has answered. Nothing about it may hide a book.
    ['p-cand', 'cand-e', 'cand-a', 'candidate'],
  ]) {
    db.prepare(
      'INSERT INTO pairs (id,ebook_id,audio_id,status,score,created_at) VALUES (?,?,?,?,1,?)',
    ).run(id, e, a, status, at);
  }
  await request('/api/progress/events', 'POST', {
    events: [
      event('both-e', 0.2),
      event('both-a', 0.3),
      event('fin-e', 1, 'finish'),
      event('fin-a', 0.4),
      event('solo-e', 1, 'finish'),
      event('cand-e', 0.5),
      event('cand-a', 0.6),
      event('lone', 0.7),
    ],
  });
  // One queue drain writes a whole batch inside the same millisecond as often
  // as not, so the "touched last" rule needs saying out loud here: the
  // audiobook of the doubly-read title is the edition this reader is in.
  db.prepare("UPDATE progress_state SET updated_at = ? WHERE book_id = 'both-a'").run(
    new Date(Date.now() + 5000).toISOString(),
  );
});

afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a linked title on the progress shelves', () => {
  it('is one row, standing for the edition touched last, still naming the other', async () => {
    const shelf = await request('/api/library?filter=reading-now');
    expect(ids(shelf)).toEqual(['both-a', 'cand-a', 'cand-e', 'fin-a', 'lone']);
    const row = book(shelf, 'both-a')!;
    expect(row.progress).toMatchObject({ pct: 0.3, finished: false });
    // The row offers the other format and knows where it is, so the client
    // can say so instead of pretending there is only one position.
    expect(row.pair.otherBookId).toBe('both-e');
    expect(row.pair.otherKind).toBe('ebook');
    expect(row.pair.otherProgress).toMatchObject({ pct: 0.2, finished: false });
    // Legacy alias of the same shelf, same answer.
    expect(ids(await request('/api/library?filter=in-progress'))).toEqual(ids(shelf));
    // And the sidebar counts rows, not editions.
    expect(await autoCount('reading-now')).toBe(5);
  });

  it('never collapses a candidate - an unreviewed guess may not hide a book', async () => {
    const shelf = await request('/api/library?filter=reading-now');
    expect(ids(shelf)).toContain('cand-e');
    expect(ids(shelf)).toContain('cand-a');
    expect(book(shelf, 'cand-e')!.pair.status).toBe('candidate');
  });

  it('asking for one format explicitly still answers with that format', async () => {
    // "Audiobooks" on Reading Now means audiobooks. Collapsing here would
    // answer a question about editions with a row about titles.
    expect(ids(await request('/api/library?filter=reading-now&kind=audio'))).toEqual([
      'both-a',
      'cand-a',
      'fin-a',
    ]);
    expect(ids(await request('/api/library?filter=reading-now&kind=ebook'))).toEqual([
      'both-e',
      'cand-e',
      'lone',
    ]);
  });

  it('reads as finished when one edition is finished and the other was never opened', async () => {
    const shelf = await request('/api/library?filter=finished');
    expect(ids(shelf)).toEqual(['fin-e', 'solo-e']);
    const solo = book(shelf, 'solo-e')!;
    expect(solo.progress!.finished).toBe(true);
    expect(solo.pair.otherProgress).toBeNull();
    expect(await autoCount('finished')).toBe(2);
  });

  it('shows a half-finished title once on each shelf, and hides neither fact', async () => {
    // Finished the ebook, half way through the audiobook. Two shelves ask two
    // different questions, and each gets the edition that answers it - once.
    const finished = await request('/api/library?filter=finished');
    const reading = await request('/api/library?filter=reading-now');
    expect(ids(finished).filter((id) => id.startsWith('fin-'))).toEqual(['fin-e']);
    expect(ids(reading).filter((id) => id.startsWith('fin-'))).toEqual(['fin-a']);
    // Each row carries the other edition's position, so neither shelf has to
    // pretend the other half does not exist.
    expect(book(finished, 'fin-e')!.pair.otherProgress).toMatchObject({
      pct: 0.4,
      finished: false,
    });
    expect(book(reading, 'fin-a')!.pair.otherProgress).toMatchObject({ finished: true });
  });

  it('carries the collapse into the home page Continue band', async () => {
    const home = (await request('/api/library')).json();
    const rail = home.continueRail.map((b: { id: string }) => b.id);
    expect(rail).toContain('both-a');
    expect(rail).not.toContain('both-e');
    // The grid is the open shelf, which keeps the ebook of every pair - the
    // band is the one that follows the reader.
    expect(home.books.map((b: { id: string }) => b.id)).toContain('both-e');
    expect(home.books.map((b: { id: string }) => b.id)).not.toContain('both-a');
  });

  it('resets one edition at a time, and the row becomes the edition that survived', async () => {
    expect((await request('/api/progress/both-a', 'DELETE')).statusCode).toBe(200);
    const shelf = await request('/api/library?filter=reading-now');
    // The title is still being read - in the ebook, which kept its own place.
    expect(ids(shelf)).toContain('both-e');
    expect(ids(shelf)).not.toContain('both-a');
    expect(book(shelf, 'both-e')!.progress).toMatchObject({ pct: 0.2 });
    expect(book(shelf, 'both-e')!.pair.otherProgress).toBeNull();
    expect(await autoCount('reading-now')).toBe(5);
  });
});

describe('what the manual linker may offer', () => {
  it('offers only books that are not already half of a settled pair', async () => {
    const res = await request('/api/library?filter=unpaired');
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual(['cand-a', 'cand-e', 'free-a', 'free-e', 'lone']);
    // Confirmed and auto pairs are links; both their halves are spoken for.
    for (const id of ['both-e', 'both-a', 'fin-e', 'fin-a', 'solo-e', 'auto-e', 'auto-a'])
      expect(ids(res)).not.toContain(id);
    // A book whose files are gone is not something to link either.
    expect(ids(res)).not.toContain('missing-e');
  });

  it('keeps offering a candidate, because the sheet is where a wrong guess gets fixed', async () => {
    const res = await request('/api/library?filter=unpaired');
    expect(ids(res)).toContain('cand-e');
    expect(ids(res)).toContain('cand-a');
  });

  it('stops offering a book the moment it is linked, and offers it again once unlinked', async () => {
    db.prepare(
      "INSERT INTO pairs (id,ebook_id,audio_id,status,score,created_at) VALUES ('p-free','free-e','free-a','confirmed',1,?)",
    ).run(new Date().toISOString());
    expect(ids(await request('/api/library?filter=unpaired'))).toEqual([
      'cand-a',
      'cand-e',
      'lone',
    ]);
    // Unlinking is a durable "no", and returns both halves to the pickers.
    db.prepare("UPDATE pairs SET status = 'rejected' WHERE id = 'p-free'").run();
    expect(ids(await request('/api/library?filter=unpaired'))).toEqual([
      'cand-a',
      'cand-e',
      'free-a',
      'free-e',
      'lone',
    ]);
  });

  it('narrows by format for the two pickers without a second list in the browser', async () => {
    expect(ids(await request('/api/library?filter=unpaired&kind=ebook'))).toEqual([
      'cand-e',
      'free-e',
      'lone',
    ]);
    expect(ids(await request('/api/library?filter=unpaired&kind=audio'))).toEqual([
      'cand-a',
      'free-a',
    ]);
    // Not an auto shelf: no Continue band is computed for it.
    expect((await request('/api/library?filter=unpaired')).json().continueRail).toEqual([]);
  });
});
