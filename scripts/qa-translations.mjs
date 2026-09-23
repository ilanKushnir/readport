#!/usr/bin/env node
/**
 * The same book in other languages, end to end, against a running server
 * with the sample library (fixtures/library): the English Lantern of Ash
 * Harbor and its invented Russian translation.
 *
 * Usage:
 *   node scripts/qa-translations.mjs [webUrl] [username] [password]
 * Defaults: http://127.0.0.1:5183 astra astra-demo-password-1 (a curator or
 * an admin: linking is a curator's job).
 *
 * Links the two through the book page's sheet (by searching, so a guess
 * dismissed on an earlier run does not matter), then checks the "Also in"
 * row on both, carrying the place from the English reader into the Russian
 * one, and a passage shown in the other language from a selection.
 */
import assert from 'node:assert/strict';
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

const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const login = await context.request.post(`${BASE}/api/auth/login`, {
  data: { username: USER, password: PASS },
  headers: { 'x-rp-csrf': '1' },
});
assert.equal(login.status(), 200, `signing in as ${USER}`);
const version = (await (await context.request.get(`${BASE}/api/health`)).json()).version;
// The What's new dialog would sit over every click.
await context.addInitScript((v) => localStorage.setItem('rp-whatsnew-seen', v), version);
const page = await context.newPage();
page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
const api = (path, opts = {}) =>
  page.request.fetch(`${BASE}${path}`, { ...opts, headers: { 'x-rp-csrf': '1' } });
const idOf = async (query, language) => {
  const { books } = await (await api(`/api/library?query=${encodeURIComponent(query)}`)).json();
  const book = books.find((b) => b.kind === 'ebook' && b.language === language);
  assert.ok(book, `the sample library has "${query}" in ${language}`);
  return book.id;
};
const EN = await idOf('Lantern of Ash Harbor', 'en');
const RU = await idOf('Фонарь', 'ru');

// Start from two books that are not linked.
await api(`/api/books/${RU}/translations/${EN}`, { method: 'DELETE' });

await check('a curator links the translation from the book page, by searching', async () => {
  await page.goto(`${BASE}/book/${RU}`);
  await page.getByRole('button', { name: 'Languages' }).click();
  await page.getByPlaceholder('Title or author').fill('Lantern');
  const row = page.locator('.sheet .edition-row', { hasText: 'The Lantern of Ash Harbor' });
  await row.getByRole('button', { name: 'Link' }).click();
  await page.waitForSelector('.sheet #tr-linked');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.also-in__chip');
  assert.match(await page.locator('.also-in').innerText(), /English/);
});

await check('the other book names this one', async () => {
  await page.goto(`${BASE}/book/${EN}`);
  await page.waitForSelector('.also-in__chip');
  assert.match(await page.locator('.also-in').innerText(), /Russian/);
});

await check('the paragraphs are matched in the background', async () => {
  let match = 'pending';
  for (let i = 0; i < 30 && match === 'pending'; i++) {
    const { titles } = await (await api(`/api/books/${EN}/translations`)).json();
    match = titles[0]?.match;
    if (match === 'pending') await page.waitForTimeout(500);
  }
  assert.equal(match, 'close');
});

await check('the reader carries its place into the other language', async () => {
  await page.goto(`${BASE}/read/${EN}?spine=2&char=0`);
  await page.waitForSelector('.reader-content p');
  await page.getByRole('button', { name: 'Other languages' }).click();
  await Promise.all([
    page.waitForURL(new RegExp(`/read/${RU}\\?spine=2&`)),
    page.getByRole('button', { name: 'Read in Russian from here' }).click(),
  ]);
  await page.waitForSelector('.reader-content p');
  const toast = await page.locator('.toast').innerText();
  assert.match(toast, /same paragraph of the English edition/);
  // A new book is a new page: nothing of the English one is left open.
  assert.equal(await page.locator('.sheet').count(), 0);
});

await check('a selection is shown as the other language has it', async () => {
  await page.goto(`${BASE}/read/${RU}?spine=1&char=0`);
  await page.waitForSelector('.reader-content p');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const p = document.querySelectorAll('.reader-content p')[1];
    const text = [...p.childNodes].find((n) => n.nodeType === 3);
    const range = document.createRange();
    range.setStart(text, 5);
    range.setEnd(text, 40);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
  });
  await page.getByRole('button', { name: 'Show in English' }).click();
  await page.waitForSelector('.peek p');
  assert.match(await page.locator('.peek').innerText(), /fog horn/);
  assert.equal(await page.locator('.peek').getAttribute('lang'), 'en');
  // The paragraph it matches is marked on the page behind.
  assert.equal(await page.evaluate(() => CSS.highlights.get('rp-peek')?.size), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => CSS.highlights.get('rp-peek')?.size ?? 0), 0);
});

await browser.close();
console.log(JSON.stringify({ passed, failed: failures.length, failures }));
process.exit(failures.length ? 1 : 0);
