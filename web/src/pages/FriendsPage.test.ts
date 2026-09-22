import { describe, expect, it } from 'vitest';
import { bookLine, emptyServer, readingLine, type FriendsData } from './FriendsPage';
import { friends } from '../i18n/messages/en/friends';

/**
 * The page's decisions that do not need a DOM: when a server is empty
 * enough to say so instead of drawing four empty sections, and what one
 * line about a friend says.
 */

const percent = (pct: number) => `${Math.round(pct * 100)}%`;
const nobody: FriendsData = { friends: [], incoming: [], outgoing: [], people: [] };
const person = { userId: 'user_1', username: 'dana', displayName: 'Dana' };

describe('emptyServer', () => {
  it('is the empty state only when there is nobody and nothing at all', () => {
    expect(emptyServer(nobody, [])).toBe(true);
    expect(emptyServer({ ...nobody, people: [person] }, [])).toBe(false);
    expect(
      emptyServer({ ...nobody, incoming: [{ ...person, id: 'fr_1', createdAt: 'x' }] }, []),
    ).toBe(false);
    expect(
      emptyServer({ ...nobody, outgoing: [{ ...person, id: 'fr_1', createdAt: 'x' }] }, []),
    ).toBe(false);
    // A recommendation from somebody who has since left is still something to show.
    expect(
      emptyServer(nobody, [
        {
          id: 'rec_1',
          book: {} as never,
          from: person,
          note: null,
          createdAt: 'x',
          seenAt: null,
        },
      ]),
    ).toBe(false);
  });
});

describe('readingLine', () => {
  const reading = {
    bookId: 'b1',
    title: 'The Lantern of Ash Harbor',
    kind: 'ebook' as const,
    pct: 0.42,
    updatedAt: 'x',
  };

  it('names the book and how far, in the medium it is being read in', () => {
    expect(readingLine({ sharesProgress: true, reading }, percent)).toEqual({
      key: 'friends.list.reading',
      values: { kind: 'ebook', title: 'The Lantern of Ash Harbor', pct: '42%' },
    });
    expect(
      readingLine({ sharesProgress: true, reading: { ...reading, kind: 'audio' } }, percent).values,
    ).toMatchObject({ kind: 'audio' });
  });

  it('says why there is no position rather than pretending there is none', () => {
    // Not sharing wins over whatever they are reading: the position is not ours to print.
    expect(readingLine({ sharesProgress: false, reading }, percent)).toEqual({
      key: 'friends.list.notSharing',
    });
    expect(readingLine({ sharesProgress: true, reading: null }, percent)).toEqual({
      key: 'friends.list.nothingOnTheGo',
    });
  });

  it('only ever names keys the fragment defines', () => {
    for (const line of [
      readingLine({ sharesProgress: true, reading }, percent),
      readingLine({ sharesProgress: false, reading }, percent),
      readingLine({ sharesProgress: true, reading: null }, percent),
    ]) {
      expect(line.key in friends, line.key).toBe(true);
    }
  });
});

describe('bookLine', () => {
  it('adds the chapter when the book can name it, and says finished when they are', () => {
    expect(
      bookLine(
        { displayName: 'Dana', pct: 0.63, finished: false, chapterTitle: 'Chapter 8' },
        percent,
      ),
    ).toEqual({
      key: 'friends.book.entryChapter',
      values: { name: 'Dana', pct: '63%', chapter: 'Chapter 8' },
    });
    expect(
      bookLine({ displayName: 'Dana', pct: 0.63, finished: false, chapterTitle: null }, percent),
    ).toEqual({ key: 'friends.book.entry', values: { name: 'Dana', pct: '63%' } });
    expect(
      bookLine({ displayName: 'Dana', pct: 1, finished: true, chapterTitle: 'The End' }, percent),
    ).toEqual({ key: 'friends.book.entryFinished', values: { name: 'Dana' } });
  });

  it('uses the arguments its messages declare', () => {
    const line = bookLine(
      { displayName: 'Dana', pct: 0.5, finished: false, chapterTitle: 'Two' },
      percent,
    );
    const message: string = friends[line.key];
    for (const name of Object.keys(line.values)) expect(message).toContain(`{${name}}`);
  });
});
