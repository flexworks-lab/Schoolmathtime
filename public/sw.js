"use strict";
importScripts("/scram/scramjet.all.js");
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const STATIC_CACHE = "schoolmathtime-static-v1";
const STATIC_ASSETS = ["/", "/index.html", "/styles.css", "/app.js", "/ultraviolet.html", "/ultraviolet.css", "/ultraviolet.js", "/games.html", "/games.js"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("schoolmathtime-static-") && key !== STATIC_CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
async function handleRequest(event) {
  await scramjet.loadConfig();
  if (scramjet.route(event)) return scramjet.fetch(event);
  const request = event.request;
  const url = new URL(request.url);
  // Cache only an explicit same-origin shell allowlist, never proxied content,
  // API/authentication, downloads, or CAPTCHA/security-challenge requests.
  if (request.method === "GET" && url.origin === self.location.origin && STATIC_ASSETS.includes(url.pathname)) {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === "basic") await cache.put(request, response.clone());
    return response;
  }
  return fetch(request);
}
self.addEventListener("fetch", (event) => { event.respondWith(handleRequest(event)); });
