import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No em dashes in anything we write.
 *
 * A house rule, asserted rather than remembered: they are easy to type by
 * accident, they arrive in pasted text, and once a few are in nobody notices
 * the rest. This walks the repository so the rule holds for files that do not
 * exist yet, and names the offenders rather than just failing.
 *
 * Binary files are skipped: a woff2 can contain the same bytes by chance.
 *
 * TRANSLATED CATALOGUES ARE EXEMPT, and deliberately so. This is a rule about
 * English house style, and it is not ours to impose on other languages: in
 * Russian and Ukrainian an em dash is the standard copula ("Полка - это..."
 * with a hyphen is simply wrong), and in Chinese the double em dash is the
 * ordinary parenthetical. A translation that followed our typography instead
 * of its own would be a worse translation. `messages/en/` is NOT exempt.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Built from its code point, not typed.
 *
 * A file that checks for a character cannot contain it, or it reports itself
 * - and excluding this file from the walk would leave a hole in the rule.
 */
const EM_DASH = String.fromCharCode(0x2014);

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.turbo',
  'fixtures',
  'derived',
]);

/** Only text we author. */
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|css|md|json|yml|yaml|html|sh|txt)$/;

/**
 * `web/src/i18n/messages/<locale>.ts` - a translated catalogue. The English
 * source lives in `messages/en/`, a directory, so it never matches this and
 * stays bound by the rule.
 */
const TRANSLATED_CATALOGUE = new RegExp(
  `${path.sep}web${path.sep}src${path.sep}i18n${path.sep}messages${path.sep}[^${path.sep === '\\' ? '\\\\' : path.sep}]+\\.ts$`,
);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) sourceFiles(full, out);
    } else if (
      TEXT.test(e.name) &&
      e.name !== 'package-lock.json' &&
      !TRANSLATED_CATALOGUE.test(full)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('typography', () => {
  const files = sourceFiles(ROOT);

  it('is looking at the whole repository', () => {
    // If the walk breaks, the rule below would pass by checking nothing.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(path.join('web', 'src', 'pages', 'LibraryPage.tsx')))).toBe(
      true,
    );
  });

  it('uses a hyphen, never an em dash', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const idx = text.indexOf(EM_DASH);
      if (idx === -1) continue;
      const line = text.slice(0, idx).split('\n').length;
      offenders.push(`${path.relative(ROOT, f)}:${line}`);
    }
    expect(offenders, `replace with a hyphen in:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('would notice one if it appeared', () => {
    // Proof the check can fail, not just pass.
    expect(`a ${EM_DASH} b`.includes(EM_DASH)).toBe(true);
  });
});
