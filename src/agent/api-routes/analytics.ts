import { getAnalytics as getTokenAnalytics, getHourlySnapshot } from "../token-ledger.ts";
import { getEcDailyEvents, getEcDailyLines } from "../store.ts";
import { logger } from "../logger.ts";
import { getApiRuntimeContextOrThrow } from "../api-runtime-context.ts";

export function registerAnalyticsRoutes(app: any): void {
  app.get("/api/analytics/tokens", async (c: any) => {
    const [tokenData, ecEvents] = await Promise.all([
      Promise.resolve(getTokenAnalytics()),
      getEcDailyEvents(),
    ]);
    // Merge EC daily event counts into the daily token array
    if (ecEvents.length > 0) {
      const eventsByDate = new Map(ecEvents.map((e) => [e.date, e.events]));
      const dateSet = new Set(tokenData.daily.map((d: { date: string }) => d.date));
      const merged = tokenData.daily.map((d: { date: string; events?: number }) => ({
        ...d,
        events: (eventsByDate.get(d.date) || 0) + (d.events || 0),
      }));
      for (const e of ecEvents) {
        if (!dateSet.has(e.date)) {
          merged.push({ date: e.date, inputTokens: 0, outputTokens: 0, totalTokens: 0, events: e.events });
        }
      }
      merged.sort((a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date));
      return c.json({ ok: true, ...tokenData, daily: merged });
    }
    return c.json({ ok: true, ...tokenData });
  });

  app.get("/api/analytics/tokens/weekly", async (c: any) => {
    // Weekly is part of the daily data in the ledger — filter client-side
    return c.json({ ok: true, ...getTokenAnalytics() });
  });

  app.get("/api/analytics/hourly", async (c: any) => {
    const hours = Math.min(parseInt(c.req.query("hours") || "24", 10) || 24, 48);
    return c.json({ ok: true, ...getHourlySnapshot(hours) });
  });

  app.get("/api/analytics/lines", async (c: any) => {
    try {
      const days = Math.min(parseInt(c.req.query("days") || "90", 10) || 90, 180);
      const lines = await getEcDailyLines(days);
      return c.json({ ok: true, lines });
    } catch (error) {
      logger.error({ err: error }, "Failed to collect lines analytics");
      return c.json({ ok: true, lines: [] });
    }
  });

  app.get("/api/analytics/kpis", (c: any) => {
    try {
      const context = getApiRuntimeContextOrThrow();
      const doneIssues = context.state.issues.filter(
        (i) => i.state === "Done" && i.completedAt,
      );

      const msToDay = (ms: number) => ms / (1000 * 60 * 60 * 24);
      const avg = (arr: number[]) =>
        arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
      const median = (arr: number[]) => {
        if (!arr.length) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      };

      // Code review turnaround: reviewingAt → completedAt
      const reviewMs = doneIssues
        .filter((i) => i.reviewingAt && i.completedAt)
        .map((i) => Date.parse(i.completedAt!) - Date.parse(i.reviewingAt!))
        .filter((ms) => ms > 0);

      // PR cycle time: startedAt → completedAt
      const cycleMs = doneIssues
        .filter((i) => i.startedAt && i.completedAt)
        .map((i) => Date.parse(i.completedAt!) - Date.parse(i.startedAt!))
        .filter((ms) => ms > 0);

      // PR size: linesAdded + linesRemoved (only issues with diff data)
      const prSizes = doneIssues
        .filter((i) => typeof i.linesAdded === "number" || typeof i.linesRemoved === "number")
        .map((i) => (i.linesAdded || 0) + (i.linesRemoved || 0));

      // Issue cycle time: createdAt → completedAt
      const issueCycleMs = doneIssues
        .filter((i) => i.createdAt && i.completedAt)
        .map((i) => Date.parse(i.completedAt!) - Date.parse(i.createdAt))
        .filter((ms) => ms > 0);

      return c.json({
        ok: true,
        sampleSize: doneIssues.length,
        reviewTurnaroundDays: reviewMs.length
          ? { avg: msToDay(avg(reviewMs)!), median: msToDay(median(reviewMs)!), n: reviewMs.length }
          : null,
        prCycleTimeDays: cycleMs.length
          ? { avg: msToDay(avg(cycleMs)!), median: msToDay(median(cycleMs)!), n: cycleMs.length }
          : null,
        prSizeLines: prSizes.length
          ? { avg: avg(prSizes)!, median: median(prSizes)!, n: prSizes.length }
          : null,
        issueCycleTimeDays: issueCycleMs.length
          ? { avg: msToDay(avg(issueCycleMs)!), median: msToDay(median(issueCycleMs)!), n: issueCycleMs.length }
          : null,
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to compute KPI analytics");
      return c.json({ ok: false, error: String(error) }, 500);
    }
  });
}
