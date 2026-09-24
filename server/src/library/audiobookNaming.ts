/**
 * What an audiobook is called, and by whom - from its tags where the tags
 * agree, and from its folders where they do not.
 *
 * Tags are per file. An audiobook in a hundred and forty files may carry a
 * proper album tag on every one of them, or a "title" that names each file's
 * own chapter and an "artist" that is its number. Taking the first file's
 * title as the book's gave a shelf of books called "01 - Energy 01": each one
 * named after its opening track. So a tag names the book only when most of
 * its files agree on it, and a file's title names the book only when the
 * book is that one file.
 *
 * Folders are the other witness, laid out the way Audiobookshelf and most
 * libraries are: Author / Book, or Author / Series / Book. A series' volume
 * number comes from the book's folder name - "Book 2", "Vol. III", "Часть 4".
 */

export interface TrackTags {
  album: string | null;
  artist: string | null;
  title: string | null;
}

export interface AudiobookName {
  title: string;
  author: string | null;
  series: string | null;
  seriesIdx: number | null;
}

/**
 * Text in a one-byte Cyrillic code page, read back as Latin-1: "Ðèâêà" for
 * "Ривка". Old ID3 tags carry no encoding worth the name, so this is what a
 * Russian audiobook tagged on Windows looks like. Put right when the text is
 * mostly such letters and turns into Cyrillic when read as Windows-1251;
 * accented Latin - Müller, Émile - has too few of them to qualify.
 */
export function repairMojibake(s: string): string {
  // Only one-byte text can be a misreading of a one-byte code page.
  if (!/^[\u0000-ÿ]*$/.test(s)) return s;
  const high = s.match(/[À-ÿ]/g)?.length ?? 0;
  const letters = s.match(/\p{L}/gu)?.length ?? 0;
  if (high < 2 || high < letters * 0.5) return s;
  let fixed: string;
  try {
    fixed = new TextDecoder('windows-1251', { fatal: true }).decode(
      Uint8Array.from(s, (c) => c.charCodeAt(0)),
    );
  } catch {
    return s;
  }
  const cyrillic = fixed.match(/[Ѐ-ӿ]/g)?.length ?? 0;
  return cyrillic >= high * 0.8 ? fixed : s;
}

/** The value most of the files agree on - at least `share` of them - or null. */
export function consensus(values: (string | null | undefined)[], share = 0.6): string | null {
  const counts = new Map<string, { n: number; value: string }>();
  for (const raw of values) {
    const v = raw?.trim();
    if (!v) continue;
    const key = v.toLocaleLowerCase();
    const c = counts.get(key) ?? { n: 0, value: v };
    c.n += 1;
    counts.set(key, c);
  }
  let best: { n: number; value: string } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  if (!best) return null;
  return best.n >= Math.max(1, Math.ceil(values.length * share)) ? best.value : null;
}

/** A name has letters in it: "02" is a file's number, not its author. */
const plausibleName = (v: string | null): string | null => (v && /\p{L}/u.test(v) ? v : null);

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

function romanToInt(s: string): number | null {
  let total = 0;
  const chars = s.toLowerCase().split('');
  for (let i = 0; i < chars.length; i++) {
    const v = ROMAN[chars[i]!];
    if (!v) return null;
    const next = ROMAN[chars[i + 1] ?? ''] ?? 0;
    total += v < next ? -v : v;
  }
  return total > 0 ? total : null;
}

const toNumber = (s: string): number | null => (/^\d+$/.test(s) ? Number(s) : romanToInt(s));

/**
 * A volume number in a book's folder name: after a word that says so - in
 * the languages ReadPort speaks most - or leading the name. The first of a
 * range: "Books IV-V" is book 4.
 */
export function seriesIndexFrom(name: string): number | null {
  const marked =
    /(?:^|[\s.,(\-_])(?:books?|vol(?:ume)?s?|parts?|steps?|tomes?|band|livre|libro|том|книга|книги|часть|части|ступень|ступени|выпуск)\.?\s*(\d{1,3}|[ivxlcdm]{1,6})(?![\p{L}\d])/iu.exec(
      name,
    );
  if (marked) return toNumber(marked[1]!);
  const leading = /^\s*(\d{1,3})[\s._-]/.exec(name);
  return leading ? Number(leading[1]) : null;
}

/** An Audible ASIN at the end of a folder's name, as Audiobookshelf-style folders carry. */
const ASIN = /\s*[[(]?\bB0[0-9A-Z]{8}\b[\])]?\s*$/;
const tidy = (s: string) => s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

/** What a book's place in the library says about it. */
export function pathFacts(relPath: string, isFile: boolean): AudiobookName {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  const leaf = parts[parts.length - 1] ?? relPath;
  const above = parts.slice(0, -1);
  const name = isFile ? leaf.replace(/\.[^.]+$/, '') : leaf;
  const series = above.length >= 2 ? tidy(above[above.length - 1]!) : null;
  return {
    title: tidy(name.replace(ASIN, '')) || tidy(name),
    author: above.length >= 1 ? tidy(above[0]!) : null,
    series,
    seriesIdx: series ? seriesIndexFrom(name) : null,
  };
}

/**
 * The audiobook's name: the album its files agree on, else - for a book that
 * is one file - that file's title, else its folder's name; the artist its
 * files agree on, else its author folder; and the series its folders say.
 */
export function nameAudiobook(
  relPath: string,
  isFile: boolean,
  tracks: TrackTags[],
): AudiobookName {
  const place = pathFacts(relPath, isFile);
  const album = consensus(tracks.map((t) => t.album));
  const single = tracks.length === 1 ? tracks[0]!.title?.trim() || null : null;
  const artist = consensus(tracks.map((t) => plausibleName(t.artist)));
  return {
    title: album ?? single ?? place.title,
    author: artist ?? place.author,
    series: place.series,
    seriesIdx: place.seriesIdx,
  };
}
