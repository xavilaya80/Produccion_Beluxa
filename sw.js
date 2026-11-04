/* Service worker: la app (HTML/CSS/JS) abre aunque no haya internet.
   Estrategia "red primero, caché de respaldo" para los archivos propios:
   cuando hay conexión siempre se obtiene la versión nueva; sin conexión
   se usa la última copia guardada. Las llamadas a Apps Script NO se
   interceptan (son de otro origen y siempre van a la red). */
var CACHE = 'produccion-beluxa-v7';
var SHELL = [
  './', './index.html', './panel.html',
  './css/styles.css',
  './js/config.js', './js/api.js', './js/app.js', './js/panel.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/logo.jpg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;   // API de Apps Script: directo a la red

  e.respondWith(
    fetch(req).then(function (res) {
      var copia = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copia); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) { return hit || caches.match('./index.html'); });
    })
  );
});
