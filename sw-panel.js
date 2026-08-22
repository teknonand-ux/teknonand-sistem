const CACHE_NAME = 'teknonand-panel-v1';
const APP_SHELL = [
  './yonetici-paneli.html',
  './manifest-panel.json',
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
// falling back to cache when offline. Panel verisi zaten her zaman canlı
// API'den çekiliyor (bkz. apiFetch) — burada sadece uygulama kabuğu (HTML/
// ikonlar) önbelleğe alınır, offline'da veri değil sadece arayüz açılır.
// Bunu garanti altına almak için cross-origin (backend API) istekleri hiç
// ele alınmadan tarayıcıya bırakılır — aksi halde paylaşımlı bir cihazda
// offline moda düşüldüğünde başka bir kullanıcının önbelleklenmiş API
// yanıtı (Authorization header'ından bağımsız, URL eşleşmesiyle) servis
// edilebilir.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
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
