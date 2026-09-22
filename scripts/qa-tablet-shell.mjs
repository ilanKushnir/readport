#!/usr/bin/env node
// Real App/Shell/ReadingListPage, fixture API only. No production data is touched.
// Run against Vite: node scripts/qa-tablet-shell.mjs http://127.0.0.1:5185
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = createRequire('/usr/local/lib/node_modules/')('playwright'));
}
const base = process.argv[2] ?? 'http://127.0.0.1:5185';
assert((await fetch(`${base}/@vite/client`)).ok, 'Start the Vite dev server first');
const browser = await chromium.launch({
  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || undefined,
});
let failed = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
async function open(viewport) {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const items = Array.from({ length: 36 }, (_, i) => ({
    book: {
      id: `b${i}`,
      title: `Queue book ${i}`,
      author: 'Selectable author',
      kind: 'ebook',
      coverUrl: null,
    },
    note: 'Selectable queue note',
  }));
  const shelves = Array.from({ length: 32 }, (_, i) => ({
    id: `s${i}`,
    name: `Shelf ${i}`,
    count: 2,
  }));
  const commits = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    let data = {};
    if (route.request().method() === 'PATCH')
      commits.push({ path, body: route.request().postDataJSON() });
    if (path === '/api/auth/me')
      // `whatsNewSeen` far ahead: a fixture account has read every release,
      // so the release dialog never lands its backdrop on the queue.
      data = {
        user: { id: 'tablet-qa', username: 'qa', role: 'user' },
        needsLibraries: false,
        whatsNewSeen: '999.0.0',
      };
    if (path === '/api/shelves')
      data = {
        shelves,
        auto: [],
        readingList: { count: items.length, nextTitle: items[0].book.title },
      };
    if (path === '/api/facets') data = { groups: [] };
    if (path === '/api/prefs/sidebar') data = { sidebar: { chosen: true, facets: [] } };
    if (path === '/api/reading-list') data = { items, missingCount: 0 };
    if (path === '/api/library')
      data = { books: items.map((i) => i.book), continueRail: [], scanActive: false };
    await route.fulfill({ json: data });
  });
  await page.goto(`${base}/reading-list`);
  await page.waitForSelector('.queue-row:last-child').catch(async (e) => {
    console.log('BOOT', errors, await page.locator('body').innerText());
    throw e;
  });
  await page.waitForTimeout(150);
  return { context, page, errors, commits };
}
async function geometry(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        client: el.clientHeight,
        scroll: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
    };
    return {
      height: visualViewport.height,
      width: visualViewport.width,
      root: rect(document.documentElement),
      documentBody: rect(document.body),
      shell: rect(document.querySelector('.app-shell')),
      body: rect(document.querySelector('.app-body')),
      header: rect(document.querySelector('.app-header')),
      main: rect(document.querySelector('.app-main')),
      rail: rect(document.querySelector('.app-rail')),
      y: scrollY,
    };
  });
}
async function panes(page, label, lastMain = '.queue-row:last-child') {
  const g = await geometry(page);
  console.log('PANES', label, JSON.stringify(g));
  assert(g.rail.client > 0, 'persistent rail hidden');
  assert.equal(g.shell.top, 0);
  assert(Math.abs(g.shell.bottom - g.height) <= 1, 'shell outside viewport');
  assert.equal(g.rail.top, g.header.bottom);
  assert.equal(g.main.top, g.header.bottom);
  assert(Math.abs(g.main.bottom - g.height) <= 1, 'main outside viewport');
  assert(Math.abs(g.rail.bottom - g.height) <= 1, 'rail outside viewport');
  assert(g.root.scroll <= g.height + 1, 'root scroll overflow');
  for (const [target, other, last] of [
    ['.app-rail', '.app-main', '.sidebar__foot'],
    ['.app-main', '.app-rail', lastMain],
  ]) {
    const otherTop = await page.locator(other).evaluate((el) => el.scrollTop);
    await page.locator(target).evaluate((el) => (el.scrollTop = el.scrollHeight));
    const at = await page
      .locator(target)
      .evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    assert(at.max > 0, 'fixture does not overflow');
    assert(Math.abs(at.top - at.max) <= 1, 'exact bottom unreachable');
    assert.equal(await page.locator(other).evaluate((el) => el.scrollTop), otherTop);
    const end = await page.locator(last).boundingBox();
    assert(end.y + end.height <= g.height + 1, 'last content clipped');
  }
  assert.equal(await page.evaluate(() => scrollY), 0);
}
try {
  for (const viewport of [
    { width: 1180, height: 820 },
    { width: 1024, height: 768 },
    { width: 820, height: 1180 },
  ]) {
    const { context, page, errors, commits } = await open(viewport);
    const tag = `${viewport.width}x${viewport.height}`;
    if (process.env.TABLET_QA_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.TABLET_QA_SCREENSHOTS}/${tag}.png` });
    }
    await check(`${tag} stationary grip tap does not reorder`, async () => {
      const before = commits.length;
      await page.locator('.queue-handle').first().tap();
      await page.waitForTimeout(80);
      assert.equal(commits.length, before);
      assert.equal(await page.locator('.readlist.is-dragging').count(), 0);
    });
    await check(`${tag} root bounds and main bottom`, async () => {
      const g = await geometry(page);
      console.log('GEOMETRY', tag, JSON.stringify(g));
      assert(g.shell.scroll <= g.shell.client + 1, 'content escapes into shell scroll area');
      assert.equal(g.shell.scrollTop, 0, 'shell scrolled instead of main');
      assert(g.root.scroll <= g.height + 1, `document overflow ${g.root.scroll - g.height}px`);
      assert(
        Math.abs(g.main.bottom - g.height) <= 1,
        `main bottom ${g.main.bottom}, viewport ${g.height}`,
      );
      assert(g.root.right <= g.width + 1);
    });
    await check(`${tag} persistent independently scrolling panes`, async () => {
      const g = await geometry(page);
      assert(g.rail.right > g.rail.left, 'tablet rail hidden');
      assert.equal(g.rail.top, g.header.bottom);
      assert(Math.abs(g.rail.bottom - g.height) <= 1);
      assert(g.rail.scroll > g.rail.client && g.main.scroll > g.main.client);
      await page.locator('.app-rail').evaluate((el) => (el.scrollTop = el.scrollHeight));
      assert.equal(await page.locator('.app-main').evaluate((el) => el.scrollTop), 0);
      const railTop = await page.locator('.app-rail').evaluate((el) => el.scrollTop);
      await page.locator('.app-main').evaluate((el) => (el.scrollTop = el.scrollHeight));
      assert.equal(await page.locator('.app-rail').evaluate((el) => el.scrollTop), railTop);
      assert.equal(await page.evaluate(() => scrollY), 0);
      const end = await page.locator('.queue-row').last().boundingBox();
      assert(end.y + end.height <= g.height + 1, 'last queue row unreachable');
      const foot = await page.locator('.sidebar__foot').boundingBox();
      assert(foot.y + foot.height <= g.height + 1, 'sidebar footer unreachable');
      await page.mouse.move(g.main.right - 30, g.height - 30);
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => scrollY), 0, 'scroll chained to document');
    });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('.app-main').scrollTop = 0;
    });
    await check(`${tag} grip owns touch selection only`, async () => {
      const styles = await page.evaluate(() =>
        ['.queue-handle', '.queue-row__title', '.queue-row__note'].map((s) => {
          const c = getComputedStyle(document.querySelector(s));
          return { select: c.userSelect, touch: c.touchAction };
        }),
      );
      assert.equal(styles[0].select, 'none', 'grip allows selection');
      assert.equal(styles[0].touch, 'none');
      assert.notEqual(styles[1].select, 'none', 'title selection disabled');
      assert.notEqual(styles[2].select, 'none', 'note selection disabled');
    });
    await check(`${tag} touch hold does not grab ordinary text`, async () => {
      const title = await page.locator('.queue-row__note').first().boundingBox();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: title.x + 10, y: title.y + 5 }],
      });
      try {
        await page.waitForTimeout(600);
        assert.equal(
          await page.locator('.queue-row.is-grabbed').count(),
          0,
          'ordinary text long-press reorders',
        );
      } finally {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await cdp.detach();
      }
    });
    await check(`${tag} keyboard accessible reorder`, async () => {
      const h = page.getByRole('button', { name: /^Reorder Queue book 0,/ });
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/reading-list/b0/position') && r.request().method() === 'PATCH',
      );
      await h.focus();
      await h.press('Space');
      await h.press('ArrowDown');
      await h.press('Space');
      await response;
      assert(
        commits.some(
          (c) => c.path === '/api/reading-list/b0/position' && c.body.afterBookId === 'b1',
        ),
        'keyboard did not commit correct position',
      );
      assert.equal(await h.getAttribute('aria-pressed'), 'false');
    });
    await check(`${tag} menu reorder`, async () => {
      await page.getByRole('button', { name: 'More for Queue book 0', exact: true }).click();
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/reading-list/b0/position') && r.request().method() === 'PATCH',
      );
      await page.getByRole('button', { name: 'Move to top', exact: true }).click();
      await response;
      assert.equal(commits.at(-1).body.afterBookId, null);
      assert.equal(await page.locator('.queue-row__title').first().innerText(), 'Queue book 0');
    });
    await check(`${tag} grip touch drag clears selection and commits`, async () => {
      await page.locator('.app-main').evaluate((el) => (el.scrollTop = 0));
      await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('.queue-row__note'));
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(range);
      });
      assert.notEqual(
        await page.evaluate(() => getSelection().toString()),
        '',
        'selection fixture is empty',
      );
      const handle = await page.locator('.queue-handle').first().boundingBox();
      const row = await page.locator('.queue-row').first().boundingBox();
      const before = commits.length;
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }],
        });
        await page.waitForTimeout(600);
        assert.equal(
          await page.evaluate(() => getSelection().toString()),
          '',
          'selection survives grip hold',
        );
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 + row.height + 10 },
          ],
        });
        await page.waitForTimeout(50);
        assert.equal(await page.locator('.queue-row.is-grabbed').count(), 1, 'no active drag');
        assert.equal(
          await page.evaluate(() => getSelection().toString()),
          '',
          'text remains selected during drag',
        );
      } finally {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
      }
      await page.waitForTimeout(100);
      assert.equal(commits.length, before + 1, 'touch did not commit exactly once');
      assert.equal(await page.locator('.queue-row.is-grabbed').count(), 0);
      assert.notEqual(
        await page
          .locator('.queue-row__note')
          .first()
          .evaluate((el) => getComputedStyle(el).userSelect),
        'none',
        'selection not restored after drag',
      );
    });
    await check(`${tag} cancelled touch drag does not persist`, async () => {
      await page.locator('.app-main').evaluate((el) => (el.scrollTop = 0));
      const handle = await page.locator('.queue-handle').first().boundingBox();
      const before = commits.length;
      const order = await page.locator('.queue-row__title').allTextContents();
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: handle.x + 15, y: handle.y + 15 }],
        });
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: handle.x + 15, y: handle.y + 180 }],
        });
        await page.waitForTimeout(50);
      } finally {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await cdp.detach();
      }
      await page.waitForTimeout(50);
      assert.equal(commits.length, before, 'cancellation persisted a reorder');
      assert.deepEqual(await page.locator('.queue-row__title').allTextContents(), order);
      assert.equal(await page.locator('.readlist.is-dragging').count(), 0);
    });
    await check(`${tag} drag edge scrolls main, not document or sidebar`, async () => {
      await page.locator('.app-main').evaluate((el) => (el.scrollTop = 0));
      const handle = await page.locator('.queue-handle').first().boundingBox();
      const g = await geometry(page);
      const rail = await page.locator('.app-rail').evaluate((el) => el.scrollTop);
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: handle.x + 15, y: handle.y + 15 }],
        });
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: handle.x + 15, y: g.main.bottom - 20 }],
        });
        await page.waitForTimeout(80);
        assert(
          (await page.locator('.app-main').evaluate((el) => el.scrollTop)) > 0,
          'drag still scrolls window instead of its pane',
        );
        assert.equal(await page.locator('.app-rail').evaluate((el) => el.scrollTop), rail);
        assert.equal(await page.evaluate(() => scrollY), 0);
      } finally {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await cdp.detach();
      }
    });
    await check(`${tag} resize respects available height`, async () => {
      await page.setViewportSize({ width: viewport.height, height: viewport.width });
      await page.waitForTimeout(100);
      await panes(page, `${tag} rotated`);
      await page.setViewportSize({ width: 1180, height: 560 });
      await page.waitForTimeout(100);
      await panes(page, `${tag} resized`);
      await page.evaluate(() => {
        const s = document.documentElement.style;
        s.setProperty('--rp-safe-top', '24px');
        s.setProperty('--rp-safe-bottom', '34px');
        s.setProperty('--rp-safe-left', '20px');
      });
      await panes(page, `${tag} safe-area fixture`);
    });
    await check(`${tag} visual viewport resize without layout resize`, async () => {
      // Chromium cannot show the iOS keyboard. Model its separate visual
      // viewport event while keeping the real layout viewport fixed.
      await page.evaluate(() => {
        Object.defineProperty(visualViewport, 'height', { configurable: true, value: 400 });
        visualViewport.dispatchEvent(new Event('resize'));
      });
      try {
        await page.waitForTimeout(100);
        const g = await geometry(page);
        assert(Math.abs(g.main.bottom - 400) <= 1, 'visual viewport bottom ignored');
        assert(Math.abs(g.rail.bottom - 400) <= 1);
        for (const selector of ['.app-main', '.app-rail']) {
          const at = await page.locator(selector).evaluate((el) => {
            el.scrollTop = el.scrollHeight;
            return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
          });
          assert(Math.abs(at.top - at.max) <= 1);
        }
        assert.equal(await page.evaluate(() => scrollY), 0);
      } finally {
        await page.evaluate(() => {
          delete visualViewport.height;
          visualViewport.dispatchEvent(new Event('resize'));
        });
      }
      await page.evaluate(() => {
        Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 12 });
        visualViewport.dispatchEvent(new Event('scroll'));
      });
      assert.equal((await geometry(page)).shell.top, 12, 'visual viewport pan ignored');
      await page.evaluate(() => {
        delete visualViewport.offsetTop;
        Object.defineProperty(visualViewport, 'scale', { configurable: true, value: 2 });
        visualViewport.dispatchEvent(new Event('resize'));
      });
      assert.equal(
        await page
          .locator('.app-shell')
          .evaluate((el) => el.style.getPropertyValue('--app-viewport-height')),
        '',
        'pinch zoom resized layout',
      );
      await page.evaluate(() => {
        delete visualViewport.scale;
        visualViewport.dispatchEvent(new Event('resize'));
      });
    });
    await check(`${tag} library and touch scrolling remain independent`, async () => {
      await page.setViewportSize(viewport);
      await page.goto(base);
      await page.waitForSelector('.book-card:last-child');
      await panes(page, `${tag} library`, '.book-card:last-child');
      for (const [target, other] of [
        ['.app-rail', '.app-main'],
        ['.app-main', '.app-rail'],
      ]) {
        await page.locator(target).evaluate((el) => (el.scrollTop = 0));
        const otherTop = await page.locator(other).evaluate((el) => el.scrollTop);
        const box = await page.locator(target).boundingBox();
        const cdp = await context.newCDPSession(page);
        const x = box.x + box.width - 8;
        const y = box.y + Math.min(box.height - 40, 400);
        try {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x, y }],
          });
          for (let step = 1; step <= 8; step++) {
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: [{ x, y: y - step * 25 }],
            });
            await page.waitForTimeout(20);
          }
        } finally {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await cdp.detach();
        }
        await page.waitForTimeout(400);
        assert(
          (await page.locator(target).evaluate((el) => el.scrollTop)) > 0,
          `${target} touch scroll failed`,
        );
        assert.equal(
          await page.locator(other).evaluate((el) => el.scrollTop),
          otherTop,
          `${target} moved ${other}`,
        );
        assert.equal(await page.evaluate(() => scrollY), 0);
      }
    });
    await check(`${tag} no browser runtime errors`, () => assert.deepEqual(errors, []));
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
