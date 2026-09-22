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
        // 44px dock + 8px chrome gap + 12px handles, with rounding clearance.
        scroller.scrollTop += nearBottom ? rects.at(-1).bottom - (bottom - 66) : rects[0].top - 320;
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
  const buttons = await page.locator('.selection-menu button').evaluateAll((buttons) =>
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
  assert.equal(buttons.length, 7, 'all five colors and both text actions present');
  for (const button of buttons) {
    assert(
      button.width >= 44 && button.height >= 44,
      `undersized target ${JSON.stringify(button)}`,
    );
    assert(button.actionable, `occluded action ${button.name}`);
  }
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
      assert.equal(dock.mode, 'dock');
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
        assert.equal(dock.mode, 'dock');
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
        assert.equal(stable.mode, 'dock', 'dock flickered back to floating');
        assert.equal(stable.toolbar.top, dock.toolbar.top, 'dock not stable under reader scroll');
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
} finally {
  await browser.close();
}
console.log(`${passed} passed`);
