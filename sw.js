const CACHE = 'driveiq-v1';
const STATIC = [
  '/driveiq/',
  '/driveiq/index.html',
  '/driveiq/styles.css',
  '/driveiq/app.js',
  '/driveiq/manifest.json',
  '/driveiq/assets/driveiq-icon.svg',
  '/driveiq/i18n/es.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API calls: siempre red, sin cache
  if (url.pathname.startsWith('/api/')) return;
  // Archivos estáticos: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp && resp.status === 200 && e.request.method === 'GET') {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});

// ── Push notifications del sistema operativo ─────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'DriveIQ', body: '', url: '/driveiq/' };
  try { data = { ...data, ...e.data.json() }; } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    '/driveiq/assets/driveiq-icon.svg',
      badge:   '/driveiq/assets/driveiq-icon.svg',
      vibrate: [200, 100, 200],
      data:    { url: data.url },
      actions: [{ action: 'open', title: 'Ver DriveIQ' }],
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || '/driveiq/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('/driveiq/'));
      if (existing) return existing.focus();
      return clients.openWindow(targetUrl);
    })
  );
});
