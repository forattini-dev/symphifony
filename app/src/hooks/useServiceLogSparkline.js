import { useState, useEffect, useRef } from "react";
import { onServiceLog } from "./useServices.js";
import { subscribeServiceLog, unsubscribeServiceLog } from "../hooks.js";

// 10-second buckets, 30 buckets = 5-minute sliding window
// Industry standard: Grafana Loki / Datadog log volume histogram resolution
const BUCKET_MS = 10_000;
const WINDOW = 30;

/**
 * Tracks log byte volume for a service in a 5-minute sliding window.
 * Subscribes to WS-pushed chunks via onServiceLog — no polling.
 *
 * Returns:
 *   buckets   — array[30] of byte counts, oldest→newest
 *   peak      — max bytes in any single bucket (for scaling bars)
 *   hasData   — true once any chunk was received this session
 */
export function useServiceLogSparkline(id, enabled = true) {
  const [buckets, setBuckets] = useState(() => Array(WINDOW).fill(0));
  const accumRef = useRef(0);     // bytes accumulated in current open bucket
  const hasDataRef = useRef(false);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    if (!enabled || !id) return;

    accumRef.current = 0;

    // Tell the server to push log chunks for this service over WS
    subscribeServiceLog(id);

    // Accumulate incoming chunks into the current open bucket
    const unsub = onServiceLog(id, (chunk) => {
      accumRef.current += (typeof chunk === "string" ? chunk.length : 0);
      if (!hasDataRef.current) {
        hasDataRef.current = true;
        setHasData(true);
      }
    });

    // Every BUCKET_MS: commit the open bucket and slide the window
    const timer = setInterval(() => {
      const committed = accumRef.current;
      accumRef.current = 0;
      setBuckets((prev) => [...prev.slice(1), committed]);
    }, BUCKET_MS);

    return () => {
      unsubscribeServiceLog(id);
      unsub();
      clearInterval(timer);
    };
  }, [id, enabled]);

  const peak = Math.max(...buckets, 1); // avoid division by zero in callers

  return { buckets, peak, hasData };
}
