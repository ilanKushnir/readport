import { describe, expect, it } from 'vitest';
import {
  consensus,
  nameAudiobook,
  pathFacts,
  repairMojibake,
  seriesIndexFrom,
} from './audiobookNaming.js';

/** Invented authors, series and books throughout. */

const files = (
  n: number,
  tag: (i: number) => Partial<Record<'album' | 'artist' | 'title', string>>,
) => Array.from({ length: n }, (_, i) => ({ album: null, artist: null, title: null, ...tag(i) }));

describe('naming an audiobook', () => {
  it('names a volume by its folder when each file titles only itself', () => {
    const tracks = files(40, (i) => ({
      title: `${String((i >> 1) + 1).padStart(2, '0')}-Tuman_${(i % 2) + 1}`,
      artist: String(i + 1).padStart(2, '0'),
    }));
    expect(
      nameAudiobook(
        'Rivka Sharon/Фонарь Пепельной гавани/Фонарь Пепельной гавани. Книга III. Туман',
        false,
        tracks,
      ),
    ).toEqual({
      title: 'Фонарь Пепельной гавани. Книга III. Туман',
      author: 'Rivka Sharon',
      series: 'Фонарь Пепельной гавани',
      seriesIdx: 3,
    });
  });

  it('takes the album and artist the files agree on', () => {
    const tracks = files(12, () => ({
      album: 'The Lantern of Ash Harbor',
      artist: 'Rivka Sharon',
    }));
    expect(nameAudiobook('Somebody/Some Folder', false, tracks)).toMatchObject({
      title: 'The Lantern of Ash Harbor',
      author: 'Rivka Sharon',
    });
  });

  it('takes a lone file’s own title', () => {
    expect(
      nameAudiobook(
        'Noa Adler/The Clockmaker’s Garden',
        false,
        files(1, () => ({ title: 'The Clockmaker’s Garden' })),
      ),
    ).toMatchObject({ title: 'The Clockmaker’s Garden', author: 'Noa Adler' });
  });

  it('drops an Audible id from a folder’s name', () => {
    expect(pathFacts('Rivka Sharon/Fog Signals B0EXAMPLE1', false).title).toBe('Fog Signals');
  });

  it('knows a loose file at the top of the library has no author folder', () => {
    expect(pathFacts('Fog Signals.m4b', true)).toEqual({
      title: 'Fog Signals',
      author: null,
      series: null,
      seriesIdx: null,
    });
  });
});

describe('volume numbers', () => {
  it('reads them in words and numerals, Roman ones included', () => {
    expect(seriesIndexFrom('Fog Signals, Book 2')).toBe(2);
    expect(seriesIndexFrom('The Harbor. Vol. IV')).toBe(4);
    expect(seriesIndexFrom('Туман. Книги IV-V. Маяки')).toBe(4);
    expect(seriesIndexFrom('Туман. Часть 12')).toBe(12);
    expect(seriesIndexFrom('03 - Salt')).toBe(3);
    expect(seriesIndexFrom('Evening Tide')).toBeNull();
  });
});

describe('tags that agree', () => {
  it('wants most of the files, not one', () => {
    expect(consensus(['A', 'A', 'A', null])).toBe('A');
    expect(consensus(['A', 'B', 'C', 'D'])).toBeNull();
    expect(consensus([null, null])).toBeNull();
  });
});

describe('text in a Windows code page, misread', () => {
  it('is Cyrillic again', () => {
    expect(repairMojibake('Ðèâêà Øàðîí')).toBe('Ривка Шарон');
  });

  it('leaves accented Latin, and real Cyrillic, as they are', () => {
    expect(repairMojibake('Émile Müller')).toBe('Émile Müller');
    expect(repairMojibake('Ривка')).toBe('Ривка');
    expect(repairMojibake('Plain words')).toBe('Plain words');
  });
});
