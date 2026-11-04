/* Service worker: la app (HTML/CSS/JS) abre aunque no haya internet.
   Estrategia "red primero, caché de respaldo" para los archivos propios:
   cuando hay conexión siempre se obtiene la versión nueva; sin conexión
   se usa la última copia guardada. Las llamadas a Apps Script NO se
   interceptan (son de otro origen y siempre van a la red). */
var CACHE = 'produccion-beluxa-v9';
var SHELL = [
  './', './index.html', './panel.html',
  './css/styles.css',
  './js/config.js', './js/api.js', './js/cola.js', './js/app.js', './js/panel.js',
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

// Red primero, pero si la red tarda más de 4 s (WiFi sin internet) se usa la copia guardada,
// así la app abre rápido aunque no haya conexión real.
function redConLimite(req, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    fetch(req).then(function (res) { clearTimeout(t); resolve(res); }, function (err) { clearTimeout(t); reject(err); });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;   // API de Apps Script: directo a la red

  e.respondWith(
    redConLimite(req, 4000).then(function (res) {
      if (res && res.ok) {
        var copia = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copia); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match('./index.html'); });
    })
  );
});
