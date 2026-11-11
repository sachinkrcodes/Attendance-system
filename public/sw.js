'use strict';
// Attendly service worker: keeps the app shell so it opens fast and works offline.
// Data always comes from the network (the API is never cached).
const VERSION = 'attendly-v10';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // pages: network first, fall back to the saved shell when offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put('/', copy)); return r; }).catch(() => caches.match('/')));
    return;
  }
  // code and styles: always try the network first so a new version shows at once; use the saved copy if
  // the network is slow (3 s) or offline
  if (/\.(js|css|webmanifest)$/.test(url.pathname)) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; });
      const slow = new Promise((res) => setTimeout(async () => res(await c.match(req)), 3000));
      const hit = await c.match(req);
      try { return await (hit ? Promise.race([net, slow.then((x) => x || net)]) : net); } catch { return hit || Response.error(); }
    }));
    return;
  }
  // images and icons: show the saved copy at once, refresh it in the background
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req);
    const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
