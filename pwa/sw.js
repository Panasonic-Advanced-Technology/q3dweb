/* global self, caches */
// Build-time placeholders are replaced by pwa/vitePwaPlugin.ts.
const BUILD_ID = '__PWA_BUILD_ID__';
const PRECACHE_FILES = __PWA_PRECACHE_FILES__;

const CACHE_PREFIX = `q3dweb:${self.registration.scope}:`;
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const PRECACHE_URLS = PRECACHE_FILES.map((file) => new URL(file, self.registration.scope).href);
const INDEX_URL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(INDEX_URL, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(INDEX_URL, { cacheName: CACHE_NAME });
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: CACHE_NAME, ignoreSearch: true });
  return cached ?? fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const target = `${url.origin}${url.pathname}`;

  if (request.mode === 'navigate') {
    // Only the app shell itself; other same-origin pages (e.g. /develop/) have their own SW.
    if (target === self.registration.scope || target === INDEX_URL) {
      event.respondWith(networkFirstNavigation(request));
    }
    return;
  }

  if (PRECACHE_URLS.includes(target)) {
    event.respondWith(cacheFirst(request));
  }
});
