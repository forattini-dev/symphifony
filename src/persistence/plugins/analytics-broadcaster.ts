/**
 * Analytics broadcaster — computes analytics payloads and pushes them to
 * subscribed WS clients via analytics rooms. Called periodically from
 * queue-workers and immediately when a client subscribes to a topic.
 */

import { getAnalytics as getTokenAnalytics, getHourlySnapshot } from "../../domains/tokens.ts";
import { computeQualityGateMetrics } from "../../domains/metrics.ts";
import { getEcDailyEvents, getEcDailyLines } from "../store.ts";
import {
  analyticsRoomHasSubscribers,
  sendToAnalyticsRoom,
  wsClients,
  setAnalyticsOnSubscribeFn,
} from "../../routes/websocket.ts";
import { logger } from "../../concerns/logger.ts";
import type { RuntimeState } from "../../types.ts";
import type { DailyBucket } from "../../domains/tokens.ts";

// ── Per-topic push functions ──────────────────────────────────────────────────

async function computeTokensPayload(): Promise<Record<string, unknown>> {
  const [tokenData, ecEvents] = await Promise.all([
    Promise.resolve(getTokenAnalytics()),
    getEcDailyEvents(),
  ]);
  let daily: DailyBucket[] = tokenData.daily;
  if (ecEvents.length > 0) {
    const eventsByDate = new Map(ecEvents.map((e: { date: string; events: number }) => [e.date, e.events]));
    const dateSet = new Set(daily.map((d) => d.date));
    daily = daily.map((d) => ({ ...d, events: (eventsByDate.get(d.date) ?? 0) + (d.events ?? 0) }));
    for (const e of ecEvents) {
      if (!dateSet.has(e.date)) {
        daily.push({ date: e.date, inputTokens: 0, outputTokens: 0, totalTokens: 0, events: e.events });
      }
    }
    daily.sort((a, b) => a.date.localeCompare(b.date));
  }
  return { ok: true, ...tokenData, daily };
}

function computeKpisPayload(state: RuntimeState): Record<string, unknown> {
  const doneIssues = state.issues.filter(
    (i) => (i.state === "Approved" || i.state === "Merged") && i.completedAt,
  );
  const msToDay = (ms: number) => ms / (1000 * 60 * 60 * 24);
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const median = (arr: number[]) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const reviewMs = doneIssues.filter((i) => i.reviewingAt && i.completedAt).map((i) => Date.parse(i.completedAt!) - Date.parse(i.reviewingAt!)).filter((ms) => ms > 0);
  const cycleMs = doneIssues.filter((i) => i.startedAt && i.completedAt).map((i) => Date.parse(i.completedAt!) - Date.parse(i.startedAt!)).filter((ms) => ms > 0);
  const prSizes = doneIssues.filter((i) => typeof i.linesAdded === "number" || typeof i.linesRemoved === "number").map((i) => (i.linesAdded ?? 0) + (i.linesRemoved ?? 0));
  const issueCycleMs = doneIssues.filter((i) => i.createdAt && i.completedAt).map((i) => Date.parse(i.completedAt!) - Date.parse(i.createdAt)).filter((ms) => ms > 0);
  return {
    ok: true,
    sampleSize: doneIssues.length,
    reviewTurnaroundDays: reviewMs.length ? { avg: msToDay(avg(reviewMs)!), median: msToDay(median(reviewMs)!), n: reviewMs.length } : null,
    prCycleTimeDays: cycleMs.length ? { avg: msToDay(avg(cycleMs)!), median: msToDay(median(cycleMs)!), n: cycleMs.length } : null,
    prSizeLines: prSizes.length ? { avg: avg(prSizes)!, median: median(prSizes)!, n: prSizes.length } : null,
    issueCycleTimeDays: issueCycleMs.length ? { avg: msToDay(avg(issueCycleMs)!), median: msToDay(median(issueCycleMs)!), n: issueCycleMs.length } : null,
    qualityGate: computeQualityGateMetrics(state.issues),
  };
}

// ── Broadcast to all subscribers of a topic ───────────────────────────────────

export async function pushTokenAnalytics(): Promise<void> {
  if (!analyticsRoomHasSubscribers("analytics:tokens")) return;
  try {
    sendToAnalyticsRoom("analytics:tokens", await computeTokensPayload());
  } catch (err) {
    logger.warn({ err }, "[AnalyticsBroadcaster] Failed to push token analytics");
  }
}

export async function pushLinesAnalytics(): Promise<void> {
  if (!analyticsRoomHasSubscribers("analytics:lines")) return;
  try {
    const lines = await getEcDailyLines(90);
    sendToAnalyticsRoom("analytics:lines", { ok: true, lines });
  } catch (err) {
    logger.warn({ err }, "[AnalyticsBroadcaster] Failed to push lines analytics");
  }
}

export function pushKpiAnalytics(state: RuntimeState): void {
  if (!analyticsRoomHasSubscribers("analytics:kpis")) return;
  try {
    sendToAnalyticsRoom("analytics:kpis", computeKpisPayload(state));
  } catch (err) {
    logger.warn({ err }, "[AnalyticsBroadcaster] Failed to push KPI analytics");
  }
}

export function pushHourlyAnalytics(hours = 24): void {
  if (!analyticsRoomHasSubscribers("analytics:hourly")) return;
  try {
    sendToAnalyticsRoom("analytics:hourly", { ok: true, ...getHourlySnapshot(hours) });
  } catch (err) {
    logger.warn({ err }, "[AnalyticsBroadcaster] Failed to push hourly analytics");
  }
}

/** Push all analytics topics that have subscribers. Called periodically. */
export async function pushAllAnalytics(state: RuntimeState): Promise<void> {
  await Promise.allSettled([
    pushTokenAnalytics(),
    pushLinesAnalytics(),
    Promise.resolve(pushHourlyAnalytics()),
    Promise.resolve(pushKpiAnalytics(state)),
  ]);
}

// ── On-subscribe push (immediate snapshot for new subscriber) ─────────────────

async function pushAnalyticsForSocket(
  socketId: string,
  topic: string,
  state: RuntimeState,
): Promise<void> {
  const send = wsClients.get(socketId);
  if (!send) return;
  try {
    let payload: Record<string, unknown> | null = null;
    if (topic === "analytics:tokens") payload = await computeTokensPayload();
    else if (topic === "analytics:lines") { const lines = await getEcDailyLines(90); payload = { ok: true, lines }; }
    else if (topic === "analytics:hourly") payload = { ok: true, ...getHourlySnapshot(24) };
    else if (topic === "analytics:kpis") payload = computeKpisPayload(state);
    if (payload) send(JSON.stringify({ type: "analytics:update", topic, data: payload }));
  } catch (err) {
    logger.debug({ err, topic, socketId }, "[AnalyticsBroadcaster] Failed to push on subscribe");
  }
}

/** Wire up the on-subscribe callback so new subscribers get an immediate snapshot. */
export function initAnalyticsBroadcaster(state: RuntimeState): void {
  setAnalyticsOnSubscribeFn((socketId, topic) => {
    pushAnalyticsForSocket(socketId, topic, state).catch(() => {});
  });
}
