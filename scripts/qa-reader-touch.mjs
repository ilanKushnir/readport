/**
 * Every page of a paged chapter turns under a finger, wherever it lands.
 *
 * A paged chapter is one strip of columns slid sideways to show a page, and
 * the strip's own box is its first page only. Taps and swipes used to be
 * read on the strip, so from the second page on a finger on empty paper -
 * below a chapter's last line, around a picture - reached the page box
 * underneath and nothing at all happened: no turn by a swipe, none by the
 * edge, no controls. A chapter that was one full-page picture made the
 * worst of it, because the printer's flower after the picture spilled onto
 * a page of its own: a blank page, entirely empty paper, that could not be
 * turned either way.
 *
 * Run against the Vite dev host:
 *   node scripts/qa-reader-touch.mjs http://localhost:5183
 * QA_BROWSER=webkit runs it in WebKit (no swipe there: Playwright cannot
 * send WebKit a touch drag, so the swipe check is Chromium's).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const engine = process.env.QA_BROWSER === 'webkit' ? 'webkit' : 'chromium';
let browserType;
try {
  browserType = require('playwright')[engine];
} catch {
  browserType = createRequire('/usr/local/lib/node_modules/')('playwright')[engine];
}
const base = process.argv[2] ?? 'http://127.0.0.1:5191';
const browser = await browserType.launch({
  executablePath:
    engine === 'chromium' ? process.env.AGENT_BROWSER_EXECUTABLE_PATH || undefined : undefined,
});
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

const paragraph =
  'The keeper wrote the weather down each evening, the wind and the colour of the water, and what the lamp had needed. '.repeat(
    2,
  );
const prose = (n) => Array.from({ length: n }, (_, i) => `<p id="p${i}">${paragraph}</p>`).join('');
// A frontispiece: one picture the height of the page, as publishers set them.
const plate =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1600" viewBox="0 0 1000 1600">' +
  '<rect width="1000" height="1600" fill="#2f4a5c"/><circle cx="500" cy="700" r="260" fill="#8c3f1f"/></svg>';
const picture = `<div class="coverpage"><img src="data:image/svg+xml;utf8,${encodeURIComponent(plate)}" height="98%" alt=""></div>`;
const chapters = [picture, prose(7), prose(3)];
const counts = [0, (paragraph.length + 1) * 7, (paragraph.length + 1) * 3];

async function open(spine) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 664 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: engine === 'chromium',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem(
      'rp-reader-prefs',
      JSON.stringify({ mode: 'paginated', columns: 'one', pageTurn: 'instant' }),
    );
    localStorage.setItem('rp-readalong-hint', '1');
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const p = new URL(route.request().url()).pathname;
      let data = {};
      if (p.endsWith('/manifest'))
        data = {
          bookId: 'qa',
          title: 'Touch',
          language: 'en',
          direction: 'ltr',
          directionDeclared: true,
          totalChars: counts.reduce((a, b) => a + b, 0),
          chapters: [0, 1, 2].map((idx) => ({
            idx,
            href: `${idx}.html`,
            title: `Chapter ${idx + 1}`,
            charCount: counts[idx],
            cumChars: counts.slice(0, idx).reduce((a, b) => a + b, 0),
            sentenceCount: 1,
          })),
          toc: [0, 1, 2].map((spineIdx) => ({
            title: `Chapter ${spineIdx + 1}`,
            spineIdx,
            children: [],
          })),
        };
      else if (p.includes('/chapter/')) {
        const idx = Number(/\/chapter\/(\d+)/.exec(p)?.[1] ?? 0);
        return route.fulfill({ contentType: 'text/html', body: chapters[idx] ?? chapters[0] });
      } else if (p.includes('/sentences/')) data = { sentences: [] };
      else if (p.endsWith('/annotations')) data = { annotations: [] };
      else if (p === '/api/books/qa') data = { book: { id: 'qa', title: 'Touch', pair: null } };
      else if (p === '/api/progress/qa') data = { state: null };
      else if (p === '/api/progress/events') data = { results: [], state: null };
      await route.fulfill({ json: data });
    },
  );
  await page.route('**/__reader-qa/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/qa/reader.tsx"></script></body></html>`,
    }),
  );
  await page.goto(`${base}/__reader-qa/qa?spine=${spine}&char=0`);
  await page.waitForSelector('.reader-content', { state: 'attached' });
  await page.waitForTimeout(1200);
  return { context, page, errors };
}

