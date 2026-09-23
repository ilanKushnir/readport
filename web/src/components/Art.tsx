import { type CSSProperties } from 'react';
import deviceEmpty from '../assets/art/device-empty.webp';
import friendsEmpty from '../assets/art/friends-empty.webp';
import libraryArriving from '../assets/art/library-arriving.webp';
import libraryEmpty from '../assets/art/library-empty.webp';
import noMatches from '../assets/art/no-matches.webp';
import notesEmpty from '../assets/art/notes-empty.webp';
import readingList from '../assets/art/reading-list.webp';
import shelfEmpty from '../assets/art/shelf-empty.webp';

/**
 * The house prints: small linocut vignettes of a harbour town that keeps
 * books, one for each page that has nothing to show yet.
 *
 * Each file is a mask - black, with the ink in its alpha - so the page
 * prints it in its own colour: terracotta on paper, a lighter terracotta on
 * the dark ground, the system's text colour in forced colours. `w` and `h`
 * are the file's pixels, kept for the aspect ratio.
 */
const ART = {
  'device-empty': { src: deviceEmpty, w: 440, h: 367 },
  'friends-empty': { src: friendsEmpty, w: 440, h: 382 },
  'library-arriving': { src: libraryArriving, w: 440, h: 402 },
  'library-empty': { src: libraryEmpty, w: 440, h: 380 },
  'no-matches': { src: noMatches, w: 440, h: 388 },
  'notes-empty': { src: notesEmpty, w: 440, h: 451 },
  'reading-list': { src: readingList, w: 440, h: 535 },
  'shelf-empty': { src: shelfEmpty, w: 440, h: 200 },
} as const;

export type ArtName = keyof typeof ART;

/** A print, decorative: the words beside it say everything it does. */
export function Art({ name, className }: { name: ArtName; className?: string }) {
  const a = ART[name];
  return (
    <span
      className={`art${className ? ` ${className}` : ''}`}
      style={{ '--art': `url("${a.src}")`, '--art-ratio': a.w / a.h } as CSSProperties}
      aria-hidden="true"
    />
  );
}
