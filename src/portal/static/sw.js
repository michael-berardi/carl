// Minimal service worker: makes Carl installable as an app. The shell is cached for offline start; the API is never cached.
const SHELL = ["/", "/app.js", "/app.css", "/icon.svg", "/manifest.webmanifest"];
self.addEventListener("install", (e) => e.waitUntil(caches.open("carl-shell-v1").then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || !SHELL.includes(url.pathname)) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open("carl-shell-v1").then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
