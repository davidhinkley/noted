/* pwa.js — service-worker registration only. Cache logic lives in sw.js.
 *
 * The service worker is skipped on http://localhost: a controlling worker
 * serves the precached shell cache-first, which quietly freezes the app at
 * whatever files it precached first — the opposite of what a dev loop wants.
 * Opt in to offline testing during development with `?sw=1` on the URL.
 * Production origins (https on any hostname, including a subpath) register
 * normally.
 */

function isDevLocalhost() {
  const host = location.hostname;
  return (host === 'localhost' || host === '127.0.0.1' || host === '::1') && location.protocol !== 'https:';
}

async function deregisterExisting() {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((r) => r.unregister()));
  const names = await caches.keys();
  await Promise.all(names.map((n) => caches.delete(n)));
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const forceOfflineTesting = new URLSearchParams(window.location.search).has('sw');

  if (isDevLocalhost() && !forceOfflineTesting) {
    // Keep localhost free of any previously-installed worker (e.g. after an
    // offline `?sw=1` experiment) so edits always reach the browser.
    await deregisterExisting();
    return;
  }

  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('sw.js', { scope: './' });
    } catch (err) {
      console.warn('Service worker registration failed:', err);
    }
  });
}

registerServiceWorker();