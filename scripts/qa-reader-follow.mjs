#!/usr/bin/env node
// Real ReaderPage + NarrationBar and CSS, deterministic narration clock/API fixtures.
// No server data or audio backend is used. Run against a local Vite dev server.
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
const base = process.argv[2] ?? 'http://127.0.0.1:5183';
const browser = await browserType.launch({
  executablePath:
    engine === 'chromium' ? process.env.AGENT_BROWSER_EXECUTABLE_PATH || undefined : undefined,
  ignoreDefaultArgs: engine === 'chromium' ? ['--hide-scrollbars'] : [],
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
const shots = process.env.READER_QA_SCREENSHOTS;
/** A relocation in scroll mode glides for GLIDE_MS; geometry read before it lands is mid-flight. */
const settleGlide = (page) => page.waitForTimeout(650);
async function open(
  mode,
  rtl = false,
  reducedMotion = 'no-preference',
  viewport = { width: 1180, height: 820 },
  extraPrefs = {},
) {
  const context = await browser.newContext({
    viewport,
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
    ({ mode, extraPrefs }) =>
      localStorage.setItem(
        'rp-reader-prefs',
        JSON.stringify({ mode, columns: 'two', pageTurn: 'instant', ...extraPrefs }),
      ),
    { mode, extraPrefs },
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
          await page.getByRole('button', { name: 'Table of contents' }).click();
          await page.getByRole('tab', { name: 'Bookmarks & notes · 2' }).click();
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
    await settleGlide(page);
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
    await settleGlide(page);
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
  await paused.page.getByRole('button', { name: 'Table of contents' }).click();
  await paused.page.getByRole('tab', { name: 'Bookmarks & notes · 2' }).click();
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
    await settleGlide(pausedGap.page);
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

  /* ------------------------------------------- the spoken mark, on its line */

  /**
   * The first line of the sentence being spoken, as the text lays it out,
   * beside the boxes the spoken mark drew. The mark is right when its first
   * box is that line box: same top and bottom, starting at the first
   * character, ending where the line's last fragment ends.
   */
  const spokenGeometry = (page, start, end) =>
    page.evaluate(
      async ({ start, end }) => {
        const { buildTextMap, rangeForSpan } = await import('/src/reader/textmap.ts');
        const map = buildTextMap(document.querySelector('.reader-content'));
        const first = rangeForSpan(map, start, start + 1).getBoundingClientRect();
        const line = [...rangeForSpan(map, start, end).getClientRects()]
          .filter((r) => r.height > 0 && Math.abs(r.top - first.top) <= 1)
          .reduce(
            (u, r) => ({
              left: Math.min(u.left, r.left),
              right: Math.max(u.right, r.right),
              top: Math.min(u.top, r.top),
              bottom: Math.max(u.bottom, r.bottom),
            }),
            { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
          );
        const boxes = [...document.querySelectorAll('.spoken-mark > span')].map((s) =>
          s.getBoundingClientRect().toJSON(),
        );
        return {
          line,
          boxes,
          confident: document.querySelector('.spoken-mark')?.dataset.confident,
        };
      },
      { start, end },
    );
  const assertOnLine = (g) => {
    assert(g.boxes.length > 0, 'no spoken mark drawn');
    const b = g.boxes[0];
    const off = Math.max(
      Math.abs(b.top - g.line.top),
      Math.abs(b.bottom - g.line.bottom),
      Math.abs(b.left - g.line.left),
      Math.abs(b.right - g.line.right),
    );
    assert(off <= 1, `spoken mark is ${off.toFixed(2)}px off its line box: ${JSON.stringify(g)}`);
  };
  for (const mode of ['paginated', 'scroll']) {
    const spoken = await open(mode, false, 'no-preference', undefined, { voiceMark: 'wash' });
    await spoken.page.getByRole('button', { name: 'Read along', exact: true }).click();
    const sentence = { ...cue(deep), charEnd: deep + 90, uncertaintyMs: 100 };
    await clock(spoken.page, [sentence]);
    await settleGlide(spoken.page);
    await check(`${mode} spoken mark sits on the line box of the words`, async () => {
      const g = await spokenGeometry(spoken.page, sentence.charStart, sentence.charEnd);
      assert.equal(g.confident, 'yes');
      assertOnLine(g);
      assert(g.boxes.length >= 2, 'a ninety-character sentence wraps: more than one line box');
      if (shots) await spoken.page.screenshot({ path: `${shots}/1180-${mode}-spoken-mark.png` });
    });
    await check(`${mode} spoken mark follows a relayout`, async () => {
      const before = await spokenGeometry(spoken.page, sentence.charStart, sentence.charEnd);
      await spoken.page.setViewportSize({ width: 820, height: 900 });
      await spoken.page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await spoken.page.waitForTimeout(900);
      const after = await spokenGeometry(spoken.page, sentence.charStart, sentence.charEnd);
      assert(
        Math.abs(after.line.left - before.line.left) > 4 ||
          Math.abs(after.line.top - before.line.top) > 4,
        'the fixture must actually have moved the line',
      );
      assertOnLine(after);
    });
    await check(`${mode} spoken mark follows a text size change while paused`, async () => {
      await spoken.page.evaluate(() => window.readerClock({ playing: false }));
      await spoken.page.getByRole('button', { name: 'Reading settings' }).click();
      await spoken.page.getByRole('button', { name: 'Larger text' }).click();
      await spoken.page.getByRole('button', { name: 'Larger text' }).click();
      await spoken.page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
      await spoken.page.waitForTimeout(500);
      const g = await spokenGeometry(spoken.page, sentence.charStart, sentence.charEnd);
      assertOnLine(g);
      assert.equal(
        await spoken.page.locator('.spoken-mark').getAttribute('data-paused'),
        'yes',
        'paused, the mark stays and says so',
      );
    });
    await spoken.context.close();
  }
  const phone = await open(
    'scroll',
    false,
    'no-preference',
    { width: 390, height: 844 },
    { voiceMark: 'wash' },
  );
  await phone.page.getByRole('button', { name: 'Read along', exact: true }).click();
  const phoneSentence = { ...cue(deep), charEnd: deep + 90, uncertaintyMs: 100 };
  await clock(phone.page, [phoneSentence]);
  await settleGlide(phone.page);
  await check('phone spoken mark sits on the line box', async () => {
    assertOnLine(await spokenGeometry(phone.page, phoneSentence.charStart, phoneSentence.charEnd));
    if (shots) await phone.page.screenshot({ path: `${shots}/390-spoken-mark.png` });
  });
  await phone.context.close();

  /* ----------------------------------------------- eased following, scroll */

  const scrollTop = (page) => page.locator('.reader-scroller').evaluate((el) => el.scrollTop);
  /** Where the follow logic will put the scroller so `offset` sits at the anchor line. */
  const followTarget = (page, offset) =>
    page.evaluate(async (offset) => {
      const { buildTextMap, rangeForSpan } = await import('/src/reader/textmap.ts');
      const map = buildTextMap(document.querySelector('.reader-content'));
      const box = document.querySelector('.reader-scroller');
      const r = rangeForSpan(map, offset, offset + 1).getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return Math.min(
        box.scrollHeight - box.clientHeight,
        box.scrollTop + r.top - b.top - b.height * 0.4,
      );
    }, offset);
  const eased = await open('scroll', false, 'no-preference', undefined, { voiceMark: 'wash' });
  await eased.page.getByRole('button', { name: 'Read along', exact: true }).click();
  await check('a follow relocation eases in and out instead of jumping', async () => {
    const from = await scrollTop(eased.page);
    const target = await followTarget(eased.page, deep);
    assert(target - from > 2000, 'the fixture must have a long way to go');
    await eased.page.evaluate(
      (c) => window.readerClock({ cues: [c], cue: c, bookMs: 0, state: 'on' }),
      cue(deep),
    );
    const samples = [];
    for (let i = 0; i < 9; i++) {
      await eased.page.waitForTimeout(60);
      samples.push(await scrollTop(eased.page));
    }
    const moving = samples.filter((s) => s > from + 1 && s < target - 1);
    assert(moving.length >= 3, `expected a glide, saw ${JSON.stringify(samples)}`);
    for (let i = 1; i < samples.length; i++)
      assert(samples[i] >= samples[i - 1], `glide went backwards: ${samples}`);
    // Eased: the first step is smaller than a step from the middle.
    const steps = samples.slice(1).map((s, i) => s - samples[i]);
    assert(steps[0] < Math.max(...steps), `no ease-in: ${JSON.stringify(steps)}`);
    assert(Math.abs(samples.at(-1) - target) <= 1, `did not land: ${samples.at(-1)} vs ${target}`);
    assert.equal(
      await eased.page.getByRole('button', { name: 'Back to the voice', exact: true }).count(),
      0,
      'the glide read as the reader scrolling',
    );
  });
  await check('a wheel mid-glide takes the page back from the voice', async () => {
    const target = await followTarget(eased.page, deep + 30 * (paragraph.length + 1));
    await eased.page.evaluate(
      (c) => window.readerClock({ cues: [c], cue: c, bookMs: 0, state: 'on' }),
      cue(deep + 30 * (paragraph.length + 1)),
    );
    await eased.page.waitForTimeout(120);
    await manualWheel(eased.page);
    await eased.page
      .getByRole('button', { name: 'Back to the voice', exact: true })
      .waitFor({ timeout: 1500 });
    const at = await scrollTop(eased.page);
    await eased.page.waitForTimeout(500);
    assert.equal(await scrollTop(eased.page), at, 'the glide kept going after the wheel');
    assert(Math.abs(at - target) > 10, 'the glide should not have landed');
  });
  await eased.context.close();
  const still = await open('scroll', false, 'reduce');
  await still.page.getByRole('button', { name: 'Read along', exact: true }).click();
  await check('reduced motion relocates at once', async () => {
    const target = await followTarget(still.page, deep);
    await still.page.evaluate(
      (c) => window.readerClock({ cues: [c], cue: c, bookMs: 0, state: 'on' }),
      cue(deep),
    );
    await still.page.waitForTimeout(40);
    assert(Math.abs((await scrollTop(still.page)) - target) <= 1, 'reduced motion must not glide');
  });
  await still.context.close();

  /* ------------------------------------------- the blink at a tap-back */

  for (const viewport of [
    { width: 1180, height: 820 },
    { width: 390, height: 844 },
  ]) {
    const back = await open('scroll', false, 'no-preference', viewport);
    await back.page.getByRole('button', { name: 'Read along', exact: true }).click();
    // Close together, so the earlier sentence is still on a phone's screen
    // once the page has followed the later one.
    const earlier = { ...cue(deep, 0), charEnd: deep + 90 };
    const later = { ...cue(deep + 200, 5000), charEnd: deep + 260 };
    await clock(back.page, [earlier, later], 5500);
    await settleGlide(back.page);
    await check(
      `${viewport.width} tap-back blink appears at the sentence's aligned start`,
      async () => {
        // Tap inside the earlier sentence, well after its first word.
        const r = await rectAt(back.page, deep + 40);
        await back.page.mouse.click((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        await back.page.locator('.blink-mark').waitFor({ timeout: 1000 });
        assert.equal(
          await back.page.locator('.blink-mark').getAttribute('data-start'),
          String(deep),
        );
        const first = await rectAt(back.page, deep);
        const box = await back.page.locator('.blink-mark > span').first().boundingBox();
        assert(
          Math.abs(box.x - first.left) <= 1 && Math.abs(box.y - first.top) <= 1,
          `blink not at the sentence start: ${JSON.stringify({ box, first })}`,
        );
        const fade = await back.page
          .locator('.blink-mark > span')
          .evaluateAll((spans) =>
            spans.map((s) => [
              s.style.getPropertyValue('--rd-fade-from'),
              s.style.getPropertyValue('--rd-fade-to'),
            ]),
          );
        assert.equal(Number(fade[0][0]), 1, 'full at the start of the sentence');
        assert.equal(Number(fade.at(-1)[1]), 0, 'gone by its end');
        await back.page.waitForTimeout(250);
        if (shots) await back.page.screenshot({ path: `${shots}/${viewport.width}-blink.png` });
        const opacity = () =>
          back.page
            .locator('.blink-mark > span')
            .first()
            .evaluate((s) => getComputedStyle(s).opacity);
        const a = await opacity();
        await back.page.waitForTimeout(200);
        assert.notEqual(await opacity(), a, 'the blink must be pulsing');
      },
    );
    await check(`${viewport.width} blink is gone after about two seconds`, async () => {
      await back.page.waitForTimeout(1900);
      assert.equal(await back.page.locator('.blink-mark').count(), 0);
    });
    await back.context.close();
  }
  await check('no runtime page errors', () => assert.deepEqual(errors, []));
  // A sentence the spread ends in the middle of: its start is on the page,
  // so the cue-based follow has nothing to do, and the voice would read the
  // rest from the page after. The pace estimate inside the cue crosses the
  // edge, and the page has to turn then - forward, to the very next page.
  for (const rtl of [false, true]) {
    const { page, context } = await open('paginated', rtl);
    await page.getByRole('button', { name: 'Read along', exact: true }).click();
    // Reading along re-lays the chapter under the transport; measure after.
    await page.waitForSelector('.reader-content #p219', { state: 'attached' });
    await page.waitForTimeout(500);
    const edge = await page.evaluate(async () => {
      const { buildTextMap, rangeForSpan } = await import('/src/reader/textmap.ts');
      const map = buildTextMap(document.querySelector('.reader-content'));
      const box = document.querySelector('.reader-pages').getBoundingClientRect();
      const shown = (at) => {
        const r = rangeForSpan(map, at, at + 1).getBoundingClientRect();
        return (
          r.height > 0 &&
          r.left >= box.left - 1 &&
          r.right <= box.right + 1 &&
          r.top >= box.top - 1 &&
          r.bottom <= box.bottom + 1
        );
      };
      let last = null;
      for (let at = 0; at < 30000; at += 1) {
        if (shown(at)) last = at;
        else if (last !== null && at - last > 300) break;
      }
      return last;
    });
    const visible = (r) =>
      r.left >= 0 && r.right <= 1180 && r.top >= r.boxTop && r.bottom <= r.boxBottom;
    await check(
      `a sentence split across the spread turns the page as the voice crosses ${rtl ? 'RTL' : 'LTR'}`,
      async () => {
        assert(edge !== null, 'the spread must show text');
        const split = {
          id: 'split',
          charStart: edge - 60,
          charEnd: edge + 60,
          startMs: 0,
          endMs: 2000,
          uncertaintyMs: 100,
        };
        // Early in the sentence the voice is on the visible half: no turn.
        await clock(page, [split], 100);
        await page.waitForTimeout(300);
        assert(visible(await rectAt(page, edge)), 'the page stays while the voice is on it');
        assert(
          !visible(await rectAt(page, edge + 42)),
          'the rest of the sentence is off the spread',
        );
        // Most of the way through, the estimate is past the edge: the page turns.
        await clock(page, [split], 1700);
        await page.waitForTimeout(700);
        const r = await rectAt(page, edge + 42);
        assert(visible(r), `the page turns to the spoken half: ${JSON.stringify(r)}`);
        assert(!visible(await rectAt(page, edge - 60)), 'and the page before is gone');
      },
    );
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ passed, failed: failures.length, failures }));
process.exitCode = failures.length ? 1 : 0;
