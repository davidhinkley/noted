/**
 * D15 Tier 2 — regression checks at the boundary where the bugs actually lived.
 *
 * Tier 1 (`pnpm check:shell`) is static. These are not: each one drives the real
 * entry points in a real browser and reads the real download, because the three
 * export defects all produced a *valid-looking file* and a test of the helper
 * `inlineAttachments` passed while both callers were broken.
 *
 *   1. `.md` download contains a data: URI and zero bare `attachment:<id>`.
 *   2. `.zip` download, unzipped in-page, contains a data: URI and zero bare refs.
 *   3. The app boots with the network unreachable, served by the service worker.
 *   4. A blank line typed in the editor survives the settle repaint.
 *
 * Requires a network on first run: the CDN libraries are runtime-cached, not
 * precached (see sw.js), so an offline launch is only meaningful after one
 * online load. That limitation is recorded in D15 rather than papered over.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8799';

// Read the cache version out of sw.js rather than hardcoding it here. A bump is
// a release step (D15 Tier 1 checks it), so a copy in this file would either
// break on every release or — worse — invite someone to weaken the assertion
// to keep the suite green.
const CACHE_VERSION = readFileSync(new URL('../sw.js', import.meta.url), 'utf8')
  .match(/const CACHE_VERSION = '([^']+)'/)[1];

// The app is an Alpine component; its methods live on the instance, not on
// window and not as module exports.
const APP = `document.querySelector('[x-data]')._x_dataStack[0]`;

// Capture whatever Blob the export path hands to a download, without letting
// the real download start. Returns null if nothing was captured.
const CAPTURE_DOWNLOAD = `async (fn) => {
  const origCreate = URL.createObjectURL;
  const origClick = HTMLAnchorElement.prototype.click;
  let blob = null;
  URL.createObjectURL = function (b) { blob = b; return origCreate.call(URL, b); };
  HTMLAnchorElement.prototype.click = function () {};
  try { await fn(); } finally {
    URL.createObjectURL = origCreate;
    HTMLAnchorElement.prototype.click = origClick;
  }
  return blob;
}`;

// Paste a real PNG through the real paste handler and let the debounce settle.
const PASTE_PNG = `async (color) => {
  const cv = document.createElement('canvas');
  cv.width = 160; cv.height = 120;
  const cx = cv.getContext('2d');
  cx.fillStyle = color; cx.fillRect(0, 0, 160, 120);
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'p.png', { type: 'image/png' }));
  const host = document.querySelector('.wysiwyg-host');
  host.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 1800));
}`;

test.describe('D15 Tier 2: export inlining and offline boot', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL + '/#/');
    await page.waitForSelector('[x-data]');
    // The editor is behind an x-if on the note route, so a note must be open
    // before the WYSIWYG surface exists.
    await page.click('button:has-text("+ New")');
    await page.waitForSelector('.wysiwyg-host');
    await page.waitForTimeout(400);
  });

  test('.md export inlines a pasted PNG and leaves zero bare refs', async ({ page }) => {
    const md = await page.evaluate(
      async ([app, capture, paste]) => {
        await eval(paste)('#c33');
        const blob = await eval(capture)(async () => {
          await eval(app).exportMD();
        });
        return blob ? await blob.text() : null;
      },
      [APP, CAPTURE_DOWNLOAD, PASTE_PNG],
    );

    expect(md, 'the export produced no download').not.toBeNull();
    expect(md, '.md must inline the attachment as a data: URI').toMatch(
      /!\[[^\]]*\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/,
    );
    expect(md, '.md must contain zero unresolved attachment refs').not.toMatch(
      /attachment:[0-9a-fA-F-]{36}/,
    );
  });

  test('.zip export inlines a pasted PNG and leaves zero bare refs', async ({ page }) => {
    const result = await page.evaluate(
      async ([app, capture, paste]) => {
        await eval(paste)('#39c');
        const blob = await eval(capture)(async () => {
          await eval(app).exportZip();
        });
        if (!blob) return { captured: false };

        // Unzip with the same JSZip the app already loaded via the import map.
        const mod = await import('jszip');
        const JSZip = mod.default ?? mod.JSZip ?? window.JSZip;
        const zip = await new JSZip().loadAsync(await blob.arrayBuffer());
        let inlined = 0;
        let bare = 0;
        let files = 0;
        for (const [name, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue;
          files += 1;
          const text = await entry.async('string');
          if (/data:image\/png;base64,/.test(text)) inlined += 1;
          if (/attachment:[0-9a-fA-F-]{36}/.test(text)) bare += 1;
        }
        return { captured: true, inlined, bare, files };
      },
      [APP, CAPTURE_DOWNLOAD, PASTE_PNG],
    );

    expect(result.captured, 'the export produced no download').toBe(true);
    expect(result.files).toBeGreaterThan(0);
    expect(result.inlined, 'zip entries must inline the attachment').toBeGreaterThan(0);
    expect(result.bare, 'zip entries must contain zero bare attachment refs').toBe(0);
  });

  test('app boots with the network unreachable', async ({ page, context }) => {
    // One online load with the worker enabled, so the shell is precached and
    // the CDN libraries are runtime-cached. pwa.js reads the flag from
    // location.search, so ?sw=1 must precede the hash -- in '/#?sw=1' it is
    // part of the route and the worker is skipped.
    await page.goto(BASE_URL + '/?sw=1#/');
    await page.waitForSelector('[x-data]');
    await page.waitForTimeout(1500);

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      return names;
    });
    expect(cached, 'the service worker never opened a cache').toContain(CACHE_VERSION);

    // Seed a note directly through the storage layer. The point of this test
    // is that IndexedDB survives a boot with no network, so it should not be
    // coupled to the editor's debounced save -- the two export tests above
    // already cover the editor -> onBodyChange -> touch() path.
    const seeded = await page.evaluate(async () => {
      const db = await import('./js/db.js');
      const note = await db.createNote({ body: 'offline boot data' });
      const all = await db.listActiveNotes();
      return { id: note.id, count: all.length };
    });
    expect(seeded.count, 'the seeded note did not commit').toBeGreaterThan(0);

    // Registration alone is not enough. The worker must be *controlling* this
    // page -- clients.claim() is asynchronous, and an uncontrolled navigation
    // bypasses the fetch handler entirely and fails as ERR_FAILED. Wait for
    // the controller explicitly rather than guessing with a sleep.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', resolve, {
            once: true,
          });
        });
      }
    });

    // The CDN libraries are runtime-cached (stale-while-revalidate), not
    // precached, and the fetch handler only sees requests made *after* the
    // worker controls the page. The first load therefore installs the worker
    // but bypasses it for the CDN, so nothing cross-origin is cached yet.
    // Offline capability begins on the second visit -- this second online
    // load is what makes it real, and it is a genuine property of the app
    // rather than a quirk of the test.
    await page.reload();
    await page.waitForSelector('[x-data]');
    // This reload lands on the list route, so there is no editor to wait for;
    // give the app a beat to finish booting and reading Dexie.
    await page.waitForSelector('.note-card', { timeout: 10000 });
    await page.waitForTimeout(400);

    // Confirm the shell cached a cross-origin entry before cutting the
    // network, otherwise the offline boot below would assert nothing.
    const runtimeCached = await page.evaluate(async (version) => {
      const cache = await caches.open(version);
      const keys = await cache.keys();
      return keys.filter((r) => new URL(r.url).origin !== self.location.origin).length;
    }, CACHE_VERSION);
    expect(runtimeCached, 'no CDN runtime entries were cached; offline boot is untestable').toBeGreaterThan(0);

    await context.setOffline(true);
    await page.reload();

    // The app must boot from the service worker alone.
    await page.waitForSelector('[x-data]', { timeout: 15000 });
    const booted = await page.evaluate((app) => {
      const a = eval(app);
      return { hasApp: !!a, mode: a.mode };
    }, APP);
    expect(booted.hasApp, 'Alpine did not initialise offline').toBe(true);
    expect(booted.mode, 'the view mode was not restored offline').toBeTruthy();

    // And the note written before going offline is still there.
    const bodies = await page.evaluate(async () => {
      const db = await import('./js/db.js');
      const notes = await db.listActiveNotes();
      return notes.map((n) => n.body || '');
    });
    expect(bodies.some((b) => b.includes('offline boot data')),
      'IndexedDB content did not survive an offline boot').toBe(true);
  });
});

test.describe('D15 Tier 2: the editor does not eat blank lines', () => {
  // Markdown cannot represent a trailing empty block -- `marked` drops
  // trailing blank lines -- so a settle that re-renders for that difference
  // deletes the line the user just created and strands the caret in the
  // previous block. The symptom is not a lost line but misplaced text: the
  // next keystroke is concatenated onto the previous line. Both halves of
  // that are asserted here, because "the line disappeared" is the half that
  // is visible and "my text merged into the wrong line" is the half that
  // loses work.

  const blocks = (page) =>
    page.locator('.wysiwyg-host').evaluate((h) => h.children.length);

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL + '/#/');
    await page.waitForSelector('[x-data]');
    await page.click('button:has-text("+ New")');
    await page.waitForSelector('.wysiwyg-host');
    await page.waitForTimeout(300);
  });

  test('Enter on a brand-new note keeps the blank line', async ({ page }) => {
    await page.locator('.wysiwyg-host').click();
    expect(await blocks(page)).toBe(1);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(600); // well past SETTLE_MS

    expect(await blocks(page), 'the blank line was swallowed by the repaint').toBe(2);
  });

  test('text typed after Enter lands on the new line, not the previous one', async ({ page }) => {
    const host = page.locator('.wysiwyg-host');
    await host.click();
    await page.keyboard.type('one');
    await page.waitForTimeout(600);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    expect(await blocks(page), 'the second Enter was swallowed').toBe(3);

    await page.keyboard.type('two');
    await page.waitForTimeout(600);

    const body = await page.evaluate(() => {
      const a = document.querySelector('[x-data]')._x_dataStack[0];
      return a.note.body;
    });
    expect(body, 'the new text was concatenated onto the previous line').toBe('one\n\ntwo');
  });

  test('Enter mid-line still splits the paragraph and places the caret correctly', async ({ page }) => {
    await page.locator('.wysiwyg-host').click();
    await page.keyboard.type('hello world');
    await page.waitForTimeout(600);
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowLeft');

    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    expect(await blocks(page)).toBe(2);

    // Guards the fix: skipping the repaint must not strand the caret when the
    // edit *is* real formatting, or every Enter would stop splitting.
    await page.keyboard.type('XY');
    await page.waitForTimeout(600);

    const body = await page.evaluate(() => {
      const a = document.querySelector('[x-data]')._x_dataStack[0];
      return a.note.body;
    });
    expect(body).toBe('hello\n\nXY world');
  });
});
