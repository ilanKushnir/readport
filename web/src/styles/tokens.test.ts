import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The dark palette is written twice, and the two copies must not drift.
 *
 * They have to be written twice: one applies when someone picks Dark, the
 * other when they leave the app on Auto and their system is dark. Plain CSS
 * has no way to share a declaration list between a selector and a media
 * query, so the duplication is unavoidable - which makes it exactly the kind
 * of thing to assert rather than remember.
 *
 * The cost of drift is not theoretical. Auto is the DEFAULT, so a value fixed
 * only in the explicit block is a value most people never receive.
 */

const CSS = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'tokens.css'),
  'utf8',
);

/** `--name: value` pairs from a block, ignoring comments. */
function declarations(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('/*') || t.startsWith('*')) continue;
    const i = t.indexOf(':');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t
      .slice(i + 1)
      .trim()
      .replace(/;$/, '');
  }
  return out;
}

function block(re: RegExp): Record<string, string> {
  const m = re.exec(CSS);
  expect(m, `block not found: ${re}`).not.toBeNull();
  return declarations(m![1]!);
}

describe('the dark palette', () => {
  const chosen = block(/\[data-app-theme='dark'\] \{\n([\s\S]*?)\n\}\n/);
  const system = block(
    /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-app-theme='light'\]\) \{\n([\s\S]*?)\n {2}\}\n\}\n/,
  );

  it('is actually being read from the stylesheet', () => {
    expect(Object.keys(chosen).length).toBeGreaterThan(10);
    expect(chosen['--rp-text']).toBeTruthy();
  });

  it('says the same thing whether dark was chosen or inherited', () => {
    // Auto is the default, so a value fixed only in the explicit block is a
    // value most people never receive.
    expect(system).toEqual(chosen);
  });
});

describe('colour tokens', () => {
  it('never uses the primary fill as a text colour', () => {
    // --rp-primary is a FILL. Against a raised dark surface it measures about
    // 4.1:1, which is why three one-off `[data-app-theme='dark']` patches
    // existed - and those only applied when dark was chosen explicitly, never
    // on the default Auto. --rp-interactive is the text token and reads in
    // both themes.
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
    const offenders: string[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.css'))) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      text.split('\n').forEach((line, i) => {
        // `border-color:` and `background:` are fine; a bare `color:` is not.
        if (/(^|[^-])color:\s*var\(--rp-primary\)/.test(line)) {
          offenders.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(offenders, `use --rp-interactive for text:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
