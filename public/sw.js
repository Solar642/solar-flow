const CACHE = 'solar-flow-v2';
const APP_SHELL = [
  '/solar-flow/',
  '/solar-flow/index.html',
  '/solar-flow/manifest.webmanifest',
  '/solar-flow/favicon.svg',
  '/solar-flow/favicon.svg?v=2',
  '/solar-flow/icon-192.png',
  '/solar-flow/icon-512.png',
  '/solar-flow/icon-maskable-512.png',
  '/solar-flow/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match('/solar-flow/index.html'))));
});
