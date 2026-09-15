#!/usr/bin/env node
// Real ReaderPage + NarrationBar and CSS, deterministic narration clock/API fixtures.
// No server data or audio backend is used. Run against a local Vite dev server.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = createRequire('/usr/local/lib/node_modules/')('playwright'));
}
const base = process.argv[2] ?? 'http://127.0.0.1:5183';
const browser = await chromium.launch({
  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || undefined,
  ignoreDefaultArgs: ['--hide-scrollbars'],
});
const failures = [];
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed++;
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const paragraph =
  'A measured passage with enough words to wrap across several lines, keeping every character addressable in this long chapter. '.repeat(
    3,
  );
const html = Array.from({ length: 220 }, (_, i) => `<p id="p${i}">${paragraph}</p>`).join('');
const chars = (paragraph.length + 1) * 220;
const deep = (paragraph.length + 1) * 180 + 37;
const cue = (start, startMs = 0) => ({
  id: String(start),
  charStart: start,
  charEnd: start + 8,
  startMs,
  endMs: startMs + 1000,
  uncertaintyMs: 1000,
});
const errors = [];
async function open(mode, rtl = false, reducedMotion = 'no-preference') {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    reducedMotion,
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|websocket/.test(m.text()))
      console.log('CONSOLE', m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) console.log('HTTP', r.status(), r.url());
  });
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('PAGEERROR', e.message);
  });
  await page.addInitScript(
    ({ mode }) =>
      localStorage.setItem(
        'rp-reader-prefs',
        JSON.stringify({ mode, columns: 'two', pageTurn: 'instant' }),
      ),
    { mode },
  );
  await page.route('**/src/reader/Narration.tsx*', async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    assert(body.includes('function useNarration(opts)'), 'narration fixture seam changed');
    body = body.replace('function useNarration(opts)', 'function unusedNarration(opts)');
    // `chapterAt` is part of the narration seam now: the book's per-chapter
    // time bounds, so a return can open the chapter the voice is actually in
    // instead of attaching to the nearest cue of whatever is on screen. It
    // answers null when the bounds are not loaded - which is what the real
    // hook does here, since this fixture serves no /api/pairs/:id/chapters -
    // and ReaderPage calls it whenever the voice is before or after this
    // chapter's timings.
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
      const url = new URL(route.request().url());
      let data = {};
      if (url.pathname.endsWith('/manifest'))
        data = {
          bookId: 'qa',
          title: 'Fixture',
          language: rtl ? 'he' : 'en',
          direction: rtl ? 'rtl' : 'ltr',
          directionDeclared: true,
          totalChars: chars * 2,
          chapters: [0, 1].map((idx) => ({
            idx,
            href: `${idx}.html`,
            title: `Chapter ${idx}`,
            charCount: chars,
            cumChars: idx * chars,
            sentenceCount: 0,
          })),
          toc: [],
        };
      else if (url.pathname.includes('/chapter/'))
        return route.fulfill({ contentType: 'text/html', body: html });
      else if (url.pathname.includes('/sentences/')) data = { sentences: [] };
      else if (url.pathname.endsWith('/annotations'))
        data = {
          annotations: [0, 1].map((spineIdx) => ({
            id: `b${spineIdx}`,
            kind: 'bookmark',
            locator: {
              medium: 'ebook',
              spineIdx,
              charOffset: deep,
              pct: (spineIdx * chars + deep) / (chars * 2),
            },
            selectedText: `Deep bookmark ${spineIdx}`,
            createdAt: '2026-01-01T00:00:00Z',
          })),
        };
      else if (url.pathname === '/api/books/qa')
        data = {
          book: {
            id: 'qa',
            pair: { pairId: 'pair', otherBookId: 'audio', status: 'confirmed', switchable: true },
          },
        };
      await route.fulfill({ json: data });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith('/__reader-qa/'),
    (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module" src="/qa/reader.tsx"></script></body></html>`,
      }),
  );
  await page.goto(`${base}/__reader-qa/qa?spine=0&char=0`);
  await page.waitForSelector('#p219', { state: 'attached' });
  await page.waitForTimeout(400);
  return { page, context };
}
/**
 * Manual scrolling gestures, driven for real.
 *
 * The reader detaches on evidence of INTENT, not on any event of the right
 * name (ReaderPage.tsx `onWheelCapture` / `onTouchMoveCapture`): a wheel
 * carrying no deltaY is a momentum tail, one with ctrlKey is a pinch, and a
 * touch that has not travelled past TOUCH_SLOP_PX is the jitter of a tap.
 * None of those is a reader taking the wheel, and none of them detaches any
 * more - deliberately, so that a pinch-zoom or a tap on the page no longer
 * silently stops the page following the voice.
 *
 * `locator.dispatchEvent('wheel')` constructs a WheelEvent with deltaY 0 and
 * `dispatchEvent('touchmove')` one with no touches at all, so both are now
 * correctly ignored. These drive the genuine article instead: a real wheel
 * over the scroller, and a real one-finger drag past the slop threshold.
 */
