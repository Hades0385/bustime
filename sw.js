const CACHE_NAME = 'bus-pwa-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/pwa-192.png',
  '/icons/pwa-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// 可選：把最後一次資料也存進 cache（for 完全離線展示）
let lastData = null;
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CACHE_LAST_DATA') {
    lastData = new Response(JSON.stringify(event.data.payload), { headers: { 'Content-Type': 'application/json' }});
  }
});

// 對前端資源用 cache-first，對資料用 network-first
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isData = /script\.googleusercontent\.com\/macros/.test(url.href);

  if (isData) {
    // 資料：網路優先，失敗回退 lastData 或 cache
    e.respondWith(
      (async () => {
        try {
          const res = await fetch(e.request);
          return res;
        } catch {
          if (lastData) return lastData.clone();
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match('/last-data.json');
          return cached || new Response(JSON.stringify({ offline: true }), { headers: { 'Content-Type': 'application/json' } });
        }
      })()
    );
    return;
  }

  // App Shell：cache-first
  e.respondWith(
    caches.match(e.request).then(resp => resp || fetch(e.request))
  );
});
