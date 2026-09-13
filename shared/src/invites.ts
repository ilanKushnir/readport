/**
 * Invitation codes people can actually type.
 *
 * An invite used to be 32 characters of base64url in a URL: fine to click,
 * impossible to read down the phone or copy off a screen. Opening a library
 * to friends means someone will want to say "your code is ABCD-EFGH-JKMN",
 * so the code IS the credential and the link merely carries it - one secret,
 * not two that can disagree.
 *
 * Crockford's alphabet: no I, L, O or U. The first three because they are
 * indistinguishable from 1 and 0 in most typefaces, and U so the generator
 * cannot accidentally spell something unfortunate. Twelve characters of it is
 * about 60 bits, which is far past guessing - and the invite endpoint is rate
 * limited on top.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 3;
const PER_GROUP = 4;

/** `ABCD-EFGH-JKMN`. */
export function formatInviteCode(raw: string): string {
  const clean = normalizeInviteCode(raw);
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += PER_GROUP) out.push(clean.slice(i, i + PER_GROUP));
  return out.join('-');
}

/**
 * What a person typed, as the code it was meant to be.
 *
 * Case is ignored, and so is anything that is not a code character - spaces,
 * the dashes, a stray full stop from the end of a sentence. The letters that
 * look like digits are folded onto the digits, because someone reading
 * `ABCD-0FGH` aloud will say "oh" and the person writing it down will type
 * the letter.
 */
export function normalizeInviteCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V')
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, GROUPS * PER_GROUP);
}

/** Whether this could be a code at all, before asking the server. */
export function isInviteCode(raw: string): boolean {
  const clean = normalizeInviteCode(raw);
  return clean.length === GROUPS * PER_GROUP && [...clean].every((c) => ALPHABET.includes(c));
}

/**
 * A fresh code.
 *
 * `randomValues` is injected so the server can pass a CSPRNG and a test can
 * pass a known sequence; there is no default, because a code generated from
 * `Math.random` is not a credential and this must never quietly become one.
 */
export function makeInviteCode(randomValues: (n: number) => Uint8Array): string {
  const n = GROUPS * PER_GROUP;
  const out: string[] = [];
  // Take bytes modulo the alphabet only over a whole number of cycles.
  //
  // With 32 characters this rejects nothing - 32 divides 256, so every byte
  // is already uniform. It is here so that stays true if the alphabet is ever
  // changed: at 33 characters, plain modulo would make the first 25 letters
  // measurably likelier than the rest, and nobody would notice.
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  while (out.length < n) {
    for (const b of randomValues(n)) {
      if (b >= limit) continue;
      out.push(ALPHABET[b % ALPHABET.length]!);
      if (out.length === n) break;
    }
  }
  return formatInviteCode(out.join(''));
}
