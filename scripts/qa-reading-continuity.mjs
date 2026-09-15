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
  'A quiet passage for an exact return, with enough words to wrap across several lines. '.repeat(4);
const html = Array.from({ length: 70 }, (_, i) => `<p id="p${i}">${paragraph}</p>`).join('');
const count = (paragraph.length + 1) * 70;
const offset = (paragraph.length + 1) * 7 + 127;
const locator = {
  medium: 'ebook',
  spineIdx: 0,
  sentenceId: 'saved',
  charOffset: offset,
  pct: offset / (count * 3),
};
const state = {
  bookId: 'qa',
  locator,
  revision: 1,
  intent: 'open',
  sessionId: 'other-device',
  deviceId: 'other-device',
  seq: 1,
  occurredAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  finished: false,
};
/**
 * Bind `window.progressEngine` to the engine instance the APP is using.
 *
 * Vite serves the same module under an HMR-stamped URL and an unstamped one,
 * and those are two module instances with two separate `sessionUserId`
 * values. The app claims the queue on the stamped one (web/qa/reader.tsx is
 * transformed alongside ReaderPage), so a bare `import('/src/progress/engine.ts')`
 * from a page.evaluate lands on an UNCLAIMED instance, where the engine
 * correctly refuses to record anything - and the test reads that refusal as a
 * lost checkpoint. Always drive the engine through this handle, and rebind it
 * after any reload, which throws the old `window` away.
 */
async function attachEngine(page) {
  await page.evaluate(async () => {
    const source = await (await fetch('/src/reader/ReaderPage.tsx')).text();
    const url = source.match(/from "([^"]*\/progress\/engine\.ts[^"]*)"/)[1];
    window.progressEngine = await import(url);
  });
}

