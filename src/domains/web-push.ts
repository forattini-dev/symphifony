/**
 * Web Push notification management.
 *
 * - Auto-generates VAPID keys on first use and persists them in settings.
 * - Stores push subscriptions in memory (rebuilt on boot from settings).
 * - Sends push notifications when issue state changes.
 */

import webpush from "web-push";
import { logger } from "../concerns/logger.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type PushSubscriptionData = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type VapidKeys = {
  publicKey: string;
  privateKey: string;
};

// ── State ────────────────────────────────────────────────────────────────────

let vapidKeys: VapidKeys | null = null;
let vapidConfigured = false;
const subscriptions = new Map<string, PushSubscriptionData>();

// ── Setting IDs ──────────────────────────────────────────────────────────────

export const SETTING_ID_VAPID_PUBLIC = "system.push.vapidPublicKey";
export const SETTING_ID_VAPID_PRIVATE = "system.push.vapidPrivateKey";
export const SETTING_ID_PUSH_SUBSCRIPTIONS = "system.push.subscriptions";
export const SETTING_ID_PUSH_CONTACT = "system.push.contact";

// ── VAPID key management ─────────────────────────────────────────────────────

export function getVapidPublicKey(): string | null {
  return vapidKeys?.publicKey ?? null;
}

export function isWebPushReady(): boolean {
  return vapidConfigured && vapidKeys !== null;
}

/**
 * Initialize web push. Call once at boot after settings are loaded.
 * Generates VAPID keys if they don't exist, configures web-push library.
 */
export async function initWebPush(
  loadSetting: (id: string) => Promise<unknown>,
  saveSetting: (id: string, value: unknown, scope: string) => Promise<void>,
): Promise<void> {
  try {
    let publicKey = (await loadSetting(SETTING_ID_VAPID_PUBLIC)) as string | undefined;
    let privateKey = (await loadSetting(SETTING_ID_VAPID_PRIVATE)) as string | undefined;

    if (!publicKey || !privateKey) {
      // Generate new VAPID keys
      const generated = webpush.generateVAPIDKeys();
      publicKey = generated.publicKey;
      privateKey = generated.privateKey;

      await saveSetting(SETTING_ID_VAPID_PUBLIC, publicKey, "system");
      await saveSetting(SETTING_ID_VAPID_PRIVATE, privateKey, "system");
      logger.info("[WebPush] Generated and saved new VAPID keys");
    }

    const contact = ((await loadSetting(SETTING_ID_PUSH_CONTACT)) as string) || "mailto:fifony@localhost";

    webpush.setVapidDetails(contact, publicKey, privateKey);
    vapidKeys = { publicKey, privateKey };
    vapidConfigured = true;

    // Restore saved subscriptions
    const saved = (await loadSetting(SETTING_ID_PUSH_SUBSCRIPTIONS)) as PushSubscriptionData[] | undefined;
    if (Array.isArray(saved)) {
      for (const sub of saved) {
        if (sub.endpoint) subscriptions.set(sub.endpoint, sub);
      }
      logger.info({ count: subscriptions.size }, "[WebPush] Restored push subscriptions");
    }

    logger.info("[WebPush] Initialized");
  } catch (err) {
    logger.warn({ err: String(err) }, "[WebPush] Failed to initialize — push notifications disabled");
  }
}

// ── Subscription management ──────────────────────────────────────────────────

export async function addSubscription(
  sub: PushSubscriptionData,
  persistSubscriptions: (subs: PushSubscriptionData[]) => Promise<void>,
): Promise<void> {
  subscriptions.set(sub.endpoint, sub);
  await persistSubscriptions([...subscriptions.values()]);
  logger.info({ endpoint: sub.endpoint.slice(0, 60) }, "[WebPush] Subscription added");
}

export async function removeSubscription(
  endpoint: string,
  persistSubscriptions: (subs: PushSubscriptionData[]) => Promise<void>,
): Promise<void> {
  subscriptions.delete(endpoint);
  await persistSubscriptions([...subscriptions.values()]);
  logger.debug({ endpoint: endpoint.slice(0, 60) }, "[WebPush] Subscription removed");
}

export function getSubscriptionCount(): number {
  return subscriptions.size;
}

// ── Push delivery ────────────────────────────────────────────────────────────

export type PushPayload = {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  url?: string;
};

/**
 * Send a push notification to all subscribed clients.
 * Silently removes stale subscriptions (410 Gone).
 */
export async function sendPushToAll(
  payload: PushPayload,
  persistSubscriptions: (subs: PushSubscriptionData[]) => Promise<void>,
): Promise<number> {
  if (!vapidConfigured || subscriptions.size === 0) return 0;

  const jsonPayload = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;

  const results = await Promise.allSettled(
    [...subscriptions.values()].map(async (sub) => {
      try {
        await webpush.sendNotification(sub, jsonPayload, { TTL: 3600 });
        sent++;
      } catch (err: any) {
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          // Subscription expired — remove it
          subscriptions.delete(sub.endpoint);
          removed++;
        } else {
          logger.debug({ err: String(err), endpoint: sub.endpoint.slice(0, 60) }, "[WebPush] Failed to send");
        }
      }
    }),
  );

  if (removed > 0) {
    await persistSubscriptions([...subscriptions.values()]);
    logger.debug({ removed }, "[WebPush] Cleaned stale subscriptions");
  }

  if (sent > 0) {
    logger.debug({ sent, total: subscriptions.size, tag: payload.tag }, "[WebPush] Push delivered");
  }

  return sent;
}
