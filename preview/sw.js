/* Nova OS service worker
 * Cache version: bump CACHE_NAME whenever you change precached files
 * (index.html, manifest, icons, vendor, or this script's precache list).
 * All asset URLs are relative so the worker works at both "/" and "/nova-os/".
 */
const CACHE_NAME = 'nova-os-offline-v2';
const CACHE_PREFIX = 'nova-os-offline-';
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-192-maskable.png',
  'icon-512-maskable.png',
  'vendor/supabase-js.mjs'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const missed = [];
    for (const url of PRECACHE) {
      try {
        await cache.add(url);
      } catch (err) {
        missed.push(url);
      }
    }
    if (missed.includes('index.html')) {
      throw new Error('Nova OS SW: failed to precache index.html');
    }
    if (missed.length) {
      console.warn('Nova OS SW: optional precache missed', missed);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Only Nova OS's own files are handled. Other apps on the same origin
// (e.g. living-world/, preview/, downloads/) pass straight through.
const SCOPE = new URL('./', self.location).href;
const OWN = new Set(PRECACHE.map((p) => new URL(p, SCOPE).href));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  url.search = '';
  url.hash = '';
  const isRootNav = request.mode === 'navigate' &&
    (url.href === SCOPE || url.href === new URL('index.html', SCOPE).href);
  if (!OWN.has(url.href) && !isRootNav) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && response.ok) await cache.put(request, response.clone());
      return response;
    } catch (err) {
      if (isRootNav) {
        return (await cache.match('index.html')) || (await cache.match('./'));
      }
      throw err;
    }
  })());
});
