const CACHE_NAME = "completion-iq-mobile-v34";
const ASSETS = [
  "./mobile.html",
  "./customer.html",
  "./manager.html",
  "./pitch.html",
  "./open-mobile.html",
  "./banker-support-mobile-qr.png",
  "./mobile.css",
  "./config.js?v=20260610-netlify",
  "./mobile.js?v=20260708-alert-correct-ocr",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
