#!/usr/bin/env node
// Real ReaderPage/Range geometry with fixture API. Chromium does NOT render the
// iPadOS menu: the photos define the above-selection exclusion contract.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try {
  // A project-local or NODE_PATH install first; the global path is a fallback.
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = createRequire('/usr/local/lib/node_modules/')('playwright'));
}
const base = process.argv[2] ?? 'http://127.0.0.1:5197';
assert(process.env.AGENT_BROWSER_EXECUTABLE_PATH, 'Set AGENT_BROWSER_EXECUTABLE_PATH');
const browser = await chromium.launch({
  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH,
});
let passed = 0;
const passage =
  'The ferry left the harbour an hour late, and the passengers crowded to the rail to watch the lighthouse slide away. Somebody began to hum, and by the time the gulls turned back the whole deck was singing.';
async function open(viewport, direction = 'ltr', touch = true, mode = 'scroll') {
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    ({ mode }) => {
      localStorage.setItem(
        'rp-reader-prefs',
        JSON.stringify({ mode, size: 26, columns: 'one', pageTurn: 'instant', theme: 'night' }),
      );
      localStorage.setItem('rp-readalong-hint', '1');
    },
    { mode },
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const p = new URL(route.request().url()).pathname;
      let data = {};
      if (p.endsWith('/manifest'))
        data = {
          bookId: 'qa',
          title: 'Selection QA',
          language: direction === 'rtl' ? 'he' : 'en',
          direction,
          directionDeclared: true,
          totalChars: 40000,
          chapters: [0, 1].map((idx) => ({
            idx,
            href: `${idx}.html`,
            title: `Chapter ${idx + 1}`,
            charCount: 20000,
            cumChars: idx * 20000,
            sentenceCount: 0,
          })),
          toc: [0, 1].map((spineIdx) => ({
            title: `Chapter ${spineIdx + 1}`,
            spineIdx,
            children: [],
          })),
        };
      else if (p.includes('/chapter/'))
        return route.fulfill({
          contentType: 'text/html',
          body: Array.from(
            { length: 70 },
            (_, i) =>
              `<p id="p${i}">${direction === 'rtl' ? 'המעבורת יצאה מהנמל באיחור של שעה, והנוסעים התקבצו ליד המעקה. '.repeat(4) : passage}</p>`,
          ).join(''),
        });
      else if (p.includes('/sentences/')) data = { sentences: [] };
      else if (p.endsWith('/annotations'))
        data =
          route.request().method() === 'POST'
            ? { annotation: { id: 'qa-mark', ...route.request().postDataJSON() } }
            : { annotations: [] };
      else if (p === '/api/books/qa')
        data = {
          book: {
            id: 'qa',
            title: 'Selection QA',
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
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/qa/reader.tsx"></script></body></html>',
    }),
  );
  await page.goto(`${base}/__reader-qa/qa`);
  await page.waitForSelector('#p69', { state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1700);
  return { context, page, errors };
}
async function select(page, length, backward = false, nearBottom = false) {
  await page.evaluate(
    ({ length, backward, nearBottom }) => {
      const node = document.querySelector(nearBottom ? '#p20' : '#p1').firstChild;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(length, node.length));
      const scroller = document.querySelector('.reader-scroller');
      if (scroller) {
        const rects = [...range.getClientRects()];
        const bottom = document
          .querySelector('.immersive-chrome--bottom')
          .getBoundingClientRect().top;
        // 48px toolbar + 8px chrome gap + 12px handles, with rounding clearance.
        scroller.scrollTop += nearBottom ? rects.at(-1).bottom - (bottom - 70) : rects[0].top - 320;
      }
      const s = getSelection();
      if (backward) s.setBaseAndExtent(node, range.endOffset, node, 0);
      else {
        s.removeAllRanges();
        s.addRange(range);
      }
    },
    { length, backward, nearBottom },
  );
  await page.waitForTimeout(260);
}
async function geometry(page) {
  return page.evaluate(() => {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return {
        left: b.left,
        right: b.right,
        top: b.top,
        bottom: b.bottom,
        width: b.width,
        height: b.height,
      };
    };
    const toolbar = document.querySelector('.selection-menu');
    return {
      toolbar: r(toolbar),
      visible: getComputedStyle(toolbar).visibility,
      mode: toolbar.dataset.placement,
      lines: [...getSelection().getRangeAt(0).getClientRects()]
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
      bottom: r(document.querySelector('.immersive-chrome--bottom')),
      top: r(document.querySelector('.immersive-chrome--top')),
      viewport: {
        left: visualViewport.offsetLeft,
        top: visualViewport.offsetTop,
        width: visualViewport.width,
        height: visualViewport.height,
      },
      text: getSelection().toString(),
    };
  });
}
function assertSafe(g, coarse = true) {
  assert.equal(g.visible, 'visible');
  assert(g.lines.length > 0 && g.text.length > 0);
  const t = g.toolbar;
  assert(
    t.left >= g.viewport.left + 8 - 1 && t.right <= g.viewport.left + g.viewport.width - 8 + 1,
    'horizontal viewport clamp',
  );
  assert(t.top >= Math.max(g.viewport.top + 8, g.top.bottom + 8) - 1, 'top chrome overlap');
  assert(
    t.bottom <= Math.min(g.viewport.top + g.viewport.height - 8, g.bottom.top - 8) + 1,
    'bottom/Read Along overlap',
  );
  for (const line of g.lines)
    assert(
      t.right <= line.left - 12 ||
        t.left >= line.right + 12 ||
        t.bottom <= line.top - 12 ||
        t.top >= line.bottom + 12,
      'selection/handle overlap',
    );
  if (coarse) {
    assert(['below', 'dock'].includes(g.mode), 'coarse toolbar must be below or docked');
    const first = g.lines[0];
    const last = g.lines.at(-1);
    assert(t.top >= last.bottom + 12 || g.mode === 'dock', 'not below final visual line');
    // Conservative photo-derived OS region; this is not an emulated native menu.
    assert(
      t.top >= first.top ||
        t.bottom <= first.top - 96 ||
        t.right <= first.left - 24 ||
        t.left >= first.right + 24,
      'native-menu exclusion overlap',
    );
  }
}
async function assertTouchTargets(page) {
  const measure = () =>
    page.locator('.selection-menu button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const r = button.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          name: button.ariaLabel || button.textContent,
          width: r.width,
          height: r.height,
          actionable: !button.disabled && button.contains(hit),
        };
      }),
    );
  const sized = (buttons) => {
    for (const button of buttons) {
      assert(
        button.width >= 44 && button.height >= 44,
        `undersized target ${JSON.stringify(button)}`,
      );
      assert(button.actionable, `occluded action ${button.name}`);
    }
  };
  let buttons = await measure();
  assert.equal(buttons.length, 4, 'highlight, note, bookmark and share present');
  sized(buttons);
  // The colours sit behind the highlighter: a row of five and the way back.
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await page.waitForTimeout(120);
  const colours = await measure();
  assert.equal(colours.length, 6, 'back and five colours present');
  sized(colours);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.waitForTimeout(80);
  buttons = await measure();
  assert.equal(buttons.length, 4, 'back to the four');
  console.log('PASS computed 44px targets and hit testing', JSON.stringify(buttons));
}
try {
  for (const viewport of [
    { width: 1180, height: 820 },
    { width: 820, height: 1180 },
  ]) {
    const { context, page, errors } = await open(viewport);
    try {
      await page.getByRole('button', { name: 'Read along', exact: true }).click();
      await page.locator('.readalong').waitFor();
      await page.locator('.reader-scroller').evaluate((el) => {
        el.scrollTop = 350;
      });
      await page.waitForTimeout(900);
      const origin = await page.evaluate(async () => {
        const { liveCheckpointOffset } = await import('/src/reader/liveOffset.ts');
        const { buildTextMap } = await import('/src/reader/textmap.ts');
        return liveCheckpointOffset(
          'scroll',
          0,
          buildTextMap(document.querySelector('.reader-content')),
          document.querySelector('.reader-scroller'),
        );
      });
      assert(origin > 0, 'origin must be a meaningful nonzero character');
      await page.getByRole('button', { name: 'Table of contents' }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Chapter 2', exact: true })
        .click();
      await page.locator('.return-pill__go').waitFor();
      const label = await page.locator('.return-pill__go').innerText();
      assert.match(label, /Back to Chapter 1/);
      await page.waitForTimeout(1700);
      // Select visible text without scrolling away from the jump destination:
      // ordinary reading must still be allowed to expire an unrelated return.
      await page.evaluate(() => {
        const bottom = document
          .querySelector('.immersive-chrome--bottom')
          .getBoundingClientRect().top;
        let best = null;
        let distance = Infinity;
        let line = 0;
        for (const p of document.querySelectorAll('.reader-content p')) {
          const node = p.firstChild;
          for (let start = 0; start + 130 <= node.length; start++) {
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + 130);
            const rects = [...range.getClientRects()];
            line = Math.max(line, rects.at(-1).height);
            const delta = Math.abs(rects.at(-1).bottom - (bottom - 62));
            if (rects.length > 1 && delta < distance) {
              best = range;
              distance = delta;
            }
          }
        }
        // Within a line box of the dock zone, not within an arbitrary 24px:
        // text sits on a line grid, so the closest a selection's last line
        // can come to any given y is set by the line height (42px here, and
        // more on a machine whose fonts are taller). A fixed 24px is
        // unsatisfiable at some widths - this is the fixture failing to find
        // a subject, not the toolbar misplacing itself - while a line box
        // keeps what the checks below actually need: a multiline selection
        // ending near the bottom chrome.
        if (!best || distance > Math.max(24, line + 6))
          throw new Error('no near-bottom multiline fixture');
        getSelection().removeAllRanges();
        getSelection().addRange(best);
      });
      await page.waitForTimeout(260);
      const dock = await geometry(page);
      assertSafe(dock);
      // A toolbar small enough to fit under the last line is placed there;
      // only when it cannot does it dock at the foot.
      assert(['below', 'dock'].includes(dock.mode), `near the foot: ${dock.mode}`);
      assert(dock.lines.length > 1);
      assert(dock.lines.at(-1).bottom > dock.bottom.top - 90);
      console.log(
        'RETURN COLLISION',
        JSON.stringify({
          dock,
          pill: await page.evaluate(
            () => document.querySelector('.return-pill')?.getBoundingClientRect().toJSON() ?? null,
          ),
        }),
      );
      assert.equal(
        await page.locator('.return-pill').count(),
        0,
        'return pill must yield to selection',
      );
      await assertTouchTargets(page);
      if (process.env.SELECTION_QA_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.SELECTION_QA_SCREENSHOTS}/${viewport.width}-return-selection.png`,
        });
      // Opening the note sheet deliberately preserves the selected quotation
      // while autofocus collapses the native range. Cancelling must clear the
      // preserved React selection so it cannot suppress the return pill
      // forever; the returnPoint itself must survive unchanged.
      await page.getByRole('button', { name: 'Note', exact: true }).click();
      const noteSheet = page.getByRole('dialog', { name: 'Add note' });
      await noteSheet.waitFor();
      await noteSheet.getByRole('button', { name: 'Close' }).click();
      await page.locator('.selection-menu').waitFor({ state: 'detached' });
      await page.locator('.return-pill__go').waitFor();
      assert.equal(await page.locator('.return-pill__go').innerText(), label);
      await page.locator('.return-pill__go').click();
      await page.waitForFunction(async (origin) => {
        const { idbAll, STORES } = await import('/src/progress/idb.ts');
        const events = (await idbAll(STORES.pendingEvents))
          .map((e) => e.value)
          .sort((a, b) => b.seq - a.seq);
        const lastSeek = events.find((e) => e.intent === 'seek');
        return lastSeek?.locator.spineIdx === 0 && lastSeek.locator.charOffset === origin;
      }, origin);
      assert.equal(await page.locator('.return-pill').count(), 0);
      assert.deepEqual(errors, []);
      console.log(
        'PASS return origin preserved through selection and actionable after clearing',
        viewport.width,
        origin,
      );
      passed++;
    } finally {
      await context.close();
    }
  }
  for (const viewport of [
    { width: 1180, height: 820 },
    { width: 820, height: 1180 },
  ]) {
    for (const direction of ['ltr', 'rtl']) {
      const { context, page, errors } = await open(viewport, direction);
      try {
        for (const [name, length, backward] of [
          ['photo short', 30, false],
          ['photo multiline', 130, false],
          ['backward multiline', 130, true],
        ]) {
          await select(page, length, backward);
          const g = await geometry(page);
          assertSafe(g);
          assert.equal(g.mode, 'below', 'ample space must prefer below, not dock');
          if (process.env.SELECTION_QA_SCREENSHOTS && name !== 'backward multiline') {
            await page.screenshot({
              path: `${process.env.SELECTION_QA_SCREENSHOTS}/${viewport.width}-${direction}-${length}.png`,
            });
          }
          if (length > 30) assert(g.lines.length > 1, 'multiline fixture did not wrap');
          console.log('PASS', viewport.width, direction, name, JSON.stringify(g));
          passed++;
        }
        await page.getByRole('button', { name: 'Read along', exact: true }).click();
        await page.waitForTimeout(250);
        await select(page, 130, false, true);
        const dock = await geometry(page);
        console.log('DOCK', JSON.stringify(dock));
        assert(
          dock.lines.at(-1).bottom > dock.bottom.top - 75,
          'bottom fixture is not near Read Along',
        );
        assertSafe(dock);
        // A toolbar small enough to fit under the last line is placed there;
        // only when it cannot does it dock at the foot.
        assert(['below', 'dock'].includes(dock.mode), `near the foot: ${dock.mode}`);
        await assertTouchTargets(page);
        if (process.env.SELECTION_QA_SCREENSHOTS) {
          await page.screenshot({
            path: `${process.env.SELECTION_QA_SCREENSHOTS}/${viewport.width}-${direction}-dock.png`,
          });
        }
        console.log('PASS Read Along bottom collision', viewport.width, direction);
        passed++;
        await page.locator('.reader-scroller').evaluate((el) => {
          el.scrollTop += 10;
        });
        await page.waitForTimeout(60);
        const stable = await geometry(page);
        assertSafe(stable);
        if (dock.mode === 'dock') {
          assert.equal(stable.mode, 'dock', 'dock flickered back to floating');
          assert.equal(stable.toolbar.top, dock.toolbar.top, 'dock not stable under reader scroll');
        } else {
          // Placed under the selection, it moves with the text it belongs to.
          assert(
            Math.abs(stable.toolbar.top - (dock.toolbar.top - 10)) <= 1.5,
            'floating toolbar did not follow the text',
          );
        }
        console.log('PASS stable dock under reader scroll');
        passed++;
        await page.evaluate(() => getSelection().removeAllRanges());
        await page.waitForTimeout(30);
        await select(page, 30);
        assert.equal((await geometry(page)).mode, 'below', 'new selection did not reset dock');
        const movingVisibility = await page.evaluate(() => {
          const s = getSelection();
          s.extend(s.focusNode, Math.min(s.focusOffset + 10, s.focusNode.length));
          document.dispatchEvent(new Event('selectionchange'));
          return getComputedStyle(document.querySelector('.selection-menu')).visibility;
        });
        assert.equal(
          movingVisibility,
          'hidden',
          'stale toolbar remains visible during handle movement',
        );
        await page.evaluate(() => visualViewport.dispatchEvent(new Event('resize')));
        await page.waitForTimeout(50);
        assert.equal(
          await page.locator('.selection-menu').evaluate((el) => getComputedStyle(el).visibility),
          'hidden',
          'viewport event bypassed selection settlement',
        );
        await page.waitForTimeout(260);
        assertSafe(await geometry(page));
        console.log('PASS handle settlement and selection reset');
        passed++;
        // Model independent visual viewport pan/zoom; this is not physical iOS.
        await page.evaluate(() => {
          for (const [key, value] of Object.entries({
            offsetLeft: 90,
            offsetTop: 100,
            width: 600,
            height: 600,
            scale: 1.5,
          }))
            Object.defineProperty(visualViewport, key, { configurable: true, value });
          visualViewport.dispatchEvent(new Event('resize'));
          visualViewport.dispatchEvent(new Event('scroll'));
        });
        await page.waitForTimeout(60);
        assertSafe(await geometry(page));
        await page.evaluate(() => {
          for (const key of ['offsetLeft', 'offsetTop', 'width', 'height', 'scale'])
            delete visualViewport[key];
          visualViewport.dispatchEvent(new Event('resize'));
        });
        console.log('PASS offset/zoomed visual viewport');
        passed++;
        await page.setViewportSize({ width: viewport.height, height: viewport.width });
        await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
        await page.waitForTimeout(260);
        assertSafe(await geometry(page));
        console.log('PASS orientation recompute');
        passed++;
        const native = await page.locator('#p1').evaluate((el) => {
          const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
          return { allowed: el.dispatchEvent(e), select: getComputedStyle(el).userSelect };
        });
        assert(
          native.allowed && native.select !== 'none',
          'native selection/context menu suppressed',
        );
        const quote = await page.evaluate(() => getSelection().toString());
        await page.getByRole('button', { name: 'Note', exact: true }).click();
        await page.locator('#note-text').fill('Selection span survives native focus changes');
        const posted = page.waitForRequest(
          (r) => r.method() === 'POST' && r.url().endsWith('/annotations'),
        );
        await page.getByRole('button', { name: 'Save note', exact: true }).click();
        const annotation = (await posted).postDataJSON();
        assert.equal(annotation.selectedText, quote, 'note lost selected quotation');
        assert(
          annotation.endLocator.charOffset > annotation.locator.charOffset,
          'note lost selection span',
        );
        console.log('PASS note action preserves selected span');
        passed++;
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  }
  for (const mode of ['scroll', 'paginated']) {
    for (const touch of [false, true]) {
      const { context, page, errors } = await open(
        { width: 1180, height: 820 },
        'ltr',
        touch,
        mode,
      );
      try {
        await select(page, 30);
        const g = await geometry(page);
        assertSafe(g, touch);
        assert.equal(g.mode, touch ? 'below' : 'above');
        if (mode === 'paginated') {
          await page.keyboard.press('PageDown');
          await page.waitForTimeout(260);
          const remaining = await page.locator('.selection-menu').count();
          if (remaining)
            assert.equal(
              await page
                .locator('.selection-menu')
                .evaluate((el) => getComputedStyle(el).visibility),
              'hidden',
              'old page selection toolbar remains visible',
            );
        }
        assert.deepEqual(errors, []);
        console.log('PASS', mode, touch ? 'coarse' : 'fine', 'placement/page movement');
        passed++;
      } finally {
        await context.close();
      }
    }
  }

  /* ------------------------------ room for the platform's own menu, kept */

  {
    const { context, page, errors } = await open({ width: 1180, height: 820 }, 'ltr', true);
    try {
      // Highlighting over and over, with a trackpad selection in the middle -
      // an iPad with a keyboard case, which has both pointers. The device's
      // own Look Up / Translate menu is drawn for the FINGER selections, so
      // every one of them must still have room reserved for it. What used to
      // happen: the trackpad selection recorded "mouse" in a ref nothing ever
      // cleared, every later selection inherited it, the placer stopped
      // reserving that room, and ReadPort's toolbar sat exactly where the
      // platform wanted to draw its menu - so the menu stopped appearing.
      for (let cycle = 0; cycle < 4; cycle++) {
        await select(page, 30 + cycle * 10, false, cycle % 2 === 1);
        assertSafe(await geometry(page), true);
        // The colours sit behind the highlighter now.
        await page.getByRole('button', { name: 'Highlight', exact: true }).click();
        await page.waitForTimeout(80);
        await page.getByRole('button', { name: 'Highlight in amber' }).click();
        await page.waitForTimeout(220);
        // A trackpad click in the text between two finger selections: a whole
        // press and release that selects nothing, and therefore describes
        // nothing about the selection that comes after it.
        if (cycle === 1)
          await page.evaluate(() => {
            const el = document.querySelector('#p1');
            for (const type of ['pointerdown', 'pointerup'])
              el.dispatchEvent(
                new PointerEvent(type, { bubbles: true, pointerType: 'mouse', pointerId: 1 }),
              );
          });
      }
      await select(page, 40);
      assertSafe(await geometry(page), true);
      assert.deepEqual(errors, []);
      console.log('PASS repeated highlighting keeps the native menu room reserved');
      passed++;

      // A transition that starts and never ends - a node leaving the document
      // mid-animation, a property that stops being animated - used to turn the
      // placer into a per-frame forced-layout loop for the rest of the
      // selection's life, which is also how you get iOS to give up on drawing
      // its own edit menu.
      await page.evaluate(() => {
        window.__rafs = 0;
        const raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (cb) => {
          window.__rafs++;
          return raf(cb);
        };
      });
      await select(page, 30);
      await page.evaluate(() =>
        document
          .querySelector('.reader-content')
          .dispatchEvent(new Event('transitionrun', { bubbles: true })),
      );
      await page.waitForTimeout(1000);
      const settled = await page.evaluate(() => window.__rafs);
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => window.__rafs);
      assert(
        after - settled <= 5,
        `an unmatched transitionrun left a per-frame measure loop running (${after - settled} frames in 700ms)`,
      );
      assertSafe(await geometry(page), true);
      assert.deepEqual(errors, []);
      console.log('PASS unmatched transitionrun does not leave a measure loop running');
      passed++;
    } finally {
      await context.close();
    }
  }
  /* ------------------------------- a selection that runs on to the next page */

  /**
   * The frame drawn over a settled selection, its dismiss, and the lines the
   * browser's own selection covers on this page - the truth the frame is
   * checked against.
   */
  async function frameGeometry(page) {
    return page.evaluate(() => {
      const box = document.querySelector('.reader-pages').getBoundingClientRect();
      const lines = [...getSelection().getRangeAt(0).getClientRects()]
        .filter(
          (r) => r.width > 0 && r.height > 0 && r.left >= box.left - 1 && r.right <= box.right + 1,
        )
        .map((r) => r.toJSON());
      return {
        paths: [...document.querySelectorAll('.selframe path')].map((p) =>
          p.getBoundingClientRect().toJSON(),
        ),
        lines,
      };
    });
  }
  function assertFrame(f) {
    assert(f.paths.length > 0 && f.lines.length > 0, 'a settled selection must have a frame');
    // One outline per run of lines, hugging them: every line lies inside an
    // outline's box, and no outline reaches further than the lines it holds
    // (an inset of 2px and a 1.5px stroke, with rounding).
    const slack = 4.5;
    for (const l of f.lines) {
      const inside = f.paths.some(
        (p) =>
          l.left >= p.left - slack &&
          l.right <= p.right + slack &&
          l.top >= p.top - slack &&
          l.bottom <= p.bottom + slack,
      );
      assert(inside, `line outside every outline: ${JSON.stringify({ l, paths: f.paths })}`);
    }
    for (const p of f.paths) {
      const held = f.lines.filter((l) => l.top >= p.top - slack && l.bottom <= p.bottom + slack);
      assert(held.length > 0, `outline around no line: ${JSON.stringify(p)}`);
      const left = Math.min(...held.map((l) => l.left));
      const right = Math.max(...held.map((l) => l.right));
      const top = Math.min(...held.map((l) => l.top));
      const bottom = Math.max(...held.map((l) => l.bottom));
      assert(
        Math.abs(p.left - left) <= slack &&
          Math.abs(p.right - right) <= slack &&
          Math.abs(p.top - top) <= slack &&
          Math.abs(p.bottom - bottom) <= slack,
        `outline off its lines: ${JSON.stringify({ p, left, right, top, bottom })}`,
      );
    }
  }

  for (const viewport of [
    { width: 1180, height: 820 },
    { width: 390, height: 844 },
  ]) {
    const coarse = viewport.width < 600;
    const { context, page, errors } = await open(viewport, 'ltr', coarse, 'paginated');
    try {
      let shareStatus = 200;
      let shareCalls = 0;
      // The share route of a newer API than the fixture's other answers.
      await page.route('**/api/books/qa/share', (route) => {
        shareCalls++;
        return shareStatus === 200
          ? route.fulfill({ json: { url: 'https://readport.test/s/abc', token: 'abc' } })
          : route.fulfill({ status: 404, json: { error: 'not-found' } });
      });
      await page.evaluate(() => {
        // No share sheet here, so the words go to the clipboard - which is
        // recorded rather than read back, since a headless shell has none.
        Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
        Object.defineProperty(Clipboard.prototype, 'writeText', {
          value: (text) => {
            window.__copied = text;
            return Promise.resolve();
          },
          configurable: true,
        });
      });
      await select(page, 30);
      assertSafe(await geometry(page), coarse);
      assertFrame(await frameGeometry(page));
      if (process.env.SELECTION_QA_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.SELECTION_QA_SCREENSHOTS}/${viewport.width}-selection-frame.png`,
        });
      console.log('PASS settled selection frame and dismiss', viewport.width);
      passed++;

      const p1Start = await page.evaluate(async () => {
        const { buildTextMap } = await import('/src/reader/textmap.ts');
        const map = buildTextMap(document.querySelector('.reader-content'));
        return map.nodes.find((n) => n.node.parentElement?.id === 'p1').start;
      });
      // Turning the page with a selection carries its start, not the range.
      await page.keyboard.press('PageDown');
      await page.locator('.continue-pill').waitFor();
      await page.waitForTimeout(260);
      assert.equal(await page.locator('.selection-menu').count(), 0, 'toolbar left with its page');
      assert.equal(await page.locator('.selframe').count(), 0, 'frame left with its page');
      assert(await page.evaluate(() => getSelection().isCollapsed), 'the DOM range was let go');
      assert.equal(await page.locator('.continue-pill__go').getAttribute('aria-pressed'), 'false');
      if (process.env.SELECTION_QA_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.SELECTION_QA_SCREENSHOTS}/${viewport.width}-continue-pill.png`,
        });
      // Back a page and on again: the anchor is kept as long as the pill is.
      await page.keyboard.press('PageUp');
      await page.waitForTimeout(120);
      assert.equal(
        await page.locator('.continue-pill').count(),
        1,
        'going back dropped the anchor',
      );
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(120);
      await page.locator('.continue-pill__go').click();
      assert.equal(await page.locator('.continue-pill__go').getAttribute('aria-pressed'), 'true');
      // Armed: a tap on a word of this page ends the selection there. The
      // furthest word still comfortably on the page - on a phone, high
      // enough to leave the toolbar room under the platform's own menu, as
      // any selection must.
      const target = await page.evaluate(
        async (clearance) => {
          const { buildTextMap, firstVisibleOffset, rangeForSpan } =
            await import('/src/reader/textmap.ts');
          const map = buildTextMap(document.querySelector('.reader-content'));
          const box = document.querySelector('.reader-pages').getBoundingClientRect();
          let best = null;
          for (let at = firstVisibleOffset(map, box) + 100; at < map.totalChars; at += 40) {
            const r = rangeForSpan(map, at, at + 1).getBoundingClientRect();
            if (r.height <= 0 || r.left < box.left || r.right > box.right) break;
            if (r.bottom > box.bottom - clearance) break;
            best = { at, x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
          if (!best) throw new Error('no word on the page to end at');
          return best;
        },
        coarse ? 300 : 120,
      );
      await page.mouse.click(target.x, target.y);
      await page.locator('.selection-menu').waitFor();
      await page.waitForTimeout(300);
      const span = await page.evaluate(async () => {
        const { buildTextMap, domToOffset } = await import('/src/reader/textmap.ts');
        const map = buildTextMap(document.querySelector('.reader-content'));
        const range = getSelection().getRangeAt(0);
        const box = document.querySelector('.reader-pages').getBoundingClientRect();
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        return {
          start: domToOffset(map, range.startContainer, range.startOffset),
          end: domToOffset(map, range.endContainer, range.endOffset),
          before: rects.filter((r) => r.right <= box.left + 1).length,
          here: rects.filter((r) => r.left >= box.left - 1 && r.right <= box.right + 1).length,
          text: getSelection().toString(),
        };
      });
      assert.equal(span.start, p1Start, 'the range starts where the selection began, a page back');
      assert(
        span.end >= target.at,
        `the range ends at the tapped word: ${span.end} < ${target.at}`,
      );
      assert(span.before > 0 && span.here > 0, 'the range must span both pages');
      assert.equal(await page.locator('.continue-pill').count(), 0, 'pill outlived its selection');
      const g = await geometry(page);
      assertSafe(g, coarse);
      assertFrame(await frameGeometry(page));
      // Four icons - highlight, note, bookmark, share - and on a phone each
      // is a finger's size and under nothing.
      assert.equal(await page.locator('.selection-menu button').count(), 4);
      const share = await page
        .getByRole('button', { name: 'Share', exact: true })
        .evaluate((button) => {
          const r = button.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { width: r.width, height: r.height, actionable: button.contains(hit) };
        });
      assert(share.actionable, 'share button occluded');
      if (coarse) assert(share.width >= 44 && share.height >= 44, JSON.stringify(share));
      if (process.env.SELECTION_QA_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.SELECTION_QA_SCREENSHOTS}/${viewport.width}-toolbar-share.png`,
        });
      console.log(
        'PASS cross-page selection ends on the next page',
        viewport.width,
        span.start,
        span.end,
      );
      passed++;

      // Share, with no share sheet: composed and copied, the quote trimmed at a word.
      await page.getByRole('button', { name: 'Share', exact: true }).click();
      await page.waitForFunction(() => typeof window.__copied === 'string');
      const shared = await page.evaluate(() => window.__copied);
      assert.equal(shareCalls, 1, 'one share link requested');
      // The message: the lead, the quotation on its own lines, the link on
      // its own line, and the quotation whole - a reader who chose a passage
      // wants the passage to arrive.
      const lead = 'Look what I read in Selection QA:\n\n“';
      assert(shared.startsWith(lead), shared);
      assert(shared.endsWith('”\n\nhttps://readport.test/s/abc'), shared);
      const quote = shared.slice(lead.length, shared.indexOf('”\n\nhttps'));
      const prose = span.text.replace(/\s+/g, ' ').trim();
      assert.equal(quote.replace(/\s+/g, ' ').trim(), prose, 'the selection is quoted whole');
      assert.equal(
        await page.locator('.toast').innerText(),
        'Copied - paste it anywhere',
        'the copy is announced',
      );
      // A server without share links: the words still go, without the link.
      shareStatus = 404;
      await page.evaluate(() => {
        delete window.__copied;
      });
      await page.getByRole('button', { name: 'Share', exact: true }).click();
      await page.waitForFunction(() => typeof window.__copied === 'string');
      const unlinked = await page.evaluate(() => window.__copied);
      assert(
        unlinked.endsWith('”'),
        `no link means no trailing space either: ${JSON.stringify(unlinked.slice(-12))}`,
      );
      assert.equal(shareCalls, 2);
      console.log('PASS share composes and copies, with and without a link', viewport.width);
      passed++;

      // Escape lets the selection go: the frame has no dismiss of its own.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(260);
      assert(await page.evaluate(() => getSelection().isCollapsed), 'Escape must clear the range');
      assert.equal(await page.locator('.selection-menu').count(), 0);
      assert.equal(await page.locator('.selframe').count(), 0);
      // Escape drops a carried selection rather than leaving the book. The
      // selection is made on the page the reader is on now, not on #p1.
      await page.evaluate(async () => {
        const { buildTextMap, firstVisibleOffset, offsetToDom } =
          await import('/src/reader/textmap.ts');
        const map = buildTextMap(document.querySelector('.reader-content'));
        const box = document.querySelector('.reader-pages').getBoundingClientRect();
        const pos = offsetToDom(map, firstVisibleOffset(map, box) + 40);
        const range = document.createRange();
        range.setStart(pos.node, pos.offset);
        range.setEnd(pos.node, Math.min(pos.node.data.length, pos.offset + 30));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      await page.locator('.selection-menu').waitFor();
      await page.waitForTimeout(260);
      if (coarse) await page.keyboard.press('PageDown');
      else {
        // A click at the page's edge turns it - and the press collapses the
        // selection first, so the turn has to carry what was just selected.
        const box = await page.locator('.reader-pages').boundingBox();
        await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2);
      }
      await page.locator('.continue-pill').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(60);
      assert.equal(await page.locator('.continue-pill').count(), 0, 'Escape must drop the anchor');
      assert.equal(
        await page.locator('.reader-content').count(),
        1,
        'Escape must not leave the reader',
      );
      assert.deepEqual(errors, []);
      console.log('PASS dismiss and Escape', viewport.width);
      passed++;
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`${passed} passed`);
