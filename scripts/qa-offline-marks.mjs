#!/usr/bin/env node
// Marks made and removed without a connection, in a real browser: shown at
// once, kept on the device through a browser restart, and delivered once the
// server answers again. The server is a stand-in held in this script, so its
// state can be read back; the browser profile is a real one on disk, so
// closing the browser closes it. Run against the web dev server:
//   node scripts/qa-offline-marks.mjs http://localhost:5173
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = createRequire('/usr/local/lib/node_modules/')('playwright'));
}
const base = process.argv[2] ?? 'http://127.0.0.1:5197';
const profile = mkdtempSync(path.join(tmpdir(), 'rp-offline-marks-'));

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

// Written for this fixture: no line of any published book.
const passage =
  'The ferry left the harbour an hour late, and the passengers crowded to the rail to watch the lighthouse slide away. Somebody began to hum, and by the time the gulls turned back the whole deck was singing.';
const plen = passage.length;

/* The server, as this script keeps it. */
const server = {
  online: true,
  /** Offline, the book's list of marks still opens from the copy kept with a download. */
  keptCopy: null,
  /** Requests held unanswered, as a connection that stalls holds them. */
  stall: false,
  stalled: [],
  marks: new Map(),
  posts: [],
};
const onServer = {
  id: 'ann_onTheServerAlready',
  bookId: 'qa',
  kind: 'highlight',
  locator: { medium: 'ebook', spineIdx: 0, charOffset: plen * 3 + 3 + 4, pct: 0.01 },
  endLocator: { medium: 'ebook', spineIdx: 0, charOffset: plen * 3 + 3 + 40, pct: 0.012 },
  color: 'rose',
  selectedText: 'ferry left the harbour an hour late',
  note: null,
  createdAt: '2026-10-01T08:00:00.000Z',
};
server.marks.set(onServer.id, { ...onServer });
const listed = () => [...server.marks.values()].filter((m) => !m.deletedAt);

async function api(route) {
  const req = route.request();
  const p = new URL(req.url()).pathname;
  const method = req.method();
  const json = (data, status = 200) => route.fulfill({ status, json: data });
  if (p.endsWith('/manifest'))
    return json({
      bookId: 'qa',
      title: 'Offline marks QA',
      language: 'en',
      direction: 'ltr',
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
      toc: [],
    });
  if (p.includes('/chapter/'))
    return route.fulfill({
      contentType: 'text/html',
      body: Array.from({ length: 40 }, (_, i) => `<p id="p${i}">${passage}</p>`).join(''),
    });
  if (p.includes('/sentences/')) return json({ sentences: [] });
  if (p === '/api/books/qa') return json({ book: { id: 'qa', title: 'Offline marks QA' } });
  if (p.startsWith('/api/progress')) return json({ state: null, results: [] });
  const isMarks = p.endsWith('/annotations') || p.startsWith('/api/annotations/');
  if (!isMarks) return json({});
  if (!server.online) {
    if (method === 'GET' && server.keptCopy) return json({ annotations: server.keptCopy });
    return route.abort('internetdisconnected');
  }
  if (server.stall && method !== 'GET') {
    server.stalled.push(route);
    return;
  }
  if (method === 'GET') return json({ annotations: listed() });
  if (method === 'POST') {
    const body = req.postDataJSON();
    server.posts.push(body);
    const known = server.marks.get(body.id);
    if (known) return json({ annotation: known });
    const { ageMs, ...made } = body;
    const mark = {
      ...made,
      bookId: 'qa',
      createdAt: new Date(Date.now() - (ageMs ?? 0)).toISOString(),
    };
    server.marks.set(mark.id, mark);
    return json({ annotation: mark });
  }
  const id = decodeURIComponent(p.split('/').pop());
  const mark = server.marks.get(id);
  if (!mark) return json({ error: 'not-found' }, 404);
  if (method === 'PATCH') Object.assign(mark, req.postDataJSON());
  if (method === 'DELETE') mark.deletedAt ??= new Date().toISOString();
  return json(method === 'DELETE' ? { ok: true } : { annotation: mark });
}

async function launch() {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || undefined,
    viewport: { width: 1180, height: 820 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem(
      'rp-reader-prefs',
      JSON.stringify({ mode: 'scroll', size: 22, columns: 'one', pageTurn: 'instant' }),
    );
  });
  await page.route((url) => url.pathname.startsWith('/api/'), api);
  await page.route('**/__reader-qa/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/qa/reader.tsx"></script></body></html>',
    }),
  );
  await page.goto(`${base}/__reader-qa/qa`);
  await page.waitForSelector('#p39', { state: 'attached' });
  await page.waitForTimeout(1200);
  return { context, page, errors };
}

/** How many ranges each highlight colour is painting. */
const painted = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      ['amber', 'rose'].map((c) => [c, CSS.highlights.get(`rp-hl-${c}`)?.size ?? 0]),
    ),
  );
