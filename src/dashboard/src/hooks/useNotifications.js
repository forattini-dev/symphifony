import { useCallback, useEffect, useRef, useState } from "react";
import { useUiNotificationsSetting } from "../hooks.js";

const NOTIFY_STATES = {
  "In Review": { title: "Review needed", icon: "eye", tag: "review" },
  Done: { title: "Issue completed", icon: "check", tag: "done" },
  Blocked: { title: "Issue blocked", icon: "alert", tag: "blocked" },
  Cancelled: { title: "Issue cancelled", icon: "x", tag: "cancelled" },
  Interrupted: { title: "Agent interrupted", icon: "pause", tag: "interrupted" },
};

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

export function useNotifications(issues) {
  const [enabled, setEnabledRaw] = useUiNotificationsSetting();
  const [permission, setPermission] = useState(getPermission);
  const prevStatesRef = useRef(new Map());

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
          sendNotification(
            `${config.title}: ${issue.identifier}`,
            issue.title,
            `${config.tag}-${issue.id}`,
          );
        }
      }
    }

    prevStatesRef.current = nextStates;
  }, [issues, enabled, permission]);

  return {
    enabled,
    setEnabled,
    permission,
    supported: "Notification" in window,
    requestPermission,
  };
}
