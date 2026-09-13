import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every `pattern` attribute we ship has to be a regex the browser can compile.
 *
 * HTML compiles `pattern` with the `v` flag, which is stricter than the `u`
 * flag it replaced: a bare `-` at the end of a character class is now a syntax
 * error. `pattern="[a-zA-Z0-9._-]+"` looked fine, passed review three times,
 * and threw `Invalid character in character class` in the console on every
 * page that rendered it. A pattern that does not compile is simply ignored, so
 * the username fields on the setup wizard, the invite page and the people page
 * silently accepted anything at all - the failure is invisible unless you have
 * the console open.
 *
 * This walks the real source rather than testing a copy of the string, so a
 * new `pattern=` anywhere in the app is covered the day it is written.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) && !e.name.includes('.test.') ? [full] : [];
  });
}

/** Every literal `pattern="…"` in the app, with the file it came from. */
function patternAttributes(): { file: string; pattern: string }[] {
  const found: { file: string; pattern: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bpattern="([^"]+)"/g)) {
      found.push({ file: path.relative(SRC, file), pattern: m[1]! });
    }
  }
  return found;
}

describe('HTML pattern attributes', () => {
  const attrs = patternAttributes();

  it('finds the patterns it is meant to be guarding', () => {
    // If this drops to zero the suite would pass by testing nothing at all.
    expect(attrs.length).toBeGreaterThan(0);
  });

  it.each(attrs)('$file compiles "$pattern" the way a browser does', ({ pattern }) => {
    // Exactly what the HTML spec says a UA does with the attribute.
    expect(() => new RegExp(`^(?:${pattern})$`, 'v')).not.toThrow();
  });

  it('rejects the unescaped hyphen that used to ship', () => {
    // Proof the test above can actually fail, not just pass vacuously.
    expect(() => new RegExp('^(?:[a-zA-Z0-9._-]+)$', 'v')).toThrow();
  });

  it('still validates the usernames it is supposed to', () => {
    const username = attrs.find((a) => a.pattern.includes('a-zA-Z0-9'));
    expect(username, 'the username pattern went missing').toBeDefined();
    const re = new RegExp(`^(?:${username!.pattern})$`, 'v');
    for (const ok of ['ilan', 'a.b_c-d', 'User99']) expect(re.test(ok), ok).toBe(true);
    for (const bad of ['has space', 'sla/sh', 'quote"', '']) expect(re.test(bad), bad).toBe(false);
  });
});
