/* sw.js — offline shell cache.
 *
 * - Precaches SAME-ORIGIN shell files only. CDN URLs are cross-origin and
 *   opaque; they are handled stale-while-revalidate at fetch time, never
 *   precached on install.
 * - Release step: bump CACHE_VERSION. Activate deletes older caches.
 * - All cache URLs resolve against self.registration.scope (never "/"),
 *   so the app works from any subdirectory.
 */

const CACHE_VERSION = 'noted-v17';

const SHELL_FILES = [
  'index.html',
  'css/style.css',
  'js/crypto.js',
  'js/db.js',
  'js/search.js',
  'js/router.js',
  'js/pwa.js',
  'js/ui/app.js',
  'js/ui/editor.js',
  'js/ui/settings.js',
  'js/io/export.js',
  'js/io/import.js',
  'manifest.json',
  'icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const base = self.registration.scope;
      const cache = await caches.open(CACHE_VERSION);
      await cache.addAll(SHELL_FILES.map((file) => new URL(file, base).href));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline navigation fallback: the hash router only ever needs the shell.
    if (request.mode === 'navigation') {
      const cached = await caches.match(new URL('index.html', self.registration.scope).href);
      if (cached) return cached;
    }
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      // Opaque cross-origin responses can't be status-checked; cache them.
      if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}
