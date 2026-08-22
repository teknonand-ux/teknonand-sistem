const CACHE_NAME = 'teknonand-bayi-v1';
const APP_SHELL = [
  './bayi-portali.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Network-first for the app shell so data/logic updates show up quickly,
// falling back to cache when offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Sadece aynı origin'deki (uygulama kabuğu) istekleri cache'liyoruz. Backend
  // API'sine giden cross-origin istekler burada durdurulup cache'e yazılırsa,
  // paylaşımlı bir cihazda offline moda düşüldüğünde başka bir kullanıcının
  // önbelleklenmiş yanıtı (Authorization header'ından bağımsız, URL eşleşmesiyle)
  // servis edilebilir — bu yüzden bu istekleri hiç ele almadan tarayıcıya bırakıyoruz.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
