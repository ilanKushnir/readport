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
      // One unload, one capture. The unload path fires twice on most browsers
      // - visibilitychange to hidden, then pagehide, milliseconds apart - and
      // each used to build its own event and its own keepalive batch, so the
      // origin's keepalive budget was spent twice over and the second batch
      // was refused before it left. A repeat of the same position within
      // UNLOAD_DEDUPE_MS (1.5s) is now recognised as the same farewell and
      // does nothing at all - including not re-stashing it, which is why
      // these five captures have to be genuinely separate unloads rather than
      // five in the same instant. (NaN and Infinity both fall back to the
      // same last known position, so without this they are one capture.)
      await page.waitForTimeout(1600);
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
    // The keys on a desktop: Space plays and pauses, the arrows move fifteen
    // seconds either way and, with Shift, a chapter.
    if (width === 820) {
      await page.goto(`${base}/listen/audio?pos=120000`);
      await page.getByRole('heading', { name: 'Listening test' }).waitFor();
      await page.evaluate(() =>
        document.querySelector('audio').dispatchEvent(new Event('loadedmetadata')),
      );
      const bar = page.getByRole('slider', { name: 'Position in audiobook' });
      const pos = async () => Number(await bar.inputValue());
      const press = async (k) => {
        await page.keyboard.press(k);
        await page.waitForTimeout(120);
      };
      await check(
        '820 keys: the arrows move fifteen seconds either way, the same both ways',
        async () => {
          const p0 = await pos();
          await press('ArrowRight');
          assert.equal(await pos(), p0 + 15000);
          await press('ArrowLeft');
          await press('ArrowLeft');
          assert.equal(await pos(), p0 - 15000);
        },
      );
      await check('820 keys: Shift and an arrow move a chapter', async () => {
        await press('Shift+ArrowRight');
        assert.equal(await pos(), 600000);
      });
      await check('820 keys: ⌘ and an arrow are left to the browser', async () => {
        const p0 = await pos();
        await press('Meta+ArrowLeft');
        assert.equal(await pos(), p0);
      });
      await check(
        '820 keys: after dragging the position bar, the arrows still move fifteen seconds',
        async () => {
          await bar.click();
          await page.waitForTimeout(150);
          const p0 = await pos();
          await press('ArrowRight');
          assert.equal(await pos(), p0 + 15000);
        },
      );
      // The stand-in element above plays and pauses without ever saying it
      // has: the toggle below needs one that does.
      await page.evaluate(() => {
        const proto = HTMLMediaElement.prototype;
        const on = new WeakMap();
        const { play, pause } = proto;
        Object.defineProperty(proto, 'paused', {
          get() {
            return !on.get(this);
          },
          configurable: true,
        });
        proto.play = async function () {
          on.set(this, true);
          return play.call(this);
        };
        proto.pause = function () {
          on.set(this, false);
          return pause.call(this);
        };
      });
      await check(
        '820 keys: Space after clicking play plays or pauses once, not twice',
        async () => {
          const play = page.getByRole('button', { name: /^(Play|Pause)$/ });
          const before = await play.getAttribute('aria-label');
          await play.click();
          await page.waitForTimeout(120);
          const clicked = await play.getAttribute('aria-label');
          assert.notEqual(clicked, before, 'the click toggled');
          await press(' ');
          assert.equal(await play.getAttribute('aria-label'), before, 'Space toggled back once');
        },
      );
      await check(
        '820 keys: Space held down plays or pauses once, not on every repeat',
        async () => {
          const play = page.getByRole('button', { name: /^(Play|Pause)$/ });
          const before = await play.getAttribute('aria-label');
          // A key held down repeats: every keydown after the first says so.
          for (let n = 0; n < 4; n++) await page.keyboard.down(' ');
          await page.keyboard.up(' ');
          await page.waitForTimeout(150);
          assert.notEqual(await play.getAttribute('aria-label'), before);
        },
      );
      await check('820 keys: arrows pressed in quick succession each count', async () => {
        const p0 = await pos();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(150);
        assert.equal(await pos(), p0 + 45000);
      });
    }
    await context.close();
  }
} finally {
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
