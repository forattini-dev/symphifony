/**
 * Notification event catalog — single source of truth.
 *
 * Every notification the PWA can emit is defined here.
 * Settings UI, useNotifications hook, and service worker all consume this.
 */

export const NOTIFICATION_MASTER_SETTING_ID = "ui.notifications.enabled";
export const NOTIFICATION_EVENT_SETTING_PREFIX = "ui.notifications.events.";
export const NOTIFICATION_TOKEN_MILESTONES = [10_000, 50_000, 100_000, 500_000, 1_000_000];

/** @type {Array<{ id: string, state: string, label: string, description: string, icon: string, sound: boolean, defaultEnabled: boolean, group: string }>} */
export const NOTIFICATION_EVENT_CATALOG = [
  {
    id: "running",
    state: "Running",
    label: "Agent started",
    description: "When an agent begins executing an issue.",
    icon: "play",
    sound: false,
    defaultEnabled: true,
    group: "execution",
  },
  {
    id: "queued",
    state: "Queued",
    label: "Issue queued",
    description: "When an issue enters the execution queue.",
    icon: "clock",
    sound: false,
    defaultEnabled: false,
    group: "execution",
  },
  {
    id: "reviewing",
    state: "Reviewing",
    label: "Review started",
    description: "When an agent begins reviewing changes.",
    icon: "eye",
    sound: false,
    defaultEnabled: true,
    group: "review",
  },
  {
    id: "reviewed",
    state: "Reviewed",
    label: "Review complete",
    description: "When the review step finishes.",
    icon: "eye",
    sound: false,
    defaultEnabled: true,
    group: "review",
  },
  {
    id: "done",
    state: "Done",
    label: "Issue completed",
    description: "When an issue is fully done.",
    icon: "check",
    sound: true,
    defaultEnabled: true,
    group: "lifecycle",
  },
  {
    id: "blocked",
    state: "Blocked",
    label: "Issue blocked",
    description: "When an agent gets stuck and needs attention.",
    icon: "alert",
    sound: true,
    defaultEnabled: true,
    group: "lifecycle",
  },
  {
    id: "cancelled",
    state: "Cancelled",
    label: "Issue cancelled",
    description: "When an issue is cancelled after failures.",
    icon: "x",
    sound: false,
    defaultEnabled: true,
    group: "lifecycle",
  },
  {
    id: "token-milestone",
    state: "token-milestone",
    label: "Token milestone",
    description: "When token usage crosses 10K, 50K, 100K, 500K, or 1M.",
    icon: "zap",
    sound: false,
    defaultEnabled: true,
    group: "usage",
  },
];

export const NOTIFICATION_GROUPS = [
  { id: "execution", label: "Execution" },
  { id: "review", label: "Review" },
  { id: "lifecycle", label: "Lifecycle" },
  { id: "usage", label: "Usage" },
];

const CATALOG_BY_STATE = new Map(NOTIFICATION_EVENT_CATALOG.map((e) => [e.state, e]));

export function getNotificationEventConfig(state) {
  return CATALOG_BY_STATE.get(state) ?? null;
}

export function getEventSettingId(eventId) {
  return `${NOTIFICATION_EVENT_SETTING_PREFIX}${eventId}`;
}

export function isNotificationEventEnabled(settings, state) {
  const config = CATALOG_BY_STATE.get(state);
  if (!config) return false;
  const settingId = getEventSettingId(config.id);
  const setting = Array.isArray(settings) ? settings.find((s) => s?.id === settingId) : null;
  return setting?.value ?? config.defaultEnabled;
}