/** Which chapter is on the page, which page of it, and how many it has. */
const where = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('.reader-content');
    const stride = document.querySelector('.reader-pages').getBoundingClientRect().width;
    const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(c).transform);
    const tx = m ? Number(m[1].split(',')[4]) : 0;
    return {
      chapter: c.querySelector('img') ? 0 : c.querySelectorAll('p').length === 7 ? 1 : 2,
      page: Math.round(-tx / stride),
      pages: Math.round(c.scrollWidth / stride),
      flowerless: 'flowerless' in c.dataset,
    };
  });

/** A point on empty paper - no text, no picture - near the bottom of the page. */
const emptyPaper = (page, xShare) =>
  page.evaluate((xShare) => {
    const x = Math.round(innerWidth * xShare);
    for (let y = Math.round(innerHeight * 0.8); y > innerHeight * 0.3; y -= 10) {
      const el = document.elementFromPoint(x, y);
      if (el && !el.closest('p, img')) return { x, y };
    }
    return null;
  }, xShare);

async function toLastPage(page) {
  for (let i = 0; i < 8; i++) {
    const before = await where(page);
    if (before.page >= before.pages - 1) return before;
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(250);
  }
  return where(page);
}

try {
  const plate = await open(0);
  await check(
    'a chapter that is one picture is one page, with no blank page after it',
    async () => {
      const s = await where(plate.page);
      assert.equal(s.chapter, 0);
      assert.equal(s.pages, 1, `the picture's chapter has ${s.pages} pages`);
      assert.equal(s.flowerless, true, 'the flower was not set aside');
      assert.deepEqual(plate.errors, []);
    },
  );
  await plate.context.close();

  const edge = await open(1);
  await check('an edge tap on empty paper turns a later page', async () => {
    const last = await toLastPage(edge.page);
    assert(last.page >= 1, `the prose did not run past its first page: ${JSON.stringify(last)}`);
    const spot = await emptyPaper(edge.page, 0.95);
    assert(spot, 'no empty paper at the edge of the last page');
    await edge.page.touchscreen.tap(spot.x, spot.y);
    await edge.page.waitForTimeout(700);
    assert.equal((await where(edge.page)).chapter, 2, 'the tap did not turn the page');
  });
  await edge.context.close();

  const middle = await open(1);
  await check('a tap on empty paper in the middle of a later page shows the controls', async () => {
    await toLastPage(middle.page);
    const shown = () =>
      middle.page.evaluate(() =>
        document.querySelector('.reader-page, .reader-root')?.className.includes('chrome-hidden'),
      );
    const before = await shown();
    const spot = await emptyPaper(middle.page, 0.5);
    assert(spot, 'no empty paper in the middle of the last page');
    await middle.page.touchscreen.tap(spot.x, spot.y);
    await middle.page.waitForTimeout(500);
    assert.notEqual(await shown(), before, 'the tap did nothing');
  });
  await middle.context.close();

  if (engine === 'chromium') {
    const swipe = await open(1);
    await check('a swipe on empty paper turns a later page', async () => {
      await toLastPage(swipe.page);
      const spot = await emptyPaper(swipe.page, 0.8);
      assert(spot, 'no empty paper to swipe on');
      const cdp = await swipe.context.newCDPSession(swipe.page);
      const at = (x) => [{ x, y: spot.y }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(spot.x) });
      for (let i = 1; i <= 6; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: at(spot.x - i * 35),
        });
        await swipe.page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await swipe.page.waitForTimeout(700);
      assert.equal((await where(swipe.page)).chapter, 2, 'the swipe did not turn the page');
    });
    await swipe.context.close();
  }
} finally {
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
