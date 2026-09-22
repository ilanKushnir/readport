/**
 * A chapter that cannot be paged falls back to scrolling once, and stays.
 *
 * A replaced element is monolithic: the columns of a page cannot break it,
 * so one taller than the page traps everything after it below the page's
 * foot, and the reader lets that chapter scroll instead. The judgement used
 * to be made again on every settling pass, in whatever layout was current -
 * and a scrolling chapter has nothing trapped, so it went back into columns,
 * where it was trapped again, and so on at the speed of a render: the text
 * and the footer blinking between the two while the tab ground to a halt.
 *
 * Run against the Vite dev host:
 *   node scripts/qa-reader-fallback.mjs http://localhost:5183
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
const base = process.argv[2] ?? 'http://127.0.0.1:5191';
const browser = await chromium.launch({
  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || undefined,
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
  'Words enough to fill a page and then some more, so that the chapter runs to several pages of its own. '.repeat(
    3,
  );
const prose = (n) => Array.from({ length: n }, (_, i) => `<p id="p${i}">${paragraph}</p>`).join('');
const tall =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="2400" viewBox="0 0 200 2400">' +
  '<rect width="200" height="2400" fill="#888"/></svg>';
const figure = `<p id="fig"><img src="data:image/svg+xml;utf8,${encodeURIComponent(tall)}" width="200" height="2400" alt=""></p>`;
const chapters = [prose(40), prose(3) + figure + prose(40)];
const count = (paragraph.length + 1) * 40;

async function open(spine) {
  const context = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem(
      'rp-reader-prefs',
      JSON.stringify({
        mode: 'paginated',
        columns: 'one',
        pageTurn: 'instant',
        progressBar: 'full',
      }),
    );
    // Every change of the page box's class, in order: the fallback going on
    // is one entry, and a page that flaps between the two is many.
    window.flaps = [];
    new MutationObserver((muts) => {
      for (const m of muts)
        if (m.target.classList?.contains('reader-pages'))
          window.flaps.push(m.target.classList.contains('is-unpaginated') ? 'scroll' : 'pages');
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['class'] });
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const p = new URL(route.request().url()).pathname;
      let data = {};
      if (p.endsWith('/manifest'))
        data = {
          bookId: 'qa',
          title: 'Fallback',
          language: 'en',
          direction: 'ltr',
          directionDeclared: true,
          totalChars: count * 2,
          chapters: [0, 1].map((idx) => ({
            idx,
            href: `${idx}.html`,
            title: `Chapter ${idx + 1}`,
            charCount: count,
            cumChars: idx * count,
            sentenceCount: 1,
          })),
          toc: [0, 1].map((spineIdx) => ({
            title: `Chapter ${spineIdx + 1}`,
            spineIdx,
            children: [],
          })),
        };
      else if (p.includes('/chapter/')) {
        const idx = Number(/\/chapter\/(\d+)/.exec(p)?.[1] ?? 0);
        return route.fulfill({ contentType: 'text/html', body: chapters[idx] ?? chapters[0] });
      } else if (p.includes('/sentences/'))
        data = { sentences: [{ id: 's0', start: 0, end: paragraph.length, text: paragraph }] };
      else if (p.endsWith('/annotations')) data = { annotations: [] };
      else if (p === '/api/books/qa') data = { book: { id: 'qa', title: 'Fallback', pair: null } };
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
  await page.waitForSelector('.reader-content p', { state: 'attached' });
  return { context, page, errors };
}

const state = (page) =>
  page.evaluate(() => {
    const pages = document.querySelector('.reader-pages');
    return {
      flaps: window.flaps.slice(),
      scrolls: pages.classList.contains('is-unpaginated'),
      footer: document.querySelector('.reader-footer-label')?.textContent ?? '',
      reach: pages.scrollHeight - pages.clientHeight,
    };
  });

try {
  const plain = await open(0);
  await check('a chapter of prose is paged and stays paged', async () => {
    await plain.page.waitForTimeout(3600);
    const s = await state(plain.page);
    assert.equal(s.scrolls, false, `fallback on for prose: ${JSON.stringify(s)}`);
    assert.equal(s.flaps.filter((f) => f === 'scroll').length, 0, `flaps ${s.flaps}`);
    assert.match(s.footer, /pages? left|Last page/i);
    assert.deepEqual(plain.errors, []);
  });
  await plain.context.close();

  const trapped = await open(1);
  await check('a chapter with a monolithic figure falls back to scrolling once', async () => {
    await trapped.page.waitForFunction(
      () => document.querySelector('.reader-pages')?.classList.contains('is-unpaginated'),
      null,
      { timeout: 5000 },
    );
    const first = await state(trapped.page);
    assert.equal(first.flaps.filter((f) => f === 'scroll').length, 1, `flaps ${first.flaps}`);
    // The settling passes keep coming for another few seconds; none of
    // them may put the chapter back into columns.
    await trapped.page.waitForTimeout(3600);
    const settled = await state(trapped.page);
    assert.equal(settled.scrolls, true, `fallback lifted: ${JSON.stringify(settled)}`);
    assert.equal(
      settled.flaps.filter((f) => f === 'scroll').length,
      1,
      `the page flapped: ${settled.flaps}`,
    );
    assert.equal(settled.footer, 'This chapter scrolls');
    assert.deepEqual(trapped.errors, []);
  });
  await check('the text after the figure is reachable by scrolling', async () => {
    const reached = await trapped.page.evaluate(() => {
      const pages = document.querySelector('.reader-pages');
      pages.scrollTop = pages.scrollHeight;
      const last = document.querySelector('#p39').getBoundingClientRect();
      const box = pages.getBoundingClientRect();
      return {
        reach: pages.scrollHeight - pages.clientHeight,
        inBox: last.bottom <= box.bottom + 1,
      };
    });
    assert(reached.reach > 1000, `the box must scroll: ${JSON.stringify(reached)}`);
    assert(reached.inBox, `the last paragraph must come into view: ${JSON.stringify(reached)}`);
  });
  await trapped.context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
