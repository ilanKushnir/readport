import { common } from './common';
import { shell } from './shell';
import { auth } from './auth';
import { library } from './library';
import { reader } from './reader';
import { player } from './player';
import { pairs } from './pairs';
import { people } from './people';
import { settings } from './settings';
import { notes } from './notes';

/**
 * The English catalog: every string the interface shows, as `area.key`.
 *
 * Split by surface so the file a screen's words live in is the file that
 * screen is named after; merged here into the one flat map the runtime and
 * the other languages' files are checked against. English is the source:
 * a key added here is a key every other locale is expected to carry, and
 * the test beside the catalog says so.
 */
export const en = {
  ...common,
  ...shell,
  ...auth,
  ...library,
  ...reader,
  ...player,
  ...pairs,
  ...people,
  ...settings,
  ...notes,
} as const;

export type MessageKey = keyof typeof en;
