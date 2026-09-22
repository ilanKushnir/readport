import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { FRIEND_COLOUR_IDS, RECOMMENDATION_NOTE_MAX } from '../../friends/prefs.js';
import {
  FRIEND_COLOUR_IDS as SHARED_COLOUR_IDS,
  RECOMMENDATION_NOTE_MAX as SHARED_NOTE_MAX,
} from '@readport/shared';

/**
 * Friends: consent to see each other's place in a shared library.
 *
 * The two refusals that matter are pinned here from both sides - a position
 * is never returned to someone who is not an accepted friend, and never
 * returned for someone who has switched sharing off - along with the
 * request dance around them and the recommendations that ride on it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-friends-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: tmp,
    cacheDir: tmp,
    sessionSecret: 'friends-test-secret-0123456789abcdef',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const request = (url: string, user = 'alice', method: Method = 'GET', payload?: unknown) =>
  app.inject({
    url,
    method,
    remoteAddress: '10.0.0.5',
    headers: { 'x-rp-test-user': user, 'x-rp-csrf': '1' },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

interface Person {
  userId: string;
  username: string;
  displayName: string;
}
interface FriendsResponse {
  friends: (Person & {
    colour: string;
    sharesProgress: boolean;
    reading: { bookId: string; title: string; kind: string; pct: number } | null;
  })[];
  incoming: (Person & { id: string; createdAt: string })[];
  outgoing: (Person & { id: string; createdAt: string })[];
  people: Person[];
}
interface ProgressResponse {
  friends: (Person & {
    colour: string;
    pct: number;
    finished: boolean;
    updatedAt: string;
    chapterTitle: string | null;
    locator: Record<string, unknown>;
  })[];
  friendCount: number;
}

const me = async (user: string) =>
  (await request('/api/auth/me', user)).json() as {
    user: { id: string };
    friendRequests: number;
    recommendations: number;
  };
const friends = async (user: string) =>
  (await request('/api/friends', user)).json() as FriendsResponse;
const ask = (from: string, toId: string) =>
  request('/api/friends/requests', from, 'POST', { userId: toId });
const progressOf = async (user: string, bookId: string) =>
  (await request(`/api/friends/progress?bookId=${bookId}`, user)).json() as ProgressResponse;
const recommend = (from: string, toUserId: string, bookId: string, note?: string) =>
  request('/api/friends/recommend', from, 'POST', { toUserId, bookId, note });

const ids: Record<string, string> = {};

/** A position written straight into the store, so its timestamp is exact. */
const setProgress = (
  userId: string,
  bookId: string,
  locator: Record<string, unknown>,
  opts: { finished?: boolean; updatedAt?: string } = {},
) => {
  const at = opts.updatedAt ?? new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO progress_state
       (user_id, book_id, revision, locator_json, intent, occurred_at, session_uuid, device_id, seq, finished, updated_at)
     VALUES (?, ?, 1, ?, 'open', ?, 'sess', 'dev', 1, ?, ?)`,
  ).run(userId, bookId, JSON.stringify(locator), at, opts.finished ? 1 : 0, at);
};
const ebook = (spineIdx: number, pct: number) => ({
  medium: 'ebook',
  spineIdx,
  charOffset: 10,
  pct,
});

beforeAll(async () => {
  await app.ready();
  // Proxy sign-in provisions each account on first sight.
  for (const u of ['alice', 'bob', 'carol', 'dave']) ids[u] = (await me(u)).user.id;
  db.prepare("UPDATE users SET display_name = 'Bob Bookish' WHERE id = ?").run(ids.bob);
  const now = new Date().toISOString();
  const book = db.prepare(
    'INSERT INTO books (id,kind,root_dir,rel_path,format,title,author,scan_state,added_at) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  book.run(
    'b1',
    'ebook',
    tmp,
    'b1.epub',
    'epub',
    'The Lantern of Ash Harbor',
    'M. Vale',
    'ready',
    now,
  );
  book.run('b2', 'audio', tmp, 'b2', 'm4b', 'Tin and Tallow', 'M. Vale', 'ready', now);
  const chapter = db.prepare(
    'INSERT INTO chapters (book_id, idx, title, spine_idx, start_ms, end_ms) VALUES (?,?,?,?,?,?)',
  );
  chapter.run('b1', 0, 'Chapter One', 0, null, null);
  chapter.run('b1', 1, 'Chapter Two', 2, null, null);
  chapter.run('b1', 2, 'Chapter Three', 5, null, null);
  db.prepare(
    'INSERT INTO audio_tracks (book_id, idx, rel_path, duration_ms, format, start_ms_absolute) VALUES (?,?,?,?,?,?)',
  ).run('b2', 0, 't.m4b', 600000, 'm4b', 0);
  chapter.run('b2', 0, 'Part One', null, 0, 300000);
  chapter.run('b2', 1, 'Part Two', null, 300000, 600000);
});
afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('friends', () => {
  it('begins with everyone else on the server listed as people, and nothing pending', async () => {
    const res = await friends('alice');
    expect(res.friends).toEqual([]);
    expect(res.incoming).toEqual([]);
    expect(res.outgoing).toEqual([]);
    expect(res.people.map((p) => p.displayName)).toEqual(['Bob Bookish', 'carol', 'dave']);
    expect(res.people[0]).toEqual({ userId: ids.bob, username: 'bob', displayName: 'Bob Bookish' });
    const m = await me('alice');
    expect(m.friendRequests).toBe(0);
    expect(m.recommendations).toBe(0);
  });

  it('a request is outgoing for the asker, incoming for the asked, and counted for them', async () => {
    const res = await ask('alice', ids.bob!);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'pending', userId: ids.bob });
    const a = await friends('alice');
    expect(a.outgoing.map((r) => r.userId)).toEqual([ids.bob]);
    expect(a.people.map((p) => p.username)).toEqual(['carol', 'dave']);
    const b = await friends('bob');
    expect(b.incoming).toHaveLength(1);
    expect(b.incoming[0]).toMatchObject({ userId: ids.alice, displayName: 'alice' });
    expect(b.incoming[0]!.createdAt).toBeTruthy();
    expect(b.people.map((p) => p.username)).toEqual(['carol', 'dave']);
    expect((await me('bob')).friendRequests).toBe(1);
    expect((await me('alice')).friendRequests).toBe(0);
  });

  it('refuses asking yourself, asking twice, and asking nobody', async () => {
    const self = await ask('alice', ids.alice!);
    expect(self.statusCode).toBe(400);
    expect(self.json().error).toBe('self');
    const again = await ask('alice', ids.bob!);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already-requested');
    expect((await ask('alice', 'user_nobody')).statusCode).toBe(404);
    expect((await request('/api/friends/requests', 'alice', 'POST', {})).statusCode).toBe(400);
  });

  it('asking someone who already asked you is a yes from both sides', async () => {
    const res = await ask('bob', ids.alice!);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('accepted');
    const a = await friends('alice');
    expect(a.friends).toHaveLength(1);
    expect(a.friends[0]).toMatchObject({
      userId: ids.bob,
      username: 'bob',
      displayName: 'Bob Bookish',
      colour: 'plum',
      sharesProgress: true,
      reading: null,
    });
    expect(a.outgoing).toEqual([]);
    expect((await friends('bob')).friends.map((f) => f.userId)).toEqual([ids.alice]);
    expect((await friends('bob')).incoming).toEqual([]);
    expect((await me('bob')).friendRequests).toBe(0);
    const twice = await ask('alice', ids.bob!);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toBe('already-friends');
  });

  it('only the person asked can accept; either party can take a pending request back; strangers see nothing', async () => {
    const id = (await ask('carol', ids.alice!)).json().id as string;
    expect((await request(`/api/friends/requests/${id}/accept`, 'bob', 'POST')).statusCode).toBe(
      404,
    );
    expect((await request(`/api/friends/requests/${id}/decline`, 'dave', 'POST')).statusCode).toBe(
      404,
    );
    // The asker cannot answer their own question.
    expect((await request(`/api/friends/requests/${id}/accept`, 'carol', 'POST')).statusCode).toBe(
      404,
    );
    expect((await request(`/api/friends/requests/${id}/decline`, 'alice', 'POST')).statusCode).toBe(
      200,
    );
    expect((await friends('carol')).outgoing).toEqual([]);
    expect((await friends('alice')).incoming).toEqual([]);
    // Declining is not remembered: the same request can simply be made again.
    const second = (await ask('carol', ids.alice!)).json().id as string;
    expect(second).not.toBe(id);
    expect(
      (await request(`/api/friends/requests/${second}/accept`, 'alice', 'POST')).statusCode,
    ).toBe(200);
    expect((await friends('alice')).friends.map((f) => f.userId)).toEqual([ids.bob, ids.carol]);
    expect(
      (await request(`/api/friends/requests/${second}/accept`, 'alice', 'POST')).statusCode,
    ).toBe(404);
    // Withdrawing your own request is the same deletion.
    const third = (await ask('dave', ids.alice!)).json().id as string;
    expect((await me('alice')).friendRequests).toBe(1);
    expect(
      (await request(`/api/friends/requests/${third}/decline`, 'dave', 'POST')).statusCode,
    ).toBe(200);
    expect((await me('alice')).friendRequests).toBe(0);
    expect((await friends('alice')).people.map((p) => p.userId)).toEqual([ids.dave]);
  });

  it('unfriending works from either side and is not repeatable', async () => {
    expect((await request(`/api/friends/${ids.alice}`, 'carol', 'DELETE')).statusCode).toBe(200);
    expect((await friends('alice')).friends.map((f) => f.userId)).toEqual([ids.bob]);
    expect((await friends('carol')).friends).toEqual([]);
    expect((await friends('carol')).people.map((p) => p.userId)).toContain(ids.alice);
    expect((await request(`/api/friends/${ids.alice}`, 'carol', 'DELETE')).statusCode).toBe(404);
  });

  it('a position is visible to a friend, and to nobody who is not one', async () => {
    setProgress(ids.bob!, 'b1', ebook(2, 0.42), { updatedAt: '2026-09-20T10:00:00.000Z' });
    setProgress(
      ids.bob!,
      'b2',
      { medium: 'audio', trackIdx: 0, positionMs: 320000, pct: 0.3 },
      { updatedAt: '2026-09-19T10:00:00.000Z' },
    );
    setProgress(ids.alice!, 'b1', ebook(0, 0.1));
    setProgress(ids.carol!, 'b1', ebook(5, 0.9));
    const seen = await progressOf('alice', 'b1');
    expect(seen.friendCount).toBe(1);
    expect(seen.friends).toHaveLength(1);
    expect(seen.friends[0]).toMatchObject({
      userId: ids.bob,
      displayName: 'Bob Bookish',
      colour: 'plum',
      pct: 0.42,
      finished: false,
      updatedAt: '2026-09-20T10:00:00.000Z',
      chapterTitle: 'Chapter Two',
      locator: { medium: 'ebook', spineIdx: 2, charOffset: 10, pct: 0.42 },
    });
    // Carol has the book open too and is not Alice's friend: not a 403, not
    // a row - nothing at all.
    expect(seen.friends.map((f) => f.userId)).not.toContain(ids.carol);
    expect((await progressOf('bob', 'b1')).friends).toMatchObject([
      { userId: ids.alice, pct: 0.1, chapterTitle: 'Chapter One' },
    ]);
    // Friends with nobody: an empty answer, whoever has the book open.
    expect((await progressOf('carol', 'b1')).friends).toEqual([]);
    expect((await progressOf('carol', 'b1')).friendCount).toBe(0);
    expect((await progressOf('dave', 'b1')).friends).toEqual([]);
    // An audio position resolves to its chapter through whole-book milliseconds.
    expect((await progressOf('alice', 'b2')).friends[0]).toMatchObject({
      userId: ids.bob,
      chapterTitle: 'Part Two',
    });
    expect((await progressOf('alice', 'nothing')).friends).toEqual([]);
    expect((await request('/api/friends/progress', 'alice')).statusCode).toBe(400);
    // The friends list names the book a friend touched last and has not finished.
    expect((await friends('alice')).friends[0]!.reading).toMatchObject({
      bookId: 'b1',
      title: 'The Lantern of Ash Harbor',
      kind: 'ebook',
      pct: 0.42,
    });
    // Finishing it moves the line on to the next unfinished book, and the
    // book page still says finished.
    setProgress(ids.bob!, 'b1', ebook(5, 1), {
      finished: true,
      updatedAt: '2026-09-21T10:00:00.000Z',
    });
    expect((await friends('alice')).friends[0]!.reading).toMatchObject({
      bookId: 'b2',
      kind: 'audio',
      pct: 0.3,
    });
    expect((await progressOf('alice', 'b1')).friends[0]).toMatchObject({ finished: true, pct: 1 });
    setProgress(ids.bob!, 'b1', ebook(2, 0.42), { updatedAt: '2026-09-20T10:00:00.000Z' });
  });

  it('a friend in the other edition of a linked pair is in this book too', async () => {
    // b1 (ebook) and b2 (audio) become one work. Bob's ebook place is from
    // the 20th; his audio place from the 19th - the newer touch is where he is.
    db.prepare(
      `INSERT INTO pairs (id, ebook_id, audio_id, status, score, created_at)
       VALUES ('p1', 'b1', 'b2', 'confirmed', 0.97, ?)`,
    ).run(new Date().toISOString());
    expect((await progressOf('alice', 'b2')).friends).toMatchObject([
      { userId: ids.bob, pct: 0.42, chapterTitle: 'Chapter Two' },
    ]);
    // He listens on: the audio place is now the newer one, and the reader of
    // the ebook sees him there, at the audio chapter's name.
    setProgress(
      ids.bob!,
      'b2',
      { medium: 'audio', trackIdx: 0, positionMs: 320000, pct: 0.3 },
      { updatedAt: '2026-09-22T10:00:00.000Z' },
    );
    expect((await progressOf('alice', 'b1')).friends).toMatchObject([
      { userId: ids.bob, pct: 0.3, chapterTitle: 'Part Two' },
    ]);
    // A rejected or merely suggested pair links nothing.
    db.prepare("UPDATE pairs SET status = 'candidate' WHERE id = 'p1'").run();
    expect((await progressOf('alice', 'b1')).friends).toMatchObject([
      { userId: ids.bob, pct: 0.42 },
    ]);
    db.prepare("DELETE FROM pairs WHERE id = 'p1'").run();
    setProgress(
      ids.bob!,
      'b2',
      { medium: 'audio', trackIdx: 0, positionMs: 320000, pct: 0.3 },
      { updatedAt: '2026-09-19T10:00:00.000Z' },
    );
  });

  it('turning sharing off hides a position and the reading line everywhere; turning it on brings them back', async () => {
    const share = (user: string, shareProgress: boolean) =>
      request('/api/prefs/friends', user, 'PUT', { shareProgress, colours: {}, shown: {} });
    expect((await share('bob', false)).statusCode).toBe(200);
    expect((await progressOf('alice', 'b1')).friends).toEqual([]);
    expect((await progressOf('alice', 'b2')).friends).toEqual([]);
    expect((await friends('alice')).friends[0]).toMatchObject({
      userId: ids.bob,
      sharesProgress: false,
      reading: null,
    });
    // Bob's own view of Alice is unaffected: sharing is per person, not mutual.
    expect((await progressOf('bob', 'b1')).friends.map((f) => f.userId)).toEqual([ids.alice]);
    expect((await share('bob', true)).statusCode).toBe(200);
    expect((await progressOf('alice', 'b1')).friends.map((f) => f.userId)).toEqual([ids.bob]);
    expect((await friends('alice')).friends[0]!.reading?.bookId).toBe('b1');
  });

  it('colours are dealt in the order friends were made, and the viewer can override one', async () => {
    const id = (await ask('alice', ids.carol!)).json().id as string;
    expect((await request(`/api/friends/requests/${id}/accept`, 'carol', 'POST')).statusCode).toBe(
      200,
    );
    expect((await friends('alice')).friends.map((f) => [f.userId, f.colour])).toEqual([
      [ids.bob, 'plum'],
      [ids.carol, 'sky'],
    ]);
    // From Carol's side, Alice is her first friend: colours are the viewer's.
    expect((await friends('carol')).friends.map((f) => f.colour)).toEqual(['plum']);
    const put = await request('/api/prefs/friends', 'alice', 'PUT', {
      shareProgress: true,
      colours: { [ids.bob!]: 'moss' },
      shown: { b1: [ids.bob] },
    });
    expect(put.statusCode).toBe(200);
    expect((await friends('alice')).friends.map((f) => f.colour)).toEqual(['moss', 'sky']);
    // Furthest along first, wearing the viewer's colours.
    expect((await progressOf('alice', 'b1')).friends.map((f) => [f.userId, f.colour])).toEqual([
      [ids.carol, 'sky'],
      [ids.bob, 'moss'],
    ]);
    // Not a palette colour, not stored.
    const bad = await request('/api/prefs/friends', 'alice', 'PUT', {
      shareProgress: true,
      colours: { [ids.bob!]: '#3d6b4f' },
      shown: {},
    });
    expect(bad.statusCode).toBe(400);
    expect((await request('/api/prefs/friends', 'alice')).json().friends.colours).toEqual({
      [ids.bob!]: 'moss',
    });
  });

  it('a recommendation goes only to a friend, lands in their inbox, and is counted until it is seen', async () => {
    expect((await recommend('alice', ids.dave!, 'b1')).statusCode).toBe(403);
    expect((await recommend('alice', ids.alice!, 'b1')).statusCode).toBe(400);
    expect((await recommend('alice', 'user_nobody', 'b1')).statusCode).toBe(404);
    expect((await recommend('alice', ids.bob!, 'no-such-book')).statusCode).toBe(404);
    expect(
      (await recommend('alice', ids.bob!, 'b1', 'x'.repeat(RECOMMENDATION_NOTE_MAX + 1)))
        .statusCode,
    ).toBe(400);
    const sent = await recommend(
      'alice',
      ids.bob!,
      'b1',
      '  You will love the lighthouse chapter.  ',
    );
    expect(sent.statusCode).toBe(201);
    expect(sent.json().recommendation).toMatchObject({
      toUserId: ids.bob,
      bookId: 'b1',
      note: 'You will love the lighthouse chapter.',
    });
    const recId = sent.json().recommendation.id as string;
    expect((await me('bob')).recommendations).toBe(1);
    expect((await me('alice')).recommendations).toBe(0);
    const inbox = (await request('/api/friends/inbox', 'bob')).json();
    expect(inbox.recommendations).toHaveLength(1);
    expect(inbox.recommendations[0]).toMatchObject({
      id: recId,
      note: 'You will love the lighthouse chapter.',
      seenAt: null,
      from: { userId: ids.alice, username: 'alice', displayName: 'alice' },
      book: { id: 'b1', title: 'The Lantern of Ash Harbor', author: 'M. Vale', kind: 'ebook' },
    });
    // The summary is the recipient's own: their progress, not the sender's.
    expect(inbox.recommendations[0].book.progress).toMatchObject({ pct: 0.42 });
    // Once, until dealt with.
    expect((await recommend('alice', ids.bob!, 'b1')).statusCode).toBe(409);
    // The sender sees it went, and that it has not been looked at.
    expect((await request('/api/friends/sent', 'alice')).json().sent).toMatchObject([
      { id: recId, to: { userId: ids.bob }, book: { id: 'b1' }, seenAt: null },
    ]);
    // Only the recipient can mark it.
    expect((await request(`/api/friends/inbox/${recId}/seen`, 'carol', 'POST')).statusCode).toBe(
      404,
    );
    expect((await request(`/api/friends/inbox/${recId}/seen`, 'alice', 'POST')).statusCode).toBe(
      404,
    );
    const seen = await request(`/api/friends/inbox/${recId}/seen`, 'bob', 'POST');
    expect(seen.statusCode).toBe(200);
    expect(typeof seen.json().seenAt).toBe('string');
    expect((await me('bob')).recommendations).toBe(0);
    expect((await request('/api/friends/sent', 'alice')).json().sent[0].seenAt).toBe(
      seen.json().seenAt,
    );
    // Seen twice is still the first time.
    expect((await request(`/api/friends/inbox/${recId}/seen`, 'bob', 'POST')).json().seenAt).toBe(
      seen.json().seenAt,
    );
    // Dismissing takes it off the page and lets the same book be recommended again.
    expect((await request(`/api/friends/inbox/${recId}/dismiss`, 'carol', 'POST')).statusCode).toBe(
      404,
    );
    expect((await request(`/api/friends/inbox/${recId}/dismiss`, 'bob', 'POST')).statusCode).toBe(
      200,
    );
    expect((await request('/api/friends/inbox', 'bob')).json().recommendations).toEqual([]);
    expect((await request(`/api/friends/inbox/${recId}/seen`, 'bob', 'POST')).statusCode).toBe(404);
    expect((await recommend('alice', ids.bob!, 'b1')).statusCode).toBe(201);
    // Dismissing something never looked at counts as looking at it, for the
    // dot and for the sender alike - what was done with it is not reported.
    const second = (await recommend('bob', ids.alice!, 'b2', '')).json().recommendation;
    expect(second.note).toBeNull();
    expect((await me('alice')).recommendations).toBe(1);
    expect(
      (await request(`/api/friends/inbox/${second.id}/dismiss`, 'alice', 'POST')).statusCode,
    ).toBe(200);
    expect((await me('alice')).recommendations).toBe(0);
    const bobSent = (await request('/api/friends/sent', 'bob')).json().sent;
    expect(bobSent[0].seenAt).toBeTruthy();
    expect(bobSent[0]).not.toHaveProperty('dismissedAt');
    // Unfriending does not unread a note already delivered, but nothing new
    // crosses a friendship that is over.
    expect((await request('/api/friends/inbox', 'bob')).json().recommendations).toHaveLength(1);
    expect((await request(`/api/friends/${ids.bob}`, 'alice', 'DELETE')).statusCode).toBe(200);
    expect((await request('/api/friends/inbox', 'bob')).json().recommendations).toHaveLength(1);
    expect((await recommend('alice', ids.bob!, 'b2')).statusCode).toBe(403);
  });

  it('a recommended book that has left the library is neither listed nor counted', async () => {
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO books (id,kind,root_dir,rel_path,format,title,author,scan_state,added_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run('gone', 'ebook', tmp, 'gone.epub', 'epub', 'Here Until Thursday', 'M. Vale', 'ready', now);
    expect((await recommend('carol', ids.alice!, 'gone')).statusCode).toBe(201);
    const before = (await me('alice')).recommendations;
    db.prepare('DELETE FROM books WHERE id = ?').run('gone');
    expect((await me('alice')).recommendations).toBe(before - 1);
    const inbox = (await request('/api/friends/inbox', 'alice')).json() as {
      recommendations: { book: { id: string } }[];
    };
    expect(inbox.recommendations.map((r) => r.book.id)).not.toContain('gone');
  });

  it('a disabled account drops out of every list until it is enabled again', async () => {
    expect((await friends('alice')).friends.map((f) => f.userId)).toEqual([ids.carol]);
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(ids.carol);
    expect((await friends('alice')).friends).toEqual([]);
    expect((await friends('alice')).people.map((p) => p.userId)).not.toContain(ids.carol);
    expect((await progressOf('alice', 'b1')).friends).toEqual([]);
    expect((await progressOf('alice', 'b1')).friendCount).toBe(0);
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(ids.carol);
    expect((await friends('alice')).friends.map((f) => f.userId)).toEqual([ids.carol]);
    expect((await progressOf('alice', 'b1')).friends.map((f) => f.userId)).toEqual([ids.carol]);
  });

  it('the friends preference round-trips with its defaults, and refuses the wrong shape', async () => {
    expect((await request('/api/prefs/friends', 'dave')).json()).toEqual({
      friends: { shareProgress: true, colours: {}, shown: {} },
    });
    const doc = { shareProgress: false, colours: {}, shown: { b1: [ids.alice, ids.bob] } };
    expect((await request('/api/prefs/friends', 'dave', 'PUT', doc)).json()).toEqual({
      friends: doc,
    });
    expect((await request('/api/prefs/friends', 'dave')).json()).toEqual({ friends: doc });
    expect(
      (await request('/api/prefs/friends', 'dave', 'PUT', { shareProgress: 'yes' })).statusCode,
    ).toBe(400);
    // A partial document fills in the rest rather than being refused.
    expect(
      (await request('/api/prefs/friends', 'dave', 'PUT', { shareProgress: true })).json(),
    ).toEqual({ friends: { shareProgress: true, colours: {}, shown: {} } });
  });

  it("the server's palette names mirror the shared module's", () => {
    expect([...FRIEND_COLOUR_IDS]).toEqual([...SHARED_COLOUR_IDS]);
    expect(RECOMMENDATION_NOTE_MAX).toBe(SHARED_NOTE_MAX);
  });
});
