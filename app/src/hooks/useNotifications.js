import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { publishNotification } from "../notifications/notificationPublisher.js";
import {
  getSettingsList,
  persistUiSetting,
  useSettings,
  useUiNotificationsSetting,
} from "../hooks.js";
import {
  NOTIFICATION_EVENT_CATALOG,
  NOTIFICATION_TOKEN_MILESTONES,
  getNotificationEventConfig,
  getEventSettingId,
  isNotificationEventEnabled,
} from "../lib/notification-catalog.js";

function formatTokenCount(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return String(tokens);
}

function getPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
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

function useNotificationCenter() {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const addNotification = useCallback((notif) => {
    const id = ++_notifId;
    const entry = { id, ...notif, timestamp: Date.now(), read: false };
    setNotifications((prev) => [entry, ...prev].slice(0, 30));
    setUnreadCount((c) => c + 1);
    return id;
  }, []);

  const dismissNotification = useCallback((id) => {
    setNotifications((prev) => {
      const item = prev.find((n) => n.id === id);
      if (item && !item.read) setUnreadCount((c) => Math.max(0, c - 1));
      return prev.filter((n) => n.id !== id);
    });
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })));
    setUnreadCount(0);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = Date.now() - 5 * 60 * 1000;
      setNotifications((prev) => prev.filter((n) => !n.read || n.timestamp > cutoff));
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  return { notifications, unreadCount, addNotification, dismissNotification, markAllRead };
}

// ── Main notifications hook ─────────────────────────────────────────────────

export function useNotifications(issues) {
  const [enabled, setEnabledRaw] = useUiNotificationsSetting();
  const [permission, setPermission] = useState(getPermission);
  const prevStatesRef = useRef(new Map());
  const tokenMilestonesRef = useRef(new Map());
  const notificationCenter = useNotificationCenter();
  const settingsQuery = useSettings();
  const settings = getSettingsList(settingsQuery.data);
  const qc = useQueryClient();

  const setEnabled = useCallback((value) => {
    setEnabledRaw(value);
  }, [setEnabledRaw]);

  const requestPermission = useCallback(async () => {
    if (!("Notification" in window)) return "unsupported";
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === "granted") setEnabled(true);
    return result;
  }, [setEnabled]);

  // Build per-event settings for the Settings UI
  const eventSettings = NOTIFICATION_EVENT_CATALOG.map((entry) => ({
    ...entry,
    enabled: isNotificationEventEnabled(settings, entry.state),
    settingId: getEventSettingId(entry.id),
  }));

  const setEventEnabled = useCallback(async (eventId, value) => {
    const settingId = getEventSettingId(eventId);
    await persistUiSetting(settingId, value);
    qc.invalidateQueries({ queryKey: ["settings"] });
  }, [qc]);

  const publishTestNotification = useCallback(() => {
    void publishNotification({
      title: "fifony",
      body: "Notifications are working!",
      tag: "ui-test",
      data: {
        url: "/settings/notifications",
      },
    });
  }, []);

  // Track state changes and notify
  useEffect(() => {
    if (!enabled || permission !== "granted" || !Array.isArray(issues)) return;

    const prevStates = prevStatesRef.current;
    const nextStates = new Map();

    for (const issue of issues) {
      nextStates.set(issue.id, issue.state);
      const prev = prevStates.get(issue.id);

      if (prev && prev !== issue.state) {
        const config = getNotificationEventConfig(issue.state);
        if (config && isNotificationEventEnabled(settings, issue.state)) {
          const title = `${config.label}: ${issue.identifier}`;
          const body = issue.title;
          void publishNotification({
            title,
            body,
            tag: `${config.id}-${issue.id}`,
            data: {
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              state: issue.state,
            },
          });
          notificationCenter.addNotification({
            title,
            body,
            state: issue.state,
            icon: config.icon,
            issueId: issue.id,
          });
          if (config.sound) playNotificationSound(enabled);
        }
      }

      // Token milestone notifications
      const totalTokens = issue.tokenUsage?.totalTokens;
      if (typeof totalTokens === "number" && totalTokens > 0) {
        if (!tokenMilestonesRef.current.has(issue.id)) {
          tokenMilestonesRef.current.set(issue.id, new Set());
        }
        const seen = tokenMilestonesRef.current.get(issue.id);

        for (const milestone of NOTIFICATION_TOKEN_MILESTONES) {
          if (totalTokens >= milestone && !seen.has(milestone)) {
            seen.add(milestone);
            if (prevStates.size > 0) {
              const milestoneConfig = getNotificationEventConfig("token-milestone");
              if (milestoneConfig && isNotificationEventEnabled(settings, "token-milestone")) {
                const label = formatTokenCount(milestone);
                const title = `Token milestone: ${label}`;
                const body = `${issue.identifier} has used ${label} tokens`;
                void publishNotification({
                  title,
                  body,
                  tag: `tokens-${milestone}-${issue.id}`,
                  data: {
                    issueId: issue.id,
                    issueIdentifier: issue.identifier,
                    milestone,
                    state: "token-milestone",
                  },
                });
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
    }

    prevStatesRef.current = nextStates;
  }, [issues, enabled, permission, settings, notificationCenter.addNotification]);

  return {
    enabled,
    setEnabled,
    permission,
    supported: "Notification" in window,
    requestPermission,
    eventSettings,
    setEventEnabled,
    publishTestNotification,
    ...notificationCenter,
  };
}
