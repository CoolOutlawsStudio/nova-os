/* Offline-first service worker for Living World Simulator */
const CACHE = 'living-world-v2.0.0';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './js/sim.js', './js/fx.js', './js/gl.js', './js/app.js',
  './icons/icon.svg', './icons/icon-32.png', './icons/icon-192.png', './icons/icon-256.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-180.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, {ignoreSearch:true}).then(hit => hit || fetch(e.request).then(res => {
    if (res.ok && new URL(e.request.url).origin === location.origin){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match('./index.html'))));
});
