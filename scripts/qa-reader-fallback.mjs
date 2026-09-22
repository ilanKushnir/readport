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
// QA_BROWSER=webkit runs the same checks in WebKit, the engine on every
// iPhone; the default is Chromium.
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
  'Words enough to fill a page and then some more, so that the chapter runs to several pages of its own. '.repeat(
    3,
  );
const prose = (n) => Array.from({ length: n }, (_, i) => `<p id="p${i}">${paragraph}</p>`).join('');
const tall =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="2400" viewBox="0 0 200 2400">' +
  '<rect width="200" height="2400" fill="#888"/></svg>';
// A picture taller than the page is scaled to the page and the chapter
// still pages; a canvas is left at its size and cannot be broken, so the
// text after it is below the page's foot and the chapter has to scroll.
const figure = `<p id="fig"><img src="data:image/svg+xml;utf8,${encodeURIComponent(tall)}" width="200" height="2400" alt=""></p>`;
const monolith = '<p id="fig"><canvas width="200" height="2400"></canvas></p>';
const chapters = [prose(40), prose(3) + monolith + prose(40), prose(3) + figure + prose(40)];
const count = (paragraph.length + 1) * 40;

async function open(spine, extraPrefs = {}) {
  const context = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((extraPrefs) => {
    localStorage.setItem(
      'rp-reader-prefs',
      JSON.stringify({
        mode: 'paginated',
        columns: 'one',
        pageTurn: 'instant',
        progressBar: 'full',
        ...extraPrefs,
      }),
    );
    localStorage.setItem('rp-readalong-hint', '1');
    // Every change of the page box's class, in order: the fallback going on
    // is one entry, and a page that flaps between the two is many.
    window.flaps = [];
    new MutationObserver((muts) => {
      for (const m of muts)
        if (m.target.classList?.contains('reader-pages'))
          window.flaps.push(m.target.classList.contains('is-unpaginated') ? 'scroll' : 'pages');
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }, extraPrefs);
  // The narration, on a clock the test sets (the same seam as the follow
  // suite): no audio, no aligner.
  await page.route('**/src/reader/Narration.tsx*', async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    assert(body.includes('function useNarration(opts)'), 'narration fixture seam changed');
    body = body.replace('function useNarration(opts)', 'function unusedNarration(opts)');
    body += `\nexport function useNarration() {
      const [n, setN] = useState({ ready: true, playing: true, cue: null, cues: [], bookMs: 0, seekNonce: 0, state: 'gap', speed: 1, backSeconds: 15, element: null, chapterAt: () => null, toggle() {}, back() {}, setSpeed() {}, playFrom() {} });
      window.readerClock = patch => setN(prev => ({ ...prev, ...patch }));
      return n;
    }\n`;
    await route.fulfill({ response, body });
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
          totalChars: count * 3,
          chapters: [0, 1, 2].map((idx) => ({
            idx,
            href: `${idx}.html`,
            title: `Chapter ${idx + 1}`,
            charCount: count,
            cumChars: idx * count,
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
      } else if (p.includes('/sentences/'))
        data = { sentences: [{ id: 's0', start: 0, end: paragraph.length, text: paragraph }] };
      else if (p.endsWith('/annotations')) data = { annotations: [] };
      else if (p === '/api/books/qa')
        data = {
          book: {
            id: 'qa',
            title: 'Fallback',
            pair: { pairId: 'pair', otherBookId: 'audio', status: 'confirmed', switchable: true },
          },
        };
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

  // Engines differ on what a column does with a box it cannot break:
  // Chromium leaves the text after it below the page, and the chapter has
  // to scroll; WebKit carries that text on into the next column, and the
  // chapter pages. Either is fine. What is not fine is a chapter that flaps
  // between the two, or text that can be reached in neither.
  const trapped = await open(1);
  await check('a chapter with a monolithic element settles once and stays settled', async () => {
    await trapped.page.waitForTimeout(3600);
    const settled = await state(trapped.page);
    const flips = settled.flaps.filter((f) => f === 'scroll').length;
    assert(flips <= 1, `the page flapped: ${settled.flaps}`);
    assert.equal(
      settled.scrolls,
      flips === 1,
      `fallback and its class disagree: ${JSON.stringify(settled)}`,
    );
    assert.match(
      settled.footer,
      settled.scrolls ? /^This chapter scrolls$/ : /pages? left|Last page/i,
    );
    assert.deepEqual(trapped.errors, []);
  });
  await check('the text after the monolith is reachable', async () => {
    const scrolls = (await state(trapped.page)).scrolls;
    if (scrolls) {
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
      return;
    }
    // Paged: turn to the end and the last paragraph must be on the page.
    const next = trapped.page.getByRole('button', { name: 'Next page', exact: true }).first();
    for (let i = 0; i < 60; i++) {
      const footer = await trapped.page.locator('.reader-footer-label').textContent();
      if (/Last page|whole chapter/i.test(footer ?? '')) break;
      await next.click({ force: true });
      await trapped.page.waitForTimeout(80);
    }
    const onPage = await trapped.page.evaluate(() => {
      const box = document.querySelector('.reader-pages').getBoundingClientRect();
      const last = document.querySelector('#p39').getBoundingClientRect();
      return {
        onPage:
          last.left >= box.left - 1 && last.right <= box.right + 1 && last.bottom <= box.bottom + 1,
        last: last.toJSON(),
        box: box.toJSON(),
      };
    });
    assert(onPage.onPage, `the last paragraph must end up on a page: ${JSON.stringify(onPage)}`);
  });
  await trapped.context.close();

  // Read-along in the fallback layout: the voice's mark must be there
  // without the reader scrolling first. It was dropped whenever the page
  // was to be driven for the voice, because that branch looked for the
  // scroll-mode box, which the fallback does not have - and came back
  // only once a scroll had detached the following.
  for (const autoScroll of [false, true]) {
    const along = await open(1, { autoScroll });
    await check(
      `the voice's mark shows in the fallback layout before any scroll (auto-scroll ${autoScroll ? 'on' : 'off'})`,
      async () => {
        await along.page.waitForTimeout(1500);
        if (!(await state(along.page)).scrolls) {
          console.log('  (this engine pages the chapter; nothing to check here)');
          return;
        }
        await along.page.getByRole('button', { name: 'Read along', exact: true }).click();
        await along.page.waitForTimeout(250);
        const cues = [
          { id: '1', charStart: 40, charEnd: 48, startMs: 0, endMs: 1000, uncertaintyMs: 1000 },
        ];
        await along.page.evaluate(
          (cues) =>
            window.readerClock({ cues, cue: cues[0], bookMs: 200, state: 'on', playing: true }),
          cues,
        );
        await along.page.waitForTimeout(500);
        const mark = await along.page.evaluate(() => {
          const m = document.querySelector('.pace-marker');
          const pages = document.querySelector('.reader-pages');
          if (!m) return { present: false, scrollTop: pages.scrollTop };
          const r = m.getBoundingClientRect();
          const b = pages.getBoundingClientRect();
          return {
            present: true,
            visible: r.height > 0 && r.top >= b.top && r.bottom <= b.bottom,
            top: Math.round(r.top),
            box: [Math.round(b.top), Math.round(b.bottom)],
            scrollTop: pages.scrollTop,
          };
        });
        assert(mark.present, `the mark must be drawn: ${JSON.stringify(mark)}`);
        assert(mark.visible, `the mark must be on screen: ${JSON.stringify(mark)}`);
        assert.deepEqual(along.errors, []);
      },
    );
    await along.context.close();
  }

  const pictured = await open(2);
  await check('a picture taller than the page is scaled to it and the chapter pages', async () => {
    await pictured.page.waitForTimeout(3600);
    const s = await pictured.page.evaluate(() => {
      const pages = document.querySelector('.reader-pages');
      const img = document.querySelector('#fig img');
      const box = pages.getBoundingClientRect();
      const r = img.getBoundingClientRect();
      return {
        scrolls: pages.classList.contains('is-unpaginated'),
        flaps: window.flaps.slice(),
        fits: r.height > 100 && r.height <= box.height,
        footer: document.querySelector('.reader-footer-label')?.textContent ?? '',
      };
    });
    assert.equal(s.scrolls, false, `fallback on for a picture: ${JSON.stringify(s)}`);
    assert(s.fits, `the picture must be scaled to the page: ${JSON.stringify(s)}`);
    assert.match(s.footer, /pages? left|Last page/i);
    assert.deepEqual(pictured.errors, []);
  });
  await pictured.context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
