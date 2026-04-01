const CACHE_VERSION = "__BUILD_TIMESTAMP__";
const CORE_CACHE = `fifony-core-${CACHE_VERSION}`;
const ASSET_CACHE = `fifony-assets-${CACHE_VERSION}`;
const FIFONY_NOTIFICATION_MESSAGE_TYPE = "FIFONY_NOTIFICATION";
const APP_SHELL_ROUTES = [
  "/onboarding",
  "/kanban",
  "/milestones",
  "/issues",
  "/analytics",
  "/agents",
  "/services",
  "/settings",
  "/settings/project",
  "/settings/system",
  "/settings/agents",
  "/settings/notifications",
  "/settings/execution",
  "/settings/quality",
  "/settings/assets",
  "/settings/services",
  "/settings/appearance",
  "/settings/providers",
  "/chat",
];
const APP_SHELL_FILES = ["/offline.html", "/manifest.webmanifest", "/favicon.png", "/icon-192.png", "/icon-512.png"];
const API_PREFIXES = ["/api/", "/docs", "/ws"];

function normalizeNotificationTag(tag) {
  if (typeof tag !== "string" || !tag.trim()) return "fifony";
  return tag.startsWith("fifony-") ? tag : `fifony-${tag}`;
}

function toSafeUrl(value) {
  return typeof value === "string" && value.trim() ? value : "/kanban";
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    // Cache each route individually so one failure doesn't block the rest
    await Promise.allSettled(
      [...APP_SHELL_ROUTES, ...APP_SHELL_FILES].map(async (url) => {
        try {
          const response = await fetch(url);
          if (response.ok) await cache.put(url, response);
        } catch {}
      }),
    );
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name !== CORE_CACHE && name !== ASSET_CACHE)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();

    // Notify all clients that a new version activated (they may show a refresh banner)
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) {
      client.postMessage({ type: "SW_UPDATED", version: CACHE_VERSION });
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === FIFONY_NOTIFICATION_MESSAGE_TYPE) {
    const payload = event.data.payload || {};
    const title = typeof payload.title === "string" && payload.title.trim() ? payload.title : "fifony";
    const body = typeof payload.body === "string" ? payload.body : "";
    const notificationData = {
      ...(payload.data && typeof payload.data === "object" ? payload.data : {}),
      url: toSafeUrl(payload.data?.url),
    };
    const options = {
      body,
      tag: normalizeNotificationTag(payload.tag),
      icon: typeof payload.icon === "string" ? payload.icon : "/icon.svg",
      badge: typeof payload.badge === "string" ? payload.badge : "/favicon.png",
      silent: false,
      data: notificationData,
    };
    event.waitUntil(self.registration.showNotification(title, options));
    return;
  }

  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (event.data?.type === "GET_OFFLINE_STATUS") {
    const port = event.ports?.[0];
    if (port) {
      // Probe the API to determine online/offline state
      fetch("/health", { signal: AbortSignal.timeout(3000) })
        .then((res) => port.postMessage({ offline: !res.ok }))
        .catch(() => port.postMessage({ offline: true }));
    }
  }

  if (event.data?.type === "GET_VERSION") {
    const port = event.ports?.[0];
    if (port) {
      port.postMessage({ version: CACHE_VERSION });
    }
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
      const cache = await caches.open(CORE_CACHE);

      try {
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone());
          return response;
        }

        const cached =
          await cache.match(request) ||
          await cache.match("/kanban") ||
          await cache.match("/offline.html");
        if (cached) return cached;
        return response;
      } catch {
        // Offline: notify clients
        notifyClientsOffline();

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

// ── Web Push notification handler ─────────────────────────────────────────

self.addEventListener("push", (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const title = data.title || "fifony";
    const options = {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/favicon.png",
      tag: data.tag || "fifony-push",
      data: { url: data.url || "/kanban" },
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch {
    // Malformed push payload — ignore
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/kanban";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      // Focus existing tab if open
      for (const client of clients) {
        if (client.url.includes(url) && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open new tab
      return self.clients.openWindow(url);
    }),
  );
});

// Broadcast offline status to all window clients
async function notifyClientsOffline() {
  try {
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) {
      client.postMessage({ type: "OFFLINE" });
    }
  } catch {}
}
