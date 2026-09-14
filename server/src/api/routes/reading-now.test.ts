import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { type ProgressEvent } from '@readport/shared';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-reading-now-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: tmp,
    cacheDir: tmp,
    sessionSecret: 'reading-now-test-secret-0123456789',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});
const request = (
  url: string,
  user = 'alice',
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  payload?: unknown,
) =>
  app.inject({
    url,
    method,
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': user, 'x-rp-csrf': '1' },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const event = (
  bookId: string,
  pct: number,
  intent: ProgressEvent['intent'] = 'open',
): ProgressEvent => ({
  eventId: crypto.randomUUID(),
  bookId,
  deviceId: 'phone',
  sessionId: 'phone-session',
  seq: 1,
  occurredAt: new Date(Date.now() - 1000).toISOString(),
  intent,
  locator:
    bookId === 'audio'
      ? { medium: 'audio', trackIdx: 0, positionMs: 5000, pct }
      : { medium: 'ebook', spineIdx: 1, sentenceId: 's17', charOffset: 1739, pct },
});
const send = (events: ProgressEvent[], user = 'alice') =>
  request('/api/progress/events', user, 'POST', { events });
beforeAll(async () => {
  await app.ready();
  for (const id of ['ebook', 'audio', 'tiny', 'zero', 'absent', 'done', 'full', 'foreign']) {
    db.prepare(
      "INSERT INTO books (id,kind,root_dir,rel_path,format,title,scan_state,added_at) VALUES (?,?,?,?,?,?,'ready',?)",
    ).run(
      id,
      id === 'audio' ? 'audio' : 'ebook',
      tmp,
      id,
      id === 'audio' ? 'mp3' : 'epub',
      id,
      new Date().toISOString(),
    );
  }
  db.prepare(
    "INSERT INTO pairs (id,ebook_id,audio_id,status,score,created_at) VALUES ('pair','ebook','audio','confirmed',1,?)",
  ).run(new Date().toISOString());
  await send([
    event('ebook', 0.2),
    event('audio', 0.3),
    event('tiny', 0.00001),
    event('zero', 0),
    event('done', 0.9, 'finish'),
    event('full', 1),
  ]);
  await send([event('foreign', 0.4), event('ebook', 0.7)], 'bob');
});
afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Reading Now contract', () => {
  it('accepts the actual auto-shelf ID; includes each independently active edition, not completed/absent/zero/foreign progress', async () => {
    const res = await request('/api/library?filter=reading-now');
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .books.map((b: { id: string }) => b.id)
        .sort(),
    ).toEqual(['audio', 'ebook', 'tiny']);
    const legacy = await request('/api/library?filter=in-progress');
    expect(legacy.json().books).toEqual(res.json().books);
    expect(
      (await request('/api/shelves'))
        .json()
        .auto.find((s: { id: string }) => s.id === 'reading-now').count,
    ).toBe(3);
    expect(
      (await request('/api/library?filter=reading-now', 'bob'))
        .json()
        .books.map((b: { id: string }) => b.id)
        .sort(),
    ).toEqual(['ebook', 'foreign']);
    expect((await request('/api/library?filter=nonsense')).statusCode).toBe(400);
  });
  it('exact sentence and character survive same-chapter sync, replay and cross-device reads; stale tab cannot overwrite explicit moves', async () => {
    const first = event('roundtrip', 0.2);
    await send([first]);
    const moved = {
      ...first,
      eventId: crypto.randomUUID(),
      seq: 2,
      intent: 'seek' as const,
      locator: { ...first.locator, charOffset: 1791 },
      occurredAt: new Date().toISOString(),
    };
    await send([moved]);
    expect((await send([moved])).json().results[0].status).toBe('duplicate');
    const stale = {
      ...first,
      eventId: crypto.randomUUID(),
      sessionId: 'old-tab',
      seq: 20,
      intent: 'heartbeat' as const,
    };
    expect((await send([stale])).json().results[0].status).toBe('recorded');
    expect((await request('/api/progress/roundtrip')).json().state.locator).toEqual(moved.locator);
    const other = {
      ...moved,
      eventId: crypto.randomUUID(),
      deviceId: 'new-device',
      sessionId: 'new-session',
      baseRevision: 2,
      locator: { ...moved.locator, spineIdx: 2, charOffset: 3470, sentenceId: 'latest-line' },
    };
    expect((await send([other])).json().results[0].status).toBe('applied');
    expect((await request('/api/progress/roundtrip')).json().state.locator).toEqual(other.locator);
    expect((await request('/api/progress/roundtrip', 'bob')).json().state).toBeNull();
  });
  it('reset removes only current-user selected-edition history/state/claim; retains pair, library, personal collections and other user', async () => {
    const shelf = (await request('/api/shelves', 'alice', 'POST', { name: 'Keep' })).json().shelf;
    const alice = (await request('/api/auth/me')).json().user.id;
    const at = new Date().toISOString();
    for (const kind of ['bookmark', 'highlight', 'note'])
      db.prepare(
        "INSERT INTO annotations (id,user_id,book_id,kind,locator_json,note,created_at,updated_at) VALUES (?,?,'ebook',?,'{}','keep',?,?)",
      ).run(kind, alice, kind, at, at);
    db.prepare(
      "INSERT INTO shelf_items (shelf_id,book_id,sort_key,added_at) VALUES (?,'ebook','a',?)",
    ).run(shelf.id, at);
    db.prepare(
      "INSERT INTO reading_list (user_id,book_id,sort_key,note,added_at) VALUES (?,'ebook','a','keep queue note',?)",
    ).run(alice, at);
    db.prepare(
      "INSERT INTO alignments (id,pair_id,version,status,language,model,coverage,mean_confidence,created_at) VALUES ('keep-alignment','pair',1,'ready','en','fixture',1,1,?)",
    ).run(at);
    db.prepare(
      "INSERT INTO alignment_segments (alignment_id,ord,sentence_id,spine_idx,sentence_ord,start_ms,end_ms,confidence,source) VALUES ('keep-alignment',0,'s17',1,0,0,1000,1,'fixture')",
    ).run();
    db.prepare(
      "INSERT INTO audio_tracks (book_id,idx,rel_path,format) VALUES ('audio',0,'track.mp3','mp3')",
    ).run();
    fs.writeFileSync(path.join(tmp, 'ebook'), 'retained ebook bytes');
    fs.writeFileSync(path.join(tmp, 'track.mp3'), 'retained audio bytes');
    const before = (table: string) => db.prepare(`SELECT * FROM ${table}`).all();
    const retained = [
      'books',
      'pairs',
      'annotations',
      'shelves',
      'shelf_items',
      'reading_list',
      'alignments',
      'alignment_segments',
      'audio_tracks',
    ];
    const snapshot = retained.map(before);
    for (const rows of snapshot) expect(rows.length).toBeGreaterThan(0);
    expect(shelf.id).toBeTruthy();
    const old = event('ebook', 0.8);
    const otherUser = (await request('/api/progress/ebook', 'bob')).json();
    const otherHistory = (await request('/api/progress/ebook/history', 'bob')).json();
    const pairedState = (await request('/api/progress/audio')).json();
    const pairedHistory = (await request('/api/progress/audio/history')).json();
    const reset = await request('/api/progress/ebook', 'alice', 'DELETE');
    expect(reset.statusCode).toBe(200);
    expect(reset.json().bookId).toBe('ebook');
    expect((await request('/api/progress/ebook')).json().state).toBeNull();
    expect((await request('/api/progress/ebook/history')).json().events).toEqual([]);
    expect((await request('/api/progress/audio')).json().state.locator.pct).toBe(0.3);
    expect((await request('/api/progress/ebook', 'bob')).json().state.locator.pct).toBe(0.7);
    expect((await request('/api/progress/ebook', 'bob')).json()).toEqual(otherUser);
    expect((await request('/api/progress/ebook/history', 'bob')).json()).toEqual(otherHistory);
    expect((await request('/api/progress/audio')).json()).toEqual(pairedState);
    expect((await request('/api/progress/audio/history')).json()).toEqual(pairedHistory);
    expect(retained.map(before)).toEqual(snapshot);
    expect(fs.readFileSync(path.join(tmp, 'ebook'), 'utf8')).toBe('retained ebook bytes');
    expect(fs.readFileSync(path.join(tmp, 'track.mp3'), 'utf8')).toBe('retained audio bytes');
    // A previously offline tab must not resurrect progress after removal.
    expect((await send([old])).json().results[0].status).toBe('recorded');
    expect((await request('/api/progress/ebook')).json().state).toBeNull();
    expect(
      (await request('/api/shelves'))
        .json()
        .auto.find((s: { id: string }) => s.id === 'reading-now').count,
    ).toBe(2);
  });
  it('reset generation blocks future-skewed old queues, survives reopen and accepts new reads with past-skewed clocks', async () => {
    const old = { ...event('clock-race', 0.8), occurredAt: '2099-01-01T00:00:00Z' };
    await send([old]);
    const reset = (await request('/api/progress/clock-race', 'alice', 'DELETE')).json();
    expect(reset.generation).toBe(1);
    expect((await send([old])).json().results[0].reason).toBe('progress-reset');
    const reopened = (await request('/api/progress/clock-race')).json();
    expect(reopened).toMatchObject({ state: null, generation: 1 });
    const newRead = {
      ...event('clock-race', 0.2),
      generation: reopened.generation,
      sessionId: 'new-device',
      occurredAt: '2001-01-01T00:00:00Z',
    };
    expect((await send([newRead])).json().results[0].status).toBe('applied');
    const staleLive = {
      ...old,
      eventId: crypto.randomUUID(),
      seq: 99,
      intent: 'heartbeat' as const,
    };
    expect((await send([staleLive])).json().results[0].reason).toBe('progress-reset');
    expect((await request('/api/progress/clock-race')).json().state.locator).toEqual(
      newRead.locator,
    );
    expect((await send([newRead])).json().results[0].status).toBe('duplicate');
    expect((await request('/api/progress/clock-race', 'alice', 'DELETE')).json().generation).toBe(
      2,
    );
    expect((await send([newRead])).json().results[0].reason).toBe('progress-reset');
    expect((await request('/api/progress/clock-race/history')).json().events).toEqual([]);
    expect((await request('/api/progress/clock-race', 'bob')).json().generation).toBe(0);
    const concurrent = await Promise.all([
      request('/api/progress/clock-race', 'alice', 'DELETE'),
      request('/api/progress/clock-race', 'alice', 'DELETE'),
    ]);
    expect(concurrent.map((r) => r.json().generation).sort()).toEqual([3, 4]);
    expect((await send([newRead])).json().results[0].reason).toBe('progress-reset');
    expect((await request('/api/progress/clock-race')).json()).toMatchObject({
      state: null,
      generation: 4,
    });
  });
});