/** What this device still holds for the server. */
const queued = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('readport');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          // A build from before the queue has nowhere to keep a change.
          if (!db.objectStoreNames.contains('mark-changes')) {
            db.close();
            resolve([]);
            return;
          }
          const req = db.transaction('mark-changes').objectStore('mark-changes').getAll();
          req.onsuccess = () => {
            resolve(req.result.map((c) => c.change.type));
            db.close();
          };
        };
      }),
  );
async function selectAndHighlight(page, paragraph) {
  await page.evaluate((id) => {
    const node = document.getElementById(id).firstChild;
    const range = document.createRange();
    range.setStart(node, 4);
    range.setEnd(node, 52);
    document.getElementById(id).scrollIntoView({ block: 'center' });
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, paragraph);
  await page.waitForTimeout(400);
  // The colours sit behind the highlighter.
  await page.getByRole('button', { name: 'Highlight', exact: true }).click({ timeout: 5000 });
  await page.getByRole('button', { name: 'Highlight in amber' }).click({ timeout: 5000 });
}
/** Click the middle of a painted range of this colour, and remove what opens. */
async function removeHighlight(page, colour) {
  const at = await page.evaluate((c) => {
    const range = [...CSS.highlights.get(`rp-hl-${c}`)][0];
    range.startContainer.parentElement.scrollIntoView({ block: 'center' });
    const r = range.getClientRects()[0];
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
  }, colour);
  await page.waitForTimeout(300);
  await page.mouse.click(at.x, at.y);
  await page.getByRole('button', { name: 'Remove highlight' }).click({ timeout: 5000 });
}

try {
  let { context, page, errors } = await launch();
  await check('online: the book opens with the highlight already on the server', async () =>
    assert.deepEqual(await painted(page), { amber: 0, rose: 1 }),
  );

  // The connection goes. The book's marks would still open from the copy
  // kept with a download.
  server.keptCopy = listed().map((m) => ({ ...m }));
  server.online = false;
  const madeAt = Date.now();
  await check('offline: a highlight is made at the first try', async () => {
    await selectAndHighlight(page, 'p8');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.toast').filter({ hasText: 'Highlighted' }).count(), 1);
    assert.equal((await painted(page)).amber, 1);
  });
  await check('offline: a highlight is removed at the first try', async () => {
    await removeHighlight(page, 'rose');
    await page.waitForTimeout(500);
    assert.deepEqual(await painted(page), { amber: 1, rose: 0 });
  });
  await check('offline: both changes wait on this device, and the server has neither', async () => {
    assert.deepEqual(await queued(page), ['create', 'delete']);
    assert.equal(server.posts.length, 0);
    assert.equal(listed().length, 1);
  });
  await check('offline: no errors on the page', async () => assert.deepEqual(errors, []));

  // The browser is closed, and opened again with no connection.
  await context.close();
  ({ context, page, errors } = await launch());
  await check('after a restart, offline: the book opens with both changes', async () =>
    assert.deepEqual(await painted(page), { amber: 1, rose: 0 }),
  );
  // A book that was never downloaded opens its pages from the server only, but
  // the marks made on this device are still its marks.
  server.keptCopy = null;
  await context.close();
  ({ context, page, errors } = await launch());
  await check('after a restart, with no copy of the list: the new highlight is there', async () =>
    assert.equal((await painted(page)).amber, 1),
  );

  // The connection comes back.
  server.online = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(1500);
  await check('back online: the changes reach the server, once each', async () => {
    assert.equal(server.marks.get(onServer.id).deletedAt !== undefined, true, 'not removed');
    const made = listed();
    assert.equal(made.length, 1);
    assert.equal(made[0].color, 'amber');
    assert.equal(server.posts.length, 1, `${server.posts.length} deliveries`);
    assert.deepEqual(await queued(page), []);
  });
  await check(
    'back online: the highlight is dated when it was made, not when it arrived',
    async () => {
      const [made] = listed();
      assert(Math.abs(Date.parse(made.createdAt) - madeAt) < 3000, made.createdAt);
    },
  );

  // A connection that stalls rather than fails: a tap on Remove used to seem
  // to do nothing until one of several got through.
  server.stall = true;
  await check('stalled: the highlight is removed at the first tap', async () => {
    await removeHighlight(page, 'amber');
    await page.waitForTimeout(400);
    assert.deepEqual(await painted(page), { amber: 0, rose: 0 });
  });
  server.stall = false;
  for (const route of server.stalled.splice(0)) await api(route);
  await page.waitForTimeout(800);
  await check('stalled: once the server answers, the removal is delivered', async () => {
    assert.equal(listed().length, 0);
    assert.deepEqual(await queued(page), []);
  });
  await check('no errors on the page', async () => assert.deepEqual(errors, []));
  await context.close();
} finally {
  rmSync(profile, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
