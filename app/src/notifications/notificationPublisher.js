const FIFONY_NOTIFICATION_MESSAGE_TYPE = "FIFONY_NOTIFICATION";
const DEFAULT_NOTIFICATION_ICON = "/icon.svg";
const DEFAULT_NOTIFICATION_BADGE = "/favicon.png";
const FIFONY_DEFAULT_NOTIFICATION_URL = "/kanban";

function ensureString(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function resolveUrl(value) {
  return ensureString(value, FIFONY_DEFAULT_NOTIFICATION_URL);
}

function normalizeNotificationTag(tag) {
  const normalized = ensureString(tag, "fifony");
  return normalized.startsWith("fifony-") ? normalized : `fifony-${normalized}`;
}

function resolveNotificationPermission() {
  if (typeof window === "undefined") return "unsupported";
  if (!window.Notification) return "unsupported";
  return window.Notification.permission;
}

function buildNotificationOptions(payload) {
  const tag = normalizeNotificationTag(payload.tag);
  const body = ensureString(payload.body, "");
  const icon = ensureString(payload.icon, DEFAULT_NOTIFICATION_ICON);
  const badge = ensureString(payload.badge, DEFAULT_NOTIFICATION_BADGE);
  const url = resolveUrl(payload.url);
  const rawData = payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data
    : {};

  return {
    body,
    tag,
    icon,
    badge,
    silent: false,
    data: {
      ...rawData,
      url,
    },
  };
}

async function publishThroughServiceWorker(payload) {
  if (!("serviceWorker" in navigator)) return false;

  const registration = await navigator.serviceWorker.getRegistration();
  const target = registration?.active;
  if (!target) return false;

  try {
    target.postMessage({ type: FIFONY_NOTIFICATION_MESSAGE_TYPE, payload });
    return true;
  } catch {
    return false;
  }
}

function publishLocally(title, options) {
  if (typeof window === "undefined") return false;
  if (!window.Notification) return false;
  try {
    new window.Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Publish a system notification.
 *
 * Prefers service-worker delivery and falls back to Notification API on the main thread.
 * Returns true if a publication path was invoked.
 */
export async function publishNotification(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (resolveNotificationPermission() !== "granted") return false;

  const title = ensureString(payload.title, "fifony");
  const options = buildNotificationOptions(payload);
  const swPayload = { title, ...options };
  const deliveredViaSW = await publishThroughServiceWorker(swPayload);

  if (deliveredViaSW) return true;
  return publishLocally(title, options);
}

export { FIFONY_NOTIFICATION_MESSAGE_TYPE };
