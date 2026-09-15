#!/usr/bin/env node
/**
 * Lists strings in web/src that look like English shown to a person but do
 * not go through t(): JSX text that starts with a capital letter, quoted
 * aria-label/title/placeholder/alt values, and toast.show('…') literals.
 *
 * Heuristic, not a linter: it will flag a few false positives (a unit like
 * "EPUB", a proper name). Run it after changing UI code and read the output.
 *
 *   node scripts/i18n-audit.mjs [dir]
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'web/src');
const skip = new Set(['i18n', 'test']);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!skip.has(e.name)) walk(path.join(dir, e.name));
      continue;
    }
    if (!/\.(tsx?|mjs)$/.test(e.name) || /\.test\./.test(e.name)) continue;
    files.push(path.join(dir, e.name));
  }
})(root);

const patterns = [
  // JSX text: > Word … <  (allow leading whitespace/newline)
  /[>}]\s*\n?\s*([A-Z][a-z][^<>{}\n]{2,})\s*<\//g,
  /[>]\s*([A-Z][a-z][^<>{}\n]{2,})\s*\n\s*</g,
  /\b(aria-label|title|placeholder|alt)=["']([A-Z][^"']{2,})["']/g,
  /toast\.show\(\s*['"`]([A-Z][^'"`]{2,})['"`]/g,
  /\b(setError|setNotice|setStatus)\(\s*['"`]([A-Z][^'"`]{2,})['"`]/g,
  /(confirm|alert)\(\s*['"`]([A-Z][^'"`]{2,})['"`]/g,
];
const allow = /^(EPUB|M4B|MP3|FLAC|OGG|Opus|AAC|ReadPort|PWA|HTTPS?|ID|URL|OK|CSV|JSON)$/;

let total = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const hits = new Map();
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const text = (m[2] ?? m[1]).trim();
      if (allow.test(text)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      hits.set(`${line}:${text}`, { line, text });
    }
  }
  if (hits.size === 0) continue;
  console.log(`\n${path.relative(process.cwd(), file)}`);
  for (const { line, text } of [...hits.values()].sort((a, b) => a.line - b.line)) {
    console.log(`  ${line}: ${text.length > 90 ? text.slice(0, 87) + '…' : text}`);
    total += 1;
  }
}
console.log(`\n${total} candidate string(s) in ${files.length} files`);
process.exitCode = 0;
