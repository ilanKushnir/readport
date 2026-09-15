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
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 820, height: 1180 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    let removed = false;
    let fail = true;
    let deletes = 0;
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const url = new URL(route.request().url());
        let data = {};
        if (url.pathname === '/api/auth/me')
          data = { user: { id: 'qa', username: 'qa', role: 'user' }, needsLibraries: false };
        if (url.pathname === '/api/prefs/sidebar') data = { sidebar: { chosen: true, facets: [] } };
        if (url.pathname === '/api/facets') data = { groups: [] };
        if (url.pathname === '/api/shelves')
          data = {
            shelves: [],
            auto: [{ id: 'reading-now', count: removed ? 0 : 1 }],
            readingList: { count: 0 },
          };
        if (url.pathname === '/api/library') {
          assert.equal(url.searchParams.get('filter'), 'reading-now');
          data = {
            books: removed
              ? []
              : [
                  {
                    id: 'ebook',
                    title: 'A thoughtful read',
                    author: 'An author',
                    kind: 'ebook',
                    format: 'epub',
                    scanState: 'ready',
                    hasCover: false,
                    progress: { pct: 0.3, finished: false },
                    // Paired, so the confirmation has a paired edition to be
                    // honest about: the sentence about it is now shown only
                    // for a book that actually has one, instead of promising
                    // every reader that an edition they do not own is safe.
                    pair: {
                      pairId: 'pair',
                      otherBookId: 'audio',
                      otherKind: 'audiobook',
                      otherFormat: 'm4b',
                      status: 'confirmed',
                      switchable: true,
                    },
                  },
                ],
            continueRail: [],
            scanActive: false,
          };
        }
        if (url.pathname === '/api/progress/ebook' && route.request().method() === 'DELETE') {
          deletes++;
          if (fail) return route.abort('internetdisconnected');
          removed = true;
          data = { bookId: 'ebook', generation: 1 };
        }
        await route.fulfill({ json: data });
      },
    );
    try {
      await page.goto(`${base}/shelf/reading-now`);
      await page.locator('.reading-now__row').waitFor({ timeout: 4000 });
      assert.equal(await page.locator('.book-grid').count(), 0);
      const box = await page.locator('.reading-now__row').boundingBox();
      assert(box.width <= viewport.width && box.x >= 0);
      // The row's way out is named for what it does. It never removed the
      // book from anything - progress is the only thing that puts a title on
      // this shelf, so leaving means erasing that progress - and the button
      // now says "Reset progress…" before the dialog says it again. The
      // failure message is the same promise in the same words as the dialog:
      // the reset was not confirmed, so the book stays.
      await page.getByRole('button', { name: 'Reset progress…', exact: true }).click();
      assert.equal(deletes, 0);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(deletes, 0);
      await page.getByRole('button', { name: 'Reset progress…', exact: true }).click();
      assert.match(
        await page.getByRole('dialog').innerText(),
        /paired edition.*keeps its own progress/i,
      );
      await page.getByRole('button', { name: 'Reset reading progress', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'could not be confirmed' }).waitFor();
      assert.equal(await page.locator('.reading-now__row').count(), 1);
      fail = false;
      await page.getByRole('button', { name: 'Reset reading progress', exact: true }).click();
      await page.locator('.reading-now__row').waitFor({ state: 'detached' });
      assert.equal(deletes, 2);
      console.log(
        `PASS ${viewport.width} compact row, confirmation/cancel, offline retention, confirmed reset`,
      );
    } catch (e) {
      failures++;
      console.log(`FAIL ${viewport.width}: ${e.message}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
