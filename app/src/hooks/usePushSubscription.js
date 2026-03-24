import { useState, useEffect, useCallback } from "react";
import { api } from "../api.js";

/**
 * Hook to manage web push notification subscription.
 *
 * Returns:
 *   - supported: boolean — browser supports push
 *   - subscribed: boolean — currently subscribed
 *   - subscribing: boolean — subscription in progress
 *   - subscribe(): Promise<void> — subscribe to push
 *   - unsubscribe(): Promise<void> — unsubscribe from push
 *   - error: string | null — last error
 */
export function usePushSubscription() {
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState(null);

  // Check support and current subscription state
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setSupported(false);
      return;
    }
    setSupported(true);

    navigator.serviceWorker.ready.then((reg) => {
      reg.pushManager.getSubscription().then((sub) => {
        setSubscribed(!!sub);
      });
    });
  }, []);

  const subscribe = useCallback(async () => {
    setSubscribing(true);
    setError(null);
    try {
      // 1. Get VAPID public key from server
      const { publicKey } = await api.get("/push/vapid-public-key");
      if (!publicKey) throw new Error("Server did not return a VAPID public key");

      // 2. Convert VAPID key to Uint8Array
      const applicationServerKey = urlBase64ToUint8Array(publicKey);

      // 3. Subscribe via PushManager
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });

      // 4. Send subscription to server
      const subJson = sub.toJSON();
      await api.post("/push/subscribe", {
        subscription: {
          endpoint: subJson.endpoint,
          keys: {
            p256dh: subJson.keys.p256dh,
            auth: subJson.keys.auth,
          },
        },
      });

      setSubscribed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubscribing(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setSubscribing(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await api.post("/push/unsubscribe", { endpoint });
      }
      setSubscribed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubscribing(false);
    }
  }, []);

  return { supported, subscribed, subscribing, subscribe, unsubscribe, error };
}

// ── Helper ────────────────────────────────────────────────────────────────────

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
