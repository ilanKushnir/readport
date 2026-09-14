import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/usr/local/lib/node_modules/')('playwright');
const browser = await chromium.launch({
  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || undefined,
});
const base = process.argv[2] ?? 'http://127.0.0.1:5191';
try {
  const context = await browser.newContext();
  let generation = 0;
  const locator = { medium: 'ebook', spineIdx: 2, charOffset: 173, sentenceId: 'exact', pct: 0.3 };
  await context.route(
    (url) => url.pathname === '/reset-test',
    (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Progress transaction test</title>' }),
  );
  await context.route(
    (url) => url.pathname.startsWith('/api/progress/'),
    (route) => {
      if (route.request().method() === 'DELETE') generation++;
      return route.fulfill({
        json: {
          bookId: 'book',
          generation,
          state: generation
            ? null
            : {
                bookId: 'book',
                generation: 0,
                revision: 8,
                locator,
                intent: 'seek',
                occurredAt: new Date().toISOString(),
                sessionId: 'remote',
                deviceId: 'remote',
                seq: 1,
                finished: false,
                updatedAt: new Date().toISOString(),
              },
        },
      });
    },
  );
  const a = await context.newPage();
  const b = await context.newPage();
  for (const page of [a, b]) {
    await page.goto(`${base}/reset-test`);
    await page.evaluate(async () => {
      window.engine = await import('/src/progress/engine.ts');
      window.storage = await import('/src/progress/storage.ts');
      window.idb = await import('/src/progress/idb.ts');
      await window.engine.resumeLocator('book');
    });
  }
  const download = { bookId: 'book', status: 'ready', assets: ['retained.epub'] };
  await a.evaluate(
    (download) => window.idb.idbPut(window.idb.STORES.downloads, 'book', download),
    download,
  );
  await a.evaluate(() => window.engine.resetBookProgress('book'));
  assert.deepEqual(
    await b.evaluate(() => window.idb.idbGet(window.idb.STORES.downloads, 'book')),
    download,
  );
  // The other surface is still generation zero: even a NEW seek from it is stale.
  await b.evaluate((locator) => window.engine.recordCheckpoint('book', 'seek', locator), locator);
  assert.equal(
    await b.evaluate(async () => (await window.idb.idbAll(window.idb.STORES.pendingEvents)).length),
    0,
  );
  // Delayed old ack cannot repopulate cache after reset.
  await b.evaluate(
    (locator) =>
      window.storage.mergeProgressSnapshot('book', 0, {
        bookId: 'book',
        generation: 0,
        revision: 999,
        locator,
      }),
    locator,
  );
  assert.deepEqual(await a.evaluate(() => window.storage.readProgressSnapshot('book')), {
    generation: 1,
    state: null,
  });
  // Reopen offline shares the IDB reset tombstone. It adopts generation one,
  // starts clean, and new explicit work is retained even if reset response repeats.
  await b.reload();
  await b.evaluate(async () => {
    await import('/src/progress/engine.ts');
    await import('/src/progress/storage.ts');
    await import('/src/progress/idb.ts');
  });
  await context.setOffline(true);
  const reopened = await b.evaluate(async (locator) => {
    const engine = await import('/src/progress/engine.ts');
    const storage = await import('/src/progress/storage.ts');
    const idb = await import('/src/progress/idb.ts');
    const resume = await engine.resumeLocator('book');
    await engine.recordCheckpoint('book', 'seek', locator);
    const events = (await idb.idbAll(idb.STORES.pendingEvents)).map((e) => e.value);
    await storage.mergeProgressSnapshot('book', 1, null);
    const retained = (await idb.idbAll(idb.STORES.pendingEvents)).map((e) => e.value);
    return { resume, events, retained };
  }, locator);
  assert.equal(reopened.resume, null);
  assert.equal(reopened.events.length, 1);
  assert.equal(reopened.events[0].generation, 1);
  assert.deepEqual(reopened.retained, reopened.events);
  // Race both transaction orders: enqueue either commits before the reset
  // (then is deleted) or after it (then is refused). No timing sleeps.
  for (const order of ['enqueue-first', 'reset-first']) {
    const result = await a.evaluate(
      async ({ order, locator }) => {
        const { enqueueProgressEvent, mergeProgressSnapshot, readProgressSnapshot } =
          window.storage;
        const current = await readProgressSnapshot('race');
        const event = {
          eventId: crypto.randomUUID(),
          deviceId: crypto.randomUUID(),
          sessionId: crypto.randomUUID(),
          seq: 1,
          occurredAt: new Date().toISOString(),
          bookId: 'race',
          intent: 'seek',
          locator,
          generation: current.generation,
        };
        const writes =
          order === 'enqueue-first'
            ? [
                enqueueProgressEvent(event),
                mergeProgressSnapshot('race', current.generation + 1, null),
              ]
            : [
                mergeProgressSnapshot('race', current.generation + 1, null),
                enqueueProgressEvent(event),
              ];
        await Promise.all(writes);
        // An emergency pre-reset stash replay is subject to the same transaction.
        const accepted = await enqueueProgressEvent(event);
        return {
          accepted,
          pending: (await window.idb.idbAll(window.idb.STORES.pendingEvents))
            .map((e) => e.value)
            .filter((e) => e.bookId === 'race'),
          snapshot: await readProgressSnapshot('race'),
        };
      },
      { order, locator },
    );
    assert.equal(result.accepted, false);
    assert.equal(result.pending.length, 0);
    assert.equal(result.snapshot.state, null);
  }
  console.log(
    'PASS real IndexedDB two-tab reset, stale live seek, delayed ack, offline reopen, repeated response, and both transaction orders',
  );
  await context.close();
} finally {
  await browser.close();
}
