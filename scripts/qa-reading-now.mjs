import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/usr/local/lib/node_modules/')('playwright');
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
      await page.getByRole('button', { name: 'Remove from Reading Now' }).click();
      assert.equal(deletes, 0);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(deletes, 0);
      await page.getByRole('button', { name: 'Remove from Reading Now' }).click();
      assert.match(await page.getByRole('dialog').innerText(), /paired edition.*unchanged/i);
      await page.getByRole('button', { name: 'Reset reading progress', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Could not confirm' }).waitFor();
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
