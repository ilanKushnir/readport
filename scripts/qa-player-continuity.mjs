import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/usr/local/lib/node_modules/')('playwright');
const browser = await chromium.launch({
  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || undefined,
});
const base = process.argv[2] ?? 'http://127.0.0.1:5191';
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const wav = Buffer.alloc(44 + 16000);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(16000, 40);
try {
  for (const width of [390, 820]) {
    const context = await browser.newContext({ viewport: { width, height: 1180 } });
    await context.addInitScript(() => {
      const times = new WeakMap();
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        get() {
          return times.get(this) ?? 0;
        },
        set(v) {
          times.set(this, v);
        },
        configurable: true,
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
        get() {
          return 1;
        },
        configurable: true,
      });
      HTMLMediaElement.prototype.play = async function () {
        this.dispatchEvent(new Event('play'));
      };
      HTMLMediaElement.prototype.pause = function () {
        this.dispatchEvent(new Event('pause'));
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => {
        const p = new URL(route.request().url()).pathname;
        let data = {};
        if (p === '/api/auth/me')
          data = { user: { id: 'qa', username: 'qa', role: 'user' }, needsLibraries: false };
        else if (p === '/api/prefs/sidebar') data = { sidebar: { chosen: true, facets: [] } };
        else if (p === '/api/facets') data = { groups: [] };
        else if (p === '/api/shelves') data = { shelves: [], auto: [], readingList: { count: 0 } };
        else if (p === '/api/books/audio')
          data = {
            book: {
              id: 'audio',
              title: 'Listening test',
              author: 'QA',
              kind: 'audio',
              format: 'mp3',
              hasCover: false,
              scanState: 'ready',
            },
            tracks: [{ idx: 0, durationMs: 1800000, startMsAbsolute: 0, format: 'mp3' }],
            chapters: [0, 600000, 1200000].map((startMs, idx) => ({
              idx,
              title: `Part ${idx + 1}`,
              startMs,
              endMs: startMs + 600000,
            })),
            pairs: [],
          };
        else if (p.endsWith('/annotations'))
          data = {
            annotations: [
              {
                id: 'mark',
                kind: 'bookmark',
                note: 'Saved moment',
                locator: {
                  medium: 'audio',
                  trackIdx: 0,
                  positionMs: 1200000,
                  bookMs: 1200000,
                  pct: 0.66,
                },
              },
            ],
          };
        else if (p === '/api/progress/events') data = { results: [], state: null };
        else if (p === '/api/progress/audio') data = { generation: 0, state: null };
        else if (p.includes('/track/'))
          return route.fulfill({ contentType: 'audio/wav', body: wav });
        return route.fulfill({ json: data });
      },
    );
    await page.goto(`${base}/listen/audio?pos=120000`);
    await page.getByRole('heading', { name: 'Listening test' }).waitFor();
    await page.evaluate(() =>
      document.querySelector('audio').dispatchEvent(new Event('loadedmetadata')),
    );
    assert.equal(await page.locator('.return-pill').count(), 0);
    await page.getByRole('button', { name: 'Next chapter', exact: true }).click();
    assert.equal(await page.locator('.return-pill').count(), 0);
    await page.getByRole('button', { name: 'Chapters', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Part 1/ })
      .click();
    await page.locator('.return-pill').waitFor();
    assert.match(await page.locator('.return-pill__go').innerText(), /10:00/);
    // A second explicit jump replaces, rather than accumulates, the origin.
    await page.getByRole('button', { name: 'Bookmarks (1)' }).first().click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Saved moment/ })
      .click();
    assert.equal(await page.locator('.return-pill').count(), 1);
    assert.match(await page.locator('.return-pill__go').innerText(), /0:00/);
    await page.locator('.return-pill__go').click();
    await page.locator('.return-pill').waitFor({ state: 'detached' });
    const slider = page.getByRole('slider', { name: 'Position in audiobook' });
    await slider.fill('20000');
    assert.equal(await page.locator('.return-pill').count(), 0);
    await slider.fill('700000');
    await page.locator('.return-pill').waitFor();
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    assert.equal(await page.locator('.return-pill').count(), 0);
    await slider.fill('1000000');
    await page.locator('.return-pill').waitFor();
    await page.evaluate(() => {
      const a = document.querySelector('audio');
      a.currentTime = 1031;
      a.dispatchEvent(new Event('timeupdate'));
    });
    await page.locator('.return-pill').waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width} player open/progression/small no-show; TOC/bookmark/slider show; replace, return, manual and continuation dismissal`,
    );
    for (const [clock, expected] of [
      [1031.234, 1031234],
      [-2, 0],
      [1900, 1800000],
      [NaN, 1031000],
      [Infinity, 1031000],
    ]) {
      await check(`${width} pagehide captures live clock ${clock} without timeupdate`, async () => {
        const at = await page.evaluate((clock) => {
          document.querySelector('audio').currentTime = clock;
          window.dispatchEvent(new Event('pagehide'));
          return JSON.parse(localStorage.getItem('rp-progress-stash')).at(-1).locator;
        }, clock);
        assert.equal(at.positionMs, expected);
        assert.equal(at.bookMs, expected);
        assert.equal(at.pct, expected / 1800000);
      });
    }
    await check(`${width} route exit captures live clock before React detaches audio`, async () => {
      await page.evaluate(() => {
        document.querySelector('audio').currentTime = 1044.321;
        document.querySelector('button[aria-label="Back to book"]').click();
      });
      await page.locator('audio').waitFor({ state: 'detached' });
      await page.waitForFunction(async () => {
        const { idbAll, STORES } = await import('/src/progress/idb.ts');
        return (await idbAll(STORES.pendingEvents)).some((e) => e.value.intent === 'pause');
      });
      const at = await page.evaluate(async () => {
        const { idbAll, STORES } = await import('/src/progress/idb.ts');
        return (await idbAll(STORES.pendingEvents))
          .map((e) => e.value)
          .filter((e) => e.intent === 'pause')
          .sort((a, b) => b.seq - a.seq)[0].locator;
      });
      assert.equal(at.positionMs, 1044321);
      assert.equal(at.bookMs, 1044321);
      assert.equal(at.pct, 1044321 / 1800000);
    });
    await context.close();
  }
} finally {
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
