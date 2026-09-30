#!/usr/bin/env node
/**
 * The library on a phone, against a running server with the sample library
 * (fixtures/library): coming back to it, the plus on its covers, and an app
 * that does not zoom.
 *
 * Usage:
 *   node scripts/qa-library-return.mjs [webUrl] [username] [password]
 * Defaults: http://127.0.0.1:5183 astra astra-demo-password-1 (a curator or
 * an admin, for the Languages sheet).
 *
 * Opens a book from the middle of the grid and comes back - by Back and by
 * the Library tab - and checks the book's card is where it was, with the
 * search it was found by; that the Library tab tapped on the library still
 * goes to the top; that the plus sits on the cover's bottom corner rather
 * than on the title; and that nothing zooms: the viewport, the page's touch
 * rules, and a search field large enough that iOS does not zoom to it.
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

const changelog = fs.readFileSync(
  new URL('../web/src/whatsnew/changelog.ts', import.meta.url),
  'utf8',
);
const whatsNew = /version: '([\d.]+)'/.exec(changelog)[1];

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const login = await context.request.post(`${BASE}/api/auth/login`, {
  data: { username: USER, password: PASS },
  headers: { 'x-rp-csrf': '1' },
});
assert.equal(login.status(), 200, `signing in as ${USER}`);
await context.addInitScript((v) => localStorage.setItem('rp-whatsnew-seen', v), whatsNew);
const page = await context.newPage();
page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));

const pane = () => page.locator('main.app-main');
/** Where a book's card is, below the top of the scrolling pane. */
const offsetOf = (id) =>
  page.evaluate((id) => {
    const main = document.querySelector('main.app-main');
    const card = document.querySelector(`.book-card[data-book="${id}"]`);
    return card
      ? Math.round(card.getBoundingClientRect().top - main.getBoundingClientRect().top)
      : null;
  }, id);
/** Scroll the pane so the nth card sits `offset` pixels below its top, and name its book. */
const bringCard = (n, offset) =>
  page.evaluate(
    ({ n, offset }) => {
      const main = document.querySelector('main.app-main');
      const card = document.querySelectorAll('.book-card[data-book]')[n];
      main.scrollTop +=
        card.getBoundingClientRect().top - main.getBoundingClientRect().top - offset;
      return card.dataset.book;
    },
    { n, offset },
  );
const openCard = (id) => page.locator(`.book-card[data-book="${id}"] .book-card__link`).click();
/** The phone's tab bar, not the rail's hidden copy of the same link. */
const libraryTab = () => page.locator('a[href="/"]:visible', { hasText: 'Library' }).first();

await page.goto(`${BASE}/`);
await page.locator('.book-card[data-book]').nth(3).waitFor();

await check('the plus sits on the cover’s bottom corner, clear of the title', async () => {
  const g = await page.evaluate(() => {
    const card = document.querySelector('.book-card[data-book]');
    const cover = card.querySelector('.book-card__coverwrap').getBoundingClientRect();
    const add = card.querySelector('.book-card__add').getBoundingClientRect();
    const title = card.querySelector('.book-card__title').getBoundingClientRect();
    return {
      right: cover.right - add.right,
      bottom: cover.bottom - add.bottom,
      clear: add.bottom <= title.top,
      size: add.width,
    };
  });
  assert.equal(Math.round(g.right), 8, 'an inset from the cover’s end edge');
  assert.equal(Math.round(g.bottom), 8, 'an inset from the cover’s foot');
  assert.ok(g.clear, 'above the title');
  assert.equal(g.size, 44, 'a finger’s width on a touch screen');
});

await check('Back returns to the book that was opened, where it was', async () => {
  const id = await bringCard(3, 260);
  await page.waitForTimeout(300);
  const before = await offsetOf(id);
  await openCard(id);
  await page.waitForURL(`**/book/${id}`);
  await page.goBack();
  await page.locator(`.book-card[data-book="${id}"]`).waitFor();
  await page.waitForTimeout(600);
  assert.equal(await offsetOf(id), before);
});

await check('the Library tab returns there too, and tapped again goes to the top', async () => {
  const id = await bringCard(1, 140);
  await page.waitForTimeout(300);
  const before = await offsetOf(id);
  await openCard(id);
  await page.waitForURL(`**/book/${id}`);
  await libraryTab().click();
  await page.locator(`.book-card[data-book="${id}"]`).waitFor();
  await page.waitForTimeout(600);
  assert.equal(await offsetOf(id), before);
  await libraryTab().click();
  await page.waitForFunction(() => document.querySelector('main.app-main').scrollTop === 0, null, {
    timeout: 4000,
  });
});

await check('a search comes back with the place it found', async () => {
  const search = page.locator('main input[type="search"]').first();
  await search.fill('the');
  await page.waitForTimeout(900);
  const count = await page.locator('.book-card[data-book]').count();
  const id = await bringCard(count - 1, 200);
  await page.waitForTimeout(300);
  const before = await offsetOf(id);
  await openCard(id);
  await page.waitForURL(`**/book/${id}`);
  await page.goBack();
  await page.locator(`.book-card[data-book="${id}"]`).waitFor();
  await page.waitForTimeout(600);
  assert.equal(await search.inputValue(), 'the');
  assert.equal(await page.locator('.book-card[data-book]').count(), count);
  assert.equal(await offsetOf(id), before);
  await search.fill('');
  await page.waitForTimeout(600);
});

await check('the app does not zoom, and a sheet’s search does not zoom it either', async () => {
  const viewport = await page.getAttribute('meta[name="viewport"]', 'content');
  assert.match(viewport, /maximum-scale=1/);
  assert.match(viewport, /user-scalable=no/);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).touchAction),
    'pan-x pan-y',
  );
  const id = await page.locator('.book-card[data-book]').first().getAttribute('data-book');
  await page.goto(`${BASE}/book/${id}`);
  await page.getByRole('button', { name: 'Languages' }).click();
  const field = page.locator('.edition-search input');
  await field.focus();
  const size = await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(size >= 16, `the search field is ${size}px`);
  assert.equal(await page.evaluate(() => visualViewport.scale), 1);
});

await pane().count();
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
