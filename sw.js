// Service worker: makes the app usable on a phone with no connection.
//
// The shell (HTML, CSS, modules, icons) is cached on install and served
// cache-first — it only changes when SHELL_VERSION is bumped. The decks are
// served stale-while-revalidate, so rebuilding content reaches devices on the
// next load without a version bump, and still works offline in the meantime.

// Bump SHELL_VERSION whenever any file in SHELL_ASSETS changes, otherwise
// installed devices keep running the old HTML/CSS/JS from cache. Content JSON
// does not need a bump — it is revalidated on every load.
const SHELL_VERSION = 'shell-v5';
const CONTENT_CACHE = 'content-v1';

const SHELL_ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/answer.js',
  'js/content.js',
  'js/kana.js',
  'js/srs.js',
  'js/stats.js',
  'js/store.js',
  'js/sync.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

const CONTENT_ASSETS = [
  'content/kanji.json',
  'content/vocabulary.json',
  'content/grammar.json',
  'content/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_VERSION);
      await shell.addAll(SHELL_ASSETS);
      // Warm the decks too, so a freshly installed app works offline straight
      // away rather than only after the first online visit.
      const content = await caches.open(CONTENT_CACHE);
      await content.addAll(CONTENT_ASSETS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_VERSION, CONTENT_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !keep.has(name)).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

function isContentRequest(url) {
  return url.pathname.includes('/content/') && url.pathname.endsWith('.json');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Never cache the sync API — it must always hit the network, and failing is
  // fine because sync is best-effort.
  if (url.origin !== self.location.origin) {
    return;
  }

  if (isContentRequest(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(SHELL_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    // A navigation that missed the cache still gets the app shell, so deep
    // links like #stats work offline.
    if (request.mode === 'navigate') {
      const fallback = await caches.match('index.html');
      if (fallback) {
        return fallback;
      }
    }
    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CONTENT_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    return cached;
  }
  const response = await network;
  if (response) {
    return response;
  }
  throw new Error(`Offline and ${request.url} is not cached`);
}
