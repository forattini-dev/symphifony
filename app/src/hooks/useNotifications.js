import { useCallback, useEffect, useRef, useState } from "react";
import { useUiNotificationsSetting } from "../hooks.js";

const NOTIFY_STATES = {
  Running: { title: "Agent started", icon: "play", tag: "running" },
  Queued: { title: "Issue queued", icon: "clock", tag: "queued" },
  "In Review": { title: "Review needed", icon: "eye", tag: "review" },
  Done: { title: "Issue completed", icon: "check", tag: "done", sound: true },
  Blocked: { title: "Issue blocked", icon: "alert", tag: "blocked", sound: true },
  Cancelled: { title: "Issue cancelled", icon: "x", tag: "cancelled" },
  Interrupted: { title: "Agent interrupted", icon: "pause", tag: "interrupted" },
};

const TOKEN_MILESTONES = [10_000, 50_000, 100_000, 500_000, 1_000_000];

function formatTokenCount(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return String(tokens);
}

function getPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

function sendNotification(title, body, tag) {
  if (getPermission() !== "granted") return;
  try {
    new Notification(title, {
      body,
      tag: `fifony-${tag}`,
      icon: "/icon.svg",
      badge: "/icon.svg",
      silent: false,
    });
  } catch {
    // SW-only context or notification blocked
  }
}

// ── Web Audio notification sound ────────────────────────────────────────────

let _audioCtx = null;

function getAudioContext() {
  if (!_audioCtx) {
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return null;
    }
  }
  return _audioCtx;
}

const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function playNotificationSound(enabled) {
  if (!enabled) return;
  if (prefersReducedMotion) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const volume = 0.08;

  // First tone: 880Hz for 60ms
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "sine";
  osc1.frequency.value = 880;
  gain1.gain.setValueAtTime(volume, now);
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(now);
  osc1.stop(now + 0.06);

  // Second tone: 1100Hz for 80ms, starts after first
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = "sine";
  osc2.frequency.value = 1100;
  gain2.gain.setValueAtTime(0, now);
  gain2.gain.setValueAtTime(volume, now + 0.07);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(now + 0.07);
  osc2.stop(now + 0.15);
}

// ── Notification center hook ────────────────────────────────────────────────

let _notifId = 0;

function useNotificationCenter(issues) {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const addNotification = useCallback((notif) => {
    const id = ++_notifId;
    const entry = {
      id,
      ...notif,
      timestamp: Date.now(),
      read: false,
    };
    setNotifications((prev) => [entry, ...prev].slice(0, 30));
    setUnreadCount((c) => c + 1);
    return id;
  }, []);

  const dismissNotification = useCallback((id) => {
    setNotifications((prev) => {
      const item = prev.find((n) => n.id === id);
      if (item && !item.read) {
        setUnreadCount((c) => Math.max(0, c - 1));
      }
      return prev.filter((n) => n.id !== id);
    });
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })));
    setUnreadCount(0);
  }, []);

  // Auto-expire read notifications after 5 minutes
  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = Date.now() - 5 * 60 * 1000;
      setNotifications((prev) => prev.filter((n) => !n.read || n.timestamp > cutoff));
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  return {
    notifications,
    unreadCount,
    addNotification,
    dismissNotification,
    markAllRead,
  };
}

// ── Main notifications hook ─────────────────────────────────────────────────

export function useNotifications(issues) {
  const [enabled, setEnabledRaw] = useUiNotificationsSetting();
  const [permission, setPermission] = useState(getPermission);
  const prevStatesRef = useRef(new Map());
  const tokenMilestonesRef = useRef(new Map()); // Map<issueId, Set<milestone>>
  const notificationCenter = useNotificationCenter(issues);

  const setEnabled = useCallback((value) => {
    setEnabledRaw(value);
  }, []);

  const requestPermission = useCallback(async () => {
    if (!("Notification" in window)) return "unsupported";
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === "granted") {
      setEnabled(true);
    }
    return result;
  }, [setEnabled]);

  // Track state changes and notify
  useEffect(() => {
    if (!enabled || permission !== "granted" || !Array.isArray(issues)) return;

    const prevStates = prevStatesRef.current;
    const nextStates = new Map();

    for (const issue of issues) {
      nextStates.set(issue.id, issue.state);
      const prev = prevStates.get(issue.id);

      // Only notify on state transitions (not initial load)
      if (prev && prev !== issue.state) {
        const config = NOTIFY_STATES[issue.state];
        if (config) {
          const title = `${config.title}: ${issue.identifier}`;
          const body = issue.title;
          sendNotification(title, body, `${config.tag}-${issue.id}`);
          notificationCenter.addNotification({
            title,
            body,
            state: issue.state,
            icon: config.icon,
            issueId: issue.id,
          });

          // Play sound only for Done and Blocked
          if (config.sound) {
            playNotificationSound(enabled);
          }
        }
      }

      // Token milestone notifications
      const totalTokens = issue.tokenUsage?.totalTokens;
      if (typeof totalTokens === "number" && totalTokens > 0) {
        if (!tokenMilestonesRef.current.has(issue.id)) {
          tokenMilestonesRef.current.set(issue.id, new Set());
        }
        const seen = tokenMilestonesRef.current.get(issue.id);

        for (const milestone of TOKEN_MILESTONES) {
          if (totalTokens >= milestone && !seen.has(milestone)) {
            seen.add(milestone);
            // Skip milestone notifications on initial load (no previous state tracked)
            if (prevStates.size > 0) {
              const label = formatTokenCount(milestone);
              const title = `Token milestone: ${label}`;
              const body = `${issue.identifier} has used ${label} tokens`;
              sendNotification(title, body, `tokens-${milestone}-${issue.id}`);
              notificationCenter.addNotification({
                title,
                body,
                state: "token-milestone",
                icon: "zap",
                issueId: issue.id,
              });
            }
          }
        }
      }
    }

    prevStatesRef.current = nextStates;
  }, [issues, enabled, permission, notificationCenter.addNotification]);

  return {
    enabled,
    setEnabled,
    permission,
    supported: "Notification" in window,
    requestPermission,
    ...notificationCenter,
  };
}
