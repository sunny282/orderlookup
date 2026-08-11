// ATAAD Order Lookup — service worker
// Caches only the static app shell. Never caches API/CRM responses,
// since order data must always be fetched fresh and credentials/session
// data must never be cached client-side.

const CACHE_NAME = "ataad-shell-v1";

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/css/style.css",
  "/js/app.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache function/API calls — always go to network so order
  // lookups are always live and no order data is stored in the cache.
  if (url.pathname.startsWith("/.netlify/functions/")) {
    return;
  }

  // Only handle same-origin GET requests for the app shell.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