async function manualWheel(page) {
  const box = await page.locator('.reader-scroller').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(50);
}
async function manualTouchDrag(page) {
  const box = await page.locator('.reader-scroller').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  await send('touchStart', [{ x, y }]);
  // Well past TOUCH_SLOP_PX (8), in two steps, as a finger actually moves.
  await send('touchMove', [{ x, y: y - 20 }]);
  await send('touchMove', [{ x, y: y - 60 }]);
  await send('touchEnd', []);
  await cdp.detach();
  await page.waitForTimeout(50);
}
async function rectAt(page, offset) {
  return page.evaluate(async (offset) => {
    const { buildTextMap, rangeForSpan } = await import('/src/reader/textmap.ts');
    const r = rangeForSpan(
      buildTextMap(document.querySelector('.reader-content')),
      offset,
      offset + 1,
    ).getBoundingClientRect();
    const b = document.querySelector('.reader-viewport').getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      height: r.height,
      boxTop: b.top,
      boxBottom: b.bottom,
    };
  }, offset);
}
async function clock(page, cues, bookMs = 0) {
  let state = 'gap';
  let active = null;
  if (cues.length > 0) {
    const ordered = [...cues].sort((a, b) => a.startMs - b.startMs);
    const first = ordered[0];
    const previous = [...ordered].reverse().find((c) => c.startMs <= bookMs) ?? null;
    if (bookMs < first.startMs) state = bookMs < first.startMs - 2500 ? 'before' : 'hold';
    else if (previous && bookMs < previous.endMs) {
      state = 'on';
      active = previous;
    } else if (previous) {
      const next = ordered[ordered.indexOf(previous) + 1];
      if (!next) state = bookMs <= previous.endMs + 2500 ? 'hold' : 'after';
      else state = bookMs <= previous.endMs + 2500 ? 'hold' : 'gap';
    }
  }
  await page.evaluate(
    ({ cues, bookMs, active, state }) =>
      window.readerClock({
        cues,
        cue: active,
        bookMs,
        state,
      }),
    { cues, bookMs, active, state },
  );
  await page.waitForTimeout(70);
}
try {
  for (const rtl of [false, true]) {
    const { page, context } = await open('paginated', rtl);
    await page.getByRole('button', { name: 'Read along', exact: true }).click();
    const offsets = await page.evaluate(async () => {
      const { buildTextMap, rangeForSpan } = await import('/src/reader/textmap.ts');
      const map = buildTextMap(document.querySelector('.reader-content'));
      const box = document.querySelector('.reader-pages').getBoundingClientRect();
      const result = [null, null];
      for (let at = 0; at < 8000; at += 10) {
        const r = rangeForSpan(map, at, at + 1).getBoundingClientRect();
        if (r.left >= box.left && r.right <= box.right && r.height > 0) {
          const col = (r.left + r.right) / 2 < (box.left + box.right) / 2 ? 0 : 1;
          result[col] ??= at;
        }
        if (result.every((x) => x !== null)) break;
      }
      return result;
    });
    await check(`two-column marker ${rtl ? 'RTL' : 'LTR'}`, async () => {
      assert(
        offsets.every((x) => x !== null),
        'fixture must occupy both columns',
      );
      const positions = [];
      for (const offset of offsets) {
        await clock(page, [cue(offset)]);
        const r = await rectAt(page, offset);
        const marker = await page.locator('.pace-marker').boundingBox();
        assert(marker, 'visible cue must have marker');
        assert(
          rtl ? marker.x >= r.right : marker.x + marker.width <= r.left,
          'marker must be outside text on reading-start side',
        );
        positions.push(marker.x);
      }
      assert(positions[1] - positions[0] > 300, `marker must change column, got ${positions}`);
      await page.screenshot({ path: `qa-reader-${rtl ? 'rtl' : 'ltr'}.png` });
    });
    await check(`off-spread marker hidden ${rtl ? 'RTL' : 'LTR'}`, async () => {
      await page.keyboard.press('PageDown');
      await page.getByRole('button', { name: 'Back to the voice', exact: true }).waitFor();
      await clock(page, [cue(deep)]);
      assert.equal(await page.locator('.pace-marker').count(), 0);
    });
    await context.close();
  }
  for (const mode of ['paginated', 'scroll']) {
    for (const rtl of [false, true]) {
      const { page, context } = await open(mode, rtl);
      for (const spine of [0, 1, 0]) {
        await check(`bookmark ${mode} ${rtl ? 'RTL' : 'LTR'} chapter ${spine}`, async () => {
          await page.getByRole('button', { name: 'Bookmarks and notes (2)' }).click();
          await page.getByText(`Deep bookmark ${spine}`, { exact: true }).click();
          await page.waitForTimeout(350);
          const r = await rectAt(page, deep);
          assert(
            r.top >= r.boxTop && r.bottom <= r.boxBottom && r.left >= 0 && r.right <= 1180,
            `exact locator not visible: ${JSON.stringify(r)}`,
          );
          assert.equal(await page.locator('.reader-title').innerText(), `Chapter ${spine}`);
        });
      }
      await context.close();
    }
  }
  for (const gesture of ['wheel', 'touchmove', 'PageDown']) {
    const { page, context } = await open('scroll');
    await page.getByRole('button', { name: 'Read along', exact: true }).click();
    await clock(page, [cue(0)]);
    await page.getByRole('button', { name: 'Scroll with the voice', exact: true }).click();
    await check(`manual ${gesture} disables auto-scroll and stays detached`, async () => {
      if (gesture === 'PageDown') await page.keyboard.press('PageDown');
      else if (gesture === 'wheel') await manualWheel(page);
      else await manualTouchDrag(page);
      await page
        .getByRole('button', { name: 'Scroll with the voice', exact: true })
        .waitFor({ timeout: 1500 });
      assert.equal(
        await page.getByRole('button', { name: 'Scroll with the voice', exact: true }).count(),
        1,
      );
      await clock(page, [cue(0)], 100);
      assert.equal(
        await page.getByRole('button', { name: 'Back to the voice', exact: true }).count(),
        1,
      );
      assert.equal(await page.getByRole('button', { name: 'Pause narration' }).count(), 1);
    });
    await context.close();
  }
  const { page, context } = await open('scroll');
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  await manualWheel(page);
  await check('failed return keeps target visible', async () => {
    await page.getByRole('button', { name: 'Back to the voice', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Back to the voice', exact: true }).count(),
      1,
    );
  });
  await check('paused detached reader still has a return target', async () => {
    await page.evaluate(() => window.readerClock({ playing: false }));
    await page.waitForTimeout(70);
    assert.equal(
      await page.getByRole('button', { name: 'Back to the voice', exact: true }).count(),
      1,
    );
  });
  await page.evaluate(() => window.readerClock({ playing: true }));
  await check('invalid cue cannot attach by clamping to chapter end', async () => {
    await clock(page, [cue(chars + 100)]);
    await page.getByRole('button', { name: 'Back to the voice', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Back to the voice', exact: true }).count(),
      1,
    );
  });
  await manualWheel(page);
  // A genuine gap: between two timed cues, which is what this check is about
  // and what its paused twin below already drives. A single cue 4s ahead of
  // the clock is the 'before' state, not a gap, and that state now means
  // something else: the voice is outside this chapter's timings, so the
  // return consults the book's chapter bounds - and where there are none to
  // consult (this fixture, an older server) a playing narration attaches and
  // lets the walker carry the page to it, rather than landing the reader on
  // this chapter's nearest cue and calling that the voice.
  await clock(page, [cue(deep - 1000, 0), cue(deep, 10000)], 6000);
  await check('gap return relocates to nearest honest cue before attaching', async () => {
    await page.getByRole('button', { name: 'Back to the voice', exact: true }).click();
    const r = await rectAt(page, deep);
    assert(r.top >= r.boxTop && r.bottom <= r.boxBottom);
    assert.equal(
      await page.getByRole('button', { name: 'Back to the voice', exact: true }).count(),
      0,
    );
  });
  await manualWheel(page);
  await page.evaluate(() => {
    document.querySelector('.reader-scroller').scrollTop = 0;
  });
  await clock(page, [cue(deep)]);
  await check('auto-scroll recenters before enabling', async () => {
    await page.getByRole('button', { name: 'Scroll with the voice', exact: true }).click();
    const r = await rectAt(page, deep);
    assert(
      r.top >= r.boxTop && r.bottom <= r.boxBottom,
      'narration remains offscreen after enabling',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Back to the voice', exact: true }).count(),
      0,
    );
  });
  await context.close();
  const reduced = await open('scroll', false, 'reduce');
  await reduced.page.getByRole('button', { name: 'Read along', exact: true }).click();
  await clock(reduced.page, [cue(deep)]);
  await reduced.page.getByRole('button', { name: 'Scroll with the voice', exact: true }).click();
  await check(
    'reduced motion recenter leaves truthful off control and free scrolling',
    async () => {
      const control = reduced.page.getByRole('button', {
        name: 'Scroll with the voice',
        exact: true,
      });
      assert.equal(await control.count(), 1, 'continuous scrolling must remain off');
      assert.equal(await control.getAttribute('aria-pressed'), 'false');
      const style = await reduced.page.locator('.reader-scroller').evaluate((el) => ({
        overflow: getComputedStyle(el).overflowY,
        touch: getComputedStyle(el).touchAction,
      }));
      assert.equal(style.overflow, 'auto');
      assert.notEqual(style.touch, 'pan-x');
    },
  );
  await check('reduced motion has no continuous scroll drift', async () => {
    const y = await reduced.page.locator('.reader-scroller').evaluate((el) => el.scrollTop);
    await clock(reduced.page, [cue(deep + 400)]);
    await reduced.page.waitForTimeout(500);
    assert.equal(await reduced.page.locator('.reader-scroller').evaluate((el) => el.scrollTop), y);
  });
  await reduced.context.close();
  const paused = await open('scroll');
  await paused.page.getByRole('button', { name: 'Read along', exact: true }).click();
  await clock(paused.page, [cue(deep)], 500);
  await paused.page.getByRole('button', { name: 'Bookmarks and notes (2)' }).click();
  await paused.page.getByText('Deep bookmark 1', { exact: true }).click();
  await paused.page.waitForFunction(
    () => document.querySelector('.reader-title')?.textContent === 'Chapter 1',
  );
  await paused.page.evaluate(() => window.readerClock({ playing: false }));
  await clock(paused.page, [cue(deep, 10000)], 500);
  await check(
    'paused cross-chapter return cannot attach to nearest cue in wrong chapter',
    async () => {
      await paused.page.getByRole('button', { name: 'Back to the voice', exact: true }).click();
      assert.equal(
        await paused.page.getByRole('button', { name: 'Back to the voice', exact: true }).count(),
        1,
      );
      assert.equal(
        await paused.page.getByRole('button', { name: 'Play narration', exact: true }).count(),
        1,
      );
    },
  );
  await paused.context.close();
  const pausedGap = await open('scroll');
  await pausedGap.page.getByRole('button', { name: 'Read along', exact: true }).click();
  await manualWheel(pausedGap.page);
  await pausedGap.page.evaluate(() => window.readerClock({ playing: false }));
  await clock(pausedGap.page, [cue(deep - 1000, 0), cue(deep, 10000)], 6000);
  await check('paused same-chapter gap returns to the nearest honest cue', async () => {
    await pausedGap.page.getByRole('button', { name: 'Back to the voice', exact: true }).click();
    const r = await rectAt(pausedGap.page, deep);
    assert(r.top >= r.boxTop && r.bottom <= r.boxBottom);
    assert.equal(
      await pausedGap.page.getByRole('button', { name: 'Back to the voice', exact: true }).count(),
      0,
    );
  });
  await pausedGap.context.close();
  const manual = await open('scroll');
  await manual.page.getByRole('button', { name: 'Read along', exact: true }).click();
  await clock(manual.page, [cue(deep)]);
  await check('programmatic narration relocation stays attached after scroll event', async () => {
    await manual.page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(
      await manual.page.getByRole('button', { name: 'Back to the voice', exact: true }).count(),
      0,
    );
  });
  await check('scroll-only manual movement detaches without wheel or touch', async () => {
    // Native scrollbar/assistive scrolling emits scroll, not wheel/touchmove.
    await manual.page.locator('.reader-scroller').evaluate(
      (el) =>
        new Promise((resolve) => {
          el.addEventListener('scroll', () => requestAnimationFrame(resolve), { once: true });
          el.scrollTop += 180;
        }),
    );
    assert.equal(
      await manual.page.getByRole('button', { name: 'Back to the voice', exact: true }).count(),
      1,
    );
    assert.equal(
      await manual.page.getByRole('button', { name: 'Pause narration', exact: true }).count(),
      1,
    );
  });
  await manual.context.close();
  const scrollbar = await open('scroll');
  await scrollbar.page.getByRole('button', { name: 'Read along', exact: true }).click();
  await clock(scrollbar.page, [cue(deep)]);
  await manualWheel(scrollbar.page);
  await scrollbar.page.getByRole('button', { name: 'Back to the voice', exact: true }).click();
  await scrollbar.page.addStyleTag({
    content:
      '.reader-scroller { scrollbar-gutter: stable; } .reader-scroller::-webkit-scrollbar { width: 18px; }',
  });
  await check('native scrollbar pointer movement detaches following', async () => {
    const geometry = await scrollbar.page.locator('.reader-scroller').evaluate((el) => {
      const b = el.getBoundingClientRect();
      return {
        x: b.right - 9,
        y: b.top + el.clientHeight / 2,
        gutter: el.offsetWidth - el.clientWidth,
        top: el.scrollTop,
      };
    });
    assert(geometry.gutter > 0, 'fixture requires an actual scrollbar gutter');

    await scrollbar.page.mouse.move(geometry.x, geometry.y);
    await scrollbar.page.mouse.down();
    await scrollbar.page.mouse.move(geometry.x, geometry.y - 60, { steps: 5 });
    await scrollbar.page.mouse.up();

    await scrollbar.page
      .getByRole('button', { name: 'Back to the voice', exact: true })
      .waitFor({ timeout: 1500 });
    assert.notEqual(
      await scrollbar.page.locator('.reader-scroller').evaluate((el) => el.scrollTop),
      geometry.top,
    );
  });
  await scrollbar.context.close();
  await check('no runtime page errors', () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
}
console.log(JSON.stringify({ passed, failed: failures.length, failures }));
process.exitCode = failures.length ? 1 : 0;
