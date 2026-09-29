#!/usr/bin/env node
/**
 * Exporting a book's highlights and notes as a PDF, end to end, against a
 * running server with the sample library (fixtures/library): the English
 * Lantern of Ash Harbor, given a few marks of its own when it has none.
 *
 * Usage:
 *   node scripts/qa-notes-export.mjs [webUrl] [username] [password]
 * Defaults: http://127.0.0.1:5183 astra astra-demo-password-1.
 *
 * Checks the options (chapter names and book order move together, and the
 * sheet says so), the export page (the very pages the server set), Save PDF
 * (a PDF named after the book), a Night export on a phone page (dark to the
 * edge), and the same page in Hebrew (right to left).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = createRequire('/usr/local/lib/node_modules/')('playwright'));
}

const BASE = process.argv[2] ?? 'http://127.0.0.1:5183';
const USER = process.argv[3] ?? 'astra';
const PASS = process.argv[4] ?? 'astra-demo-password-1';

const browser = await chromium.launch({
  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || undefined,
});
let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

// The What's new this build carries, not the server's version: a release's
// entry is written before the version moves.
const changelog = fs.readFileSync(
  new URL('../web/src/whatsnew/changelog.ts', import.meta.url),
  'utf8',
);
const whatsNew = /version: '([\d.]+)'/.exec(changelog)[1];

async function signedIn(viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const login = await context.request.post(`${BASE}/api/auth/login`, {
    data: { username: USER, password: PASS },
    headers: { 'x-rp-csrf': '1' },
  });
  assert.equal(login.status(), 200, `signing in as ${USER}`);
  // The What's new dialog would sit over every click.
  await context.addInitScript((v) => localStorage.setItem('rp-whatsnew-seen', v), whatsNew);
  const page = await context.newPage();
  page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
  return { context, page };
}

const { context, page } = await signedIn({ width: 1280, height: 900 });
const api = (path, opts = {}) =>
  page.request.fetch(`${BASE}${path}`, { ...opts, headers: { 'x-rp-csrf': '1' } });
const { books } = await (await api('/api/library?query=Lantern%20of%20Ash%20Harbor')).json();
const book = books.find((b) => b.kind === 'ebook' && b.language === 'en');
assert.ok(book, 'the sample library has the English Lantern of Ash Harbor');
const BOOK = book.id;
const localeBefore = (await (await api('/api/prefs/locale')).json()).locale ?? null;

// A few marks in two chapters, when the book has none of its own.
const { annotations } = await (await api(`/api/books/${BOOK}/annotations`)).json();
if (annotations.length < 3) {
  const detail = await (await api(`/api/books/${BOOK}`)).json();
  const spines = detail.chapters
    .map((c) => c.spineIdx)
    .filter((s) => s !== null && s !== undefined);
  for (const [i, spineIdx] of [spines[0] ?? 0, spines[0] ?? 0, spines[1] ?? 1].entries()) {
    await api(`/api/books/${BOOK}/annotations`, {
      method: 'POST',
      data: {
        kind: i === 2 ? 'bookmark' : 'highlight',
        color: i === 2 ? null : ['amber', 'sky'][i],
        selectedText: i === 2 ? null : `A marked passage, number ${i + 1}.`,
        note: i === 1 ? 'Worth reading again.' : null,
        locator: { medium: 'ebook', spineIdx, charOffset: 40 + i * 10, pct: 0.1 + i * 0.1 },
      },
    });
  }
}

await check('chapter names and book order move together, and the sheet says so', async () => {
  await page.goto(`${BASE}/notes/${BOOK}`);
  await page.getByRole('button', { name: /Export as PDF/ }).click();
  const sheet = page.getByRole('dialog');
  const names = sheet.getByRole('checkbox', { name: /Chapter names/ });
  assert.equal(await names.isChecked(), true, 'on at first, in book order');
  await sheet.getByRole('button', { name: 'Newest', exact: true }).click();
  assert.equal(await names.isChecked(), false, 'another order leaves them out');
  assert.match(await sheet.locator('.export-notice').innerText(), /only go with book order/);
  await names.check();
  const bookOrder = sheet.getByRole('button', { name: 'Book order', exact: true });
  assert.equal(await bookOrder.getAttribute('aria-pressed'), 'true', 'names bring book order');
  assert.match(await sheet.locator('.export-notice').innerText(), /now in book order/);
  await sheet.getByRole('button', { name: 'Export', exact: true }).click();
  await page.waitForURL(/\/export/);
});

await check('the export page shows the pages the server set', async () => {
  const first = page.locator('.export-page img').first();
  await first.waitFor({ timeout: 30_000 });
  assert.match(await page.locator('.notes-export__title p').innerText(), /\d+ pages?/);
  assert.match((await first.getAttribute('alt')) ?? '', /^Page 1 of \d+$/);
  const svg = await first.evaluate((img) => fetch(img.src).then((r) => r.text()));
  assert.ok(svg.startsWith('<svg'), 'a page is a picture of the page');
  assert.doesNotMatch(svg, /<script|<text/, 'letters are outlines, and nothing runs');
});

await check('Save PDF keeps a PDF named after the book', async () => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save PDF' }).click(),
  ]);
  assert.match(download.suggestedFilename(), /Lantern of Ash Harbor.*\.pdf$/);
  const file = await download.path();
  assert.equal(fs.readFileSync(file).subarray(0, 5).toString('latin1'), '%PDF-');
});
await context.close();

await check('a Night export on a phone page is dark to the edge', async () => {
  const phone = await signedIn({ width: 390, height: 844 });
  await phone.page.goto(`${BASE}/notes/${BOOK}/export?look=night&page=phone`);
  const first = phone.page.locator('.export-page img').first();
  await first.waitFor({ timeout: 30_000 });
  const svg = await first.evaluate((img) => fetch(img.src).then((r) => r.text()));
  // The page's own ground, from edge to edge: 105 x 186 mm in points.
  assert.match(svg, /viewBox="0 0 297\.\d+ 527\.\d+"/);
  assert.match(svg, /<path class="typst-shape" fill="#15120f"/);
  await phone.context.close();
});

await check('in Hebrew the export page runs right to left', async () => {
  const he = await signedIn({ width: 1280, height: 900 });
  const heApi = (path, opts = {}) =>
    he.page.request.fetch(`${BASE}${path}`, { ...opts, headers: { 'x-rp-csrf': '1' } });
  await heApi('/api/prefs/locale', { method: 'PUT', data: { locale: 'he' } });
  try {
    await he.page.goto(`${BASE}/notes/${BOOK}/export`);
    await he.page.locator('.export-page img').first().waitFor({ timeout: 30_000 });
    assert.equal(await he.page.evaluate(() => document.documentElement.dir), 'rtl');
  } finally {
    await heApi('/api/prefs/locale', { method: 'PUT', data: { locale: localeBefore } });
    await he.context.close();
  }
});

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
