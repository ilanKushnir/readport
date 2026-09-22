import { describe, expect, it } from 'vitest';
import { UI_LOCALES } from '@readport/shared';
import { en } from './messages/en';
import { messageArguments } from './format';

/**
 * Every language carries every key English does, with the same arguments,
 * and its plural branches use categories its own plural rules can produce.
 * A missing key would fall back to English at runtime - quietly, which is
 * exactly why it is loud here.
 */
const files = import.meta.glob<{ default: Record<string, string> }>('./messages/*.ts', {
  eager: true,
});

const locales = UI_LOCALES.map((l) => l.code).filter((c) => c !== 'en');

/**
 * Release notes are the ONE exception to full parity.
 *
 * `whatsnew.release.*` is written when a release is cut and translated
 * afterwards. The runtime already falls back to English for a missing key,
 * so an untranslated line is a line in English rather than a broken dialog -
 * and holding a release until 22 languages have caught up would mean either
 * late releases or machine output nobody looked at. Every other key, the
 * dialog's own chrome included, is still required everywhere.
 *
 * A locale that HAS translated one of these is still checked for arguments
 * and plural categories like anything else; it is only absence that is
 * forgiven.
 */
const OPTIONAL = /^whatsnew\.release\./;
const required = Object.keys(en).filter((k) => !OPTIONAL.test(k));

describe('the English catalog', () => {
  it('has no empty strings and no key used twice across fragments', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, key).not.toBe('');
      expect(key).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_-]+)+$/);
    }
  });
});

describe.each(locales)('locale %s', (code) => {
  const mod = files[`./messages/${code}.ts`];
  it('exists', () => {
    expect(mod, `web/src/i18n/messages/${code}.ts`).toBeDefined();
  });
  if (!mod) return;
  const messages = mod.default;
  it('has every English key and no others', () => {
    const missing = required.filter((k) => !(k in messages));
    const extra = Object.keys(messages).filter((k) => !(k in en));
    expect(missing, 'missing').toEqual([]);
    expect(extra, 'extra').toEqual([]);
  });
  it('uses the same arguments as the English message', () => {
    const wrong: string[] = [];
    for (const [key, value] of Object.entries(en)) {
      const translated = messages[key];
      if (translated === undefined && OPTIONAL.test(key)) continue; // falls back to English
      if (typeof translated !== 'string' || translated === '') {
        wrong.push(`${key}: empty`);
        continue;
      }
      const want = [...messageArguments(value)].sort().join(',');
      const have = [...messageArguments(translated)].sort().join(',');
      if (want !== have) wrong.push(`${key}: {${want}} vs {${have}}`);
    }
    expect(wrong).toEqual([]);
  });
  it('uses plural categories its own rules can select', () => {
    const rules = new Intl.PluralRules(code);
    const categories = new Set(rules.resolvedOptions().pluralCategories);
    const bad: string[] = [];
    for (const [key, value] of Object.entries(messages)) {
      const re = /\{\s*[A-Za-z0-9_]+\s*,\s*plural\s*,([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(value)) !== null) {
        const branches = [...m[1]!.matchAll(/(=\d+|[a-z]+)\s*\{/g)].map((b) => b[1]!);
        if (!branches.includes('other')) bad.push(`${key}: no other branch`);
        for (const b of branches)
          if (!b.startsWith('=') && !categories.has(b as Intl.LDMLPluralRule))
            bad.push(`${key}: ${b} is not a ${code} plural category`);
      }
    }
    expect(bad).toEqual([]);
  });
});
