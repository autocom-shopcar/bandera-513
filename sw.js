// Service worker: permite instalar la app y usarla sin internet.
// v8: versión de mudanza (ver app.js "Mudanza"). Subir la versión hace que todos los
// teléfonos tomen esta versión la próxima vez que abran la app con señal.
const CACHE = 'bandera-513-v8';
const ARCHIVOS = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
// Solo borra cachés viejas de ESTA app (las que empiezan con "bandera-513"): en
// autocom-shopcar.github.io el origen lo comparten otras apps (p. ej. Asistencia) y antes
// se borraban todas las cachés ajenas.
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('bandera-513') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Red primero (para recibir actualizaciones), caché si no hay conexión. Sin conexión busca
// solo en la caché de esta app, no en las de otras apps del mismo origen.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copia = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copia));
      return r;
    }).catch(() => caches.open(CACHE).then(c => c.match(e.request, { ignoreSearch: true }).then(r => r || c.match('index.html'))))
  );
});
