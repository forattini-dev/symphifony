const CORE_CACHE = "fifony-core-v2";
const ASSET_CACHE = "fifony-assets-v2";
const APP_SHELL_ROUTES = ["/kanban", "/issues", "/agents", "/providers", "/settings"];
const APP_SHELL_FILES = ["/offline.html", "/manifest.webmanifest", "/icon.svg", "/icon-maskable.svg"];
const API_PREFIXES = ["/api/", "/docs", "/ws"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    await cache.addAll([...APP_SHELL_ROUTES, ...APP_SHELL_FILES]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => ![CORE_CACHE, ASSET_CACHE].includes(name))
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (API_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CORE_CACHE);
        await cache.put(request, response.clone());
        return response;
      } catch {
        const cache = await caches.open(CORE_CACHE);
        return (
          await cache.match(request) ||
          await cache.match("/kanban") ||
          await cache.match("/offline.html")
        );
      }
    })());
    return;
  }

  const isStaticAsset =
    url.pathname.startsWith("/assets/") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".webmanifest");

  if (!isStaticAsset) return;

  event.respondWith((async () => {
    const cache = await caches.open(ASSET_CACHE);
    const cached = await cache.match(request);

    if (cached) {
      event.waitUntil((async () => {
        try {
          const fresh = await fetch(request);
          if (fresh?.ok) {
            await cache.put(request, fresh.clone());
          }
        } catch {}
      })());
      return cached;
    }

    try {
      const response = await fetch(request);
      if (response?.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      if (cached) return cached;
      return new Response("Offline", {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  })());
});