async function open(
  viewport,
  mode,
  reducedMotion = 'no-preference',
  narrated = false,
  entry = 'exact',
) {
  const context = await browser.newContext({ viewport, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    ({ mode }) =>
      localStorage.setItem('rp-reader-prefs', JSON.stringify({ mode, pageTurn: 'instant' })),
    { mode },
  );
  const posted = [];
  if (narrated)
    await page.route('**/src/reader/Narration.tsx*', async (route) => {
      const response = await route.fetch();
      let body = (await response.text()).replace(
        'function useNarration(opts)',
        'function unusedNarration(opts)',
      );
      body += `\nexport function useNarration() {
      const cue = { id: 'saved', charStart: 2000, charEnd: 5000, startMs: 0, endMs: 10000, uncertaintyMs: 1000 };
      return { ready: true, playing: true, cue, cues: [cue], bookMs: 3000, currentBookMs: () => window.liveBookMs ?? 3000, seekNonce: 0, state: 'on', speed: 1, backSeconds: 15, element: null, toggle() {}, back() {}, setSpeed() {}, playFrom() {} };
    }`;
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
          title: 'Exact return',
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
      else if (p.includes('/chapter/'))
        return route.fulfill({ contentType: 'text/html', body: html });
      else if (p.includes('/sentences/'))
        data = {
          sentences: [
            {
              id: 'saved',
              start: entry === 'boundary' ? 0 : narrated ? 2000 : offset - 127,
              end: entry === 'boundary' ? count : narrated ? 5000 : offset + 100,
              text: paragraph,
            },
          ],
        };
      else if (p.endsWith('/annotations')) {
        data =
          route.request().method() === 'POST'
            ? { annotation: { id: 'new-mark', ...route.request().postDataJSON() } }
            : { annotations: [] };
      } else if (p === '/api/books/qa')
        data = {
          book: {
            id: 'qa',
            title: 'Exact return',
            pair: narrated
              ? { pairId: 'pair', otherBookId: 'audio', status: 'confirmed', switchable: true }
              : null,
          },
        };
      else if (p === '/api/progress/qa')
        data = {
          state:
            entry === 'legacy'
              ? {
                  ...state,
                  locator: { medium: 'ebook', spineIdx: 0, sentenceId: 'saved', pct: locator.pct },
                }
              : state,
        };
      else if (p === '/api/progress/events') {
        posted.push(...route.request().postDataJSON().events);
        data = { results: [], state: null };
      }
      await route.fulfill({ json: data });
    },
  );
  await page.route('**/__reader-qa/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/qa/reader.tsx"></script></body></html>`,
    }),
  );
  await page.goto(
    `${base}/__reader-qa/qa${entry === 'url' ? '?spine=0&sentence=saved&handoff=1' : ''}`,
  );
  await page.waitForSelector('#p69', { state: 'attached' }).catch(async (e) => {
    console.log('BOOT', errors, await page.locator('body').innerText());
    throw e;
  });
  await page.waitForTimeout(400);
  await attachEngine(page);
  await page.evaluate(() => {
    window.stopLifecycle = window.progressEngine.startProgressLifecycle();
  });
  return { context, page, errors, posted };
}
try {
  for (const mode of ['paginated', 'scroll']) {
    for (const entry of ['legacy', 'url']) {
      const fixture = await open({ width: 820, height: 1180 }, mode, 'reduce', false, entry);
      await check(
        `${mode} ${entry} sentence-only caller resolves landing and checkpoint`,
        async () => {
          const expected = offset - 127;
          if (entry === 'legacy') {
            assert.equal(
              await fixture.page.locator('.resume-marker').first().getAttribute('data-offset'),
              String(expected),
            );
          }
          const captured = await fixture.page.evaluate(() => {
            window.dispatchEvent(new Event('pagehide'));
            return JSON.parse(localStorage.getItem('rp-progress-stash')).at(-1);
          });
          assert.equal(captured.locator.charOffset, expected);
          assert.equal(captured.locator.sentenceId, 'saved');
          const initial = await fixture.page.evaluate(async () => {
            const { idbAll, STORES } = await import('/src/progress/idb.ts');
            return (await idbAll(STORES.pendingEvents))
              .map((e) => e.value)
              .find((e) => e.intent === 'open' || e.intent === 'switch');
          });
          assert.equal(initial.locator.charOffset, expected);
        },
      );
      if (entry === 'legacy') {
        await check(
          `${mode} offline sentence-only queue survives reload at the exact sentence`,
          async () => {
            await fixture.page.route(
              (url) => url.pathname.startsWith('/api/progress/'),
              (route) => route.abort('internetdisconnected'),
            );
            await fixture.page.evaluate(async (pct) => {
              window.stopLifecycle();
              await window.progressEngine.recordCheckpoint(
                'qa',
                'seek',
                { medium: 'ebook', spineIdx: 0, sentenceId: 'saved', pct },
                { flush: false },
              );
            }, locator.pct);
            await fixture.page.reload();
            await fixture.page.locator('.resume-marker').first().waitFor();
            assert.equal(
              await fixture.page.locator('.resume-marker').first().getAttribute('data-offset'),
              String(offset - 127),
            );
          },
        );
      }
      await fixture.context.close();
    }
    const fixture = await open({ width: 820, height: 1180 }, mode, 'reduce', false, 'boundary');
    await check(
      `${mode} immediate bookmark keeps live first-visible character across sentence boundary`,
      async () => {
        if (mode === 'paginated') {
          await fixture.page
            .getByRole('button', { name: 'Next page', exact: true })
            .first()
            .click({ force: true });
        }
        const request = fixture.page.waitForRequest(
          (r) => r.url().endsWith('/annotations') && r.method() === 'POST',
        );
        const expected = await fixture.page.evaluate(async (mode) => {
          const { buildTextMap, firstVisibleOffset, rangeForSpan } =
            await import('/src/reader/textmap.ts');
          const map = buildTextMap(document.querySelector('.reader-content'));
          const viewport = document.querySelector(
            mode === 'scroll' ? '.reader-scroller' : '.reader-pages',
          );
          if (mode === 'scroll') {
            viewport.scrollTop += 900;
            viewport.dispatchEvent(new Event('scroll'));
          }
          const rect = viewport.getBoundingClientRect();
          // What is bookmarked in scroll mode is the first character the
          // reader can actually SEE. The top bar is opaque and its height is
          // measured, not assumed, so the characters behind it are not on the
          // page - bookmarking one used to mark a line hidden under the bar,
          // and "is this bookmark on this page" disagreed with it. Paginated
          // mode reserves room for the bars in its own padding, so its box is
          // the whole page box, exactly as ReaderPage measures it.
          const chrome = document.querySelector('.immersive-chrome--top');
          const box =
            mode === 'scroll'
              ? {
                  left: rect.left,
                  right: rect.right,
                  top: rect.top + Math.round(chrome.getBoundingClientRect().height),
                  bottom: rect.bottom,
                }
              : rect;
          const off = firstVisibleOffset(map, box);
          const sentenceStart = rangeForSpan(map, 0, 1).getBoundingClientRect();
          if (!(off > 0) || (sentenceStart.x >= rect.left && sentenceStart.y >= rect.top))
            throw new Error('fixture must span a preceding page/scroll boundary');
          document.querySelector('button[aria-label="Bookmark this page"]').click();
          return off;
        }, mode);
        const body = (await request).postDataJSON();
        assert.equal(body.locator.charOffset, expected);
        assert.equal(body.locator.sentenceId, 'saved');
        assert.equal(body.locator.pct, expected / (count * 3));
      },
    );
    await fixture.context.close();
  }
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 820, height: 1180 },
  ]) {
    for (const mode of ['paginated', 'scroll']) {
      const { page, context, errors } = await open(viewport, mode);
      await check(`${viewport.width} ${mode} exact marker visible and layout-safe`, async () => {
        const marker = page.locator('.resume-marker').first();
        await marker.waitFor({ timeout: 2500 });
        assert.equal(await marker.getAttribute('data-offset'), String(offset));
        const r = await marker.boundingBox();
        assert(r.y > 0 && r.y + r.height < viewport.height && r.x >= 0 && r.x < viewport.width);
        const opacity = await marker.evaluate((e) => getComputedStyle(e).opacity);
        await page.waitForTimeout(800);
        assert.equal(await marker.evaluate((e) => getComputedStyle(e).opacity), opacity);
        assert.equal(await page.locator('.return-pill').count(), 0);
        await page.evaluate(async () => {
          const e = await import('/src/progress/engine.ts');
          e.persistActiveLocatorAndFlush();
        });
        const latest = await page.evaluate(async () => {
          const { idbAll, STORES } = await import('/src/progress/idb.ts');
          return (await idbAll(STORES.pendingEvents))
            .map((e) => e.value)
            .sort((a, b) => b.seq - a.seq)[0];
        });
        assert.equal(latest.locator.charOffset, offset);
        assert.equal(latest.locator.sentenceId, 'saved');
        if (mode === 'paginated')
          await page
            .getByRole('button', { name: 'Next page', exact: true })
            .first()
            .click({ force: true });
        else
          await page.locator('.reader-scroller').evaluate((e) => {
            e.scrollTop += 1000;
          });
        await page.waitForTimeout(900);
        assert.equal(await page.locator('.resume-marker').count(), 0);
        assert.deepEqual(errors, []);
      });
      await check(
        `${viewport.width} ${mode} return chip show, replace, return and dismiss`,
        async () => {
          const jump = async (name) => {
            await page.getByRole('button', { name: 'Table of contents' }).click({ force: true });
            await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
            await page.waitForTimeout(300);
          };
          await jump('Chapter 3');
          assert.equal(await page.locator('.return-pill').count(), 1);
          assert.match(await page.locator('.return-pill').innerText(), /Back to Chapter 1/);
          await jump('Chapter 2');
          assert.equal(await page.locator('.return-pill').count(), 1);
          assert.match(await page.locator('.return-pill').innerText(), /Back to Chapter 3/);
          await page.locator('.return-pill__go').click();
          assert.equal(await page.locator('.return-pill').count(), 0);
          await jump('Chapter 1');
          await page.locator('.return-pill__x').click();
          assert.equal(await page.locator('.return-pill').count(), 0);
          await jump('Chapter 2');
          if (mode === 'paginated')
            await page
              .getByRole('button', { name: 'Next page', exact: true })
              .first()
              .click({ force: true });
          else
            await page.locator('.reader-scroller').evaluate((e) => {
              e.scrollTop += 1000;
            });
          await page.waitForTimeout(800);
          assert.equal(await page.locator('.return-pill').count(), 0);
        },
      );
      await context.close();
    }
  }
  const { context, page } = await open({ width: 820, height: 1180 }, 'paginated', 'reduce');
  await check('reduced motion marker has no animation', async () => {
    const marker = page.locator('.resume-marker').first();
    await marker.waitFor({ timeout: 2500 });
    assert.equal(await marker.evaluate((e) => getComputedStyle(e).transitionDuration), '0s');
  });
  await context.close();
  const durable = await open({ width: 390, height: 844 }, 'scroll');
  await check('immediate scroll/close captures latest line before debounce', async () => {
    const result = await durable.page.evaluate(async () => {
      const { liveCheckpointOffset } = await import('/src/reader/liveOffset.ts');
      const { buildTextMap } = await import('/src/reader/textmap.ts');
      const s = document.querySelector('.reader-scroller');
      s.scrollTop += 500;
      const expected = liveCheckpointOffset(
        'scroll',
        0,
        buildTextMap(document.querySelector('.reader-content')),
        s,
      );
      window.dispatchEvent(new Event('pagehide'));
      const captured = JSON.parse(localStorage.getItem('rp-progress-stash')).at(-1);
      if (captured.locator.charOffset !== expected) throw new Error('synchronous capture is stale');
      const { idbAll, STORES } = await import('/src/progress/idb.ts');
      const pending = (await idbAll(STORES.pendingEvents))
        .map((e) => e.value)
        .sort((a, b) => b.seq - a.seq);
      return { expected, actual: pending[0].locator.charOffset };
    });
    assert.equal(result.actual, result.expected);
  });
  await check(
    'IndexedDB queue survives offline reload and replays exact same-chapter locator',
    async () => {
      const local = { ...locator, charOffset: offset + 51 };
      await durable.page.route(
        (url) => url.pathname.startsWith('/api/progress/'),
        (route) => route.abort('internetdisconnected'),
      );
      const seeded = await durable.page.evaluate(async (local) => {
        // This fixture seeds a completed prior reading session, not an in-view seek.
        window.stopLifecycle();
        return window.progressEngine.recordCheckpoint('qa', 'seek', local, { flush: false });
      }, local);
      assert.equal(seeded, true, 'the seeded checkpoint was refused, so nothing is being tested');
      await durable.page.reload();
      // A reload is a new window: rebind before driving the engine again.
      await durable.page.locator('#p69').waitFor({ state: 'attached' });
      await attachEngine(durable.page);
      await durable.page.locator('.resume-marker').waitFor();
      assert.equal(
        await durable.page.locator('.resume-marker').getAttribute('data-offset'),
        String(local.charOffset),
      );
      const replayed = [];
      await durable.page.route('**/api/progress/events', async (route) => {
        const events = route.request().postDataJSON().events;
        replayed.push(...events);
        await route.fulfill({
          json: {
            results: events.map((e) => ({ eventId: e.eventId, status: 'applied' })),
            state: null,
          },
        });
      });
      await durable.page.evaluate(() => window.progressEngine.flushPending());
      assert(
        replayed.some(
          (e) =>
            e.intent === 'seek' &&
            e.locator.charOffset === local.charOffset &&
            e.locator.sentenceId === local.sentenceId,
        ),
      );
      const pending = await durable.page.evaluate(async () => {
        const { idbAll, STORES } = await import('/src/progress/idb.ts');
        return (await idbAll(STORES.pendingEvents)).length;
      });
      assert.equal(pending, 0);
    },
  );
  await durable.context.close();
  const voice = await open({ width: 820, height: 1180 }, 'paginated', 'no-preference', true);
  await check(
    'read-along checkpoints every few seconds and captures live clock immediately',
    async () => {
      await voice.page.getByRole('button', { name: 'Read along', exact: true }).click();
      await voice.page.evaluate(() => {
        window.liveBookMs = 4500;
      });
      await voice.page.waitForTimeout(3500);
      const periodic = await voice.page.evaluate(async () => {
        const { idbAll, STORES } = await import('/src/progress/idb.ts');
        return (await idbAll(STORES.pendingEvents))
          .map((e) => e.value)
          .filter((e) => e.intent === 'heartbeat');
      });
      assert(periodic.some((e) => e.locator.charOffset === 3350));
      const immediate = await voice.page.evaluate(async () => {
        window.liveBookMs = 4900; // no timeupdate/render between clock move and capture
        window.dispatchEvent(new Event('pagehide'));
        const captured = JSON.parse(localStorage.getItem('rp-progress-stash')).at(-1);
        if (captured.locator.charOffset !== 3470 || captured.locator.sentenceId !== 'saved')
          throw new Error('synchronous narration capture is stale');
        const { idbAll, STORES } = await import('/src/progress/idb.ts');
        return (await idbAll(STORES.pendingEvents))
          .map((e) => e.value)
          .sort((a, b) => b.seq - a.seq)[0];
      });
      assert.equal(immediate.locator.charOffset, 3470);
      assert.equal(immediate.locator.sentenceId, 'saved');
      assert.equal(await voice.page.locator('.return-pill').count(), 0);
    },
  );
  await voice.context.close();
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
