import type { RouteRegistrar } from "./http.ts";
import { readTranscript, readAllTranscripts, getTranscriptSummary } from "../agents/transcript.ts";

export function registerTranscriptRoutes(app: RouteRegistrar): void {
  /** Summary of all execution transcripts for an issue. */
  app.get("/api/issues/:id/transcripts", (c) => {
    const issueId = c.req.param("id");
    return c.json({ ok: true, ...getTranscriptSummary(issueId) });
  });

  /** Full transcript for a specific plan version + attempt. */
  app.get("/api/issues/:id/transcripts/:key", (c) => {
    const issueId = c.req.param("id");
    const key = c.req.param("key"); // e.g. "v1a1"
    const match = key.match(/^v(\d+)a(\d+)$/);
    if (!match) {
      return c.json({ ok: false, error: "Invalid key format. Expected vNaN (e.g. v1a1)." }, 400);
    }
    const planVersion = parseInt(match[1], 10);
    const attempt = parseInt(match[2], 10);
    const entries = readTranscript(issueId, planVersion, attempt);
    return c.json({ ok: true, key, entries });
  });

  /** All transcripts for an issue (all versions/attempts). */
  app.get("/api/issues/:id/transcripts/all", (c) => {
    const issueId = c.req.param("id");
    const all = readAllTranscripts(issueId);
    return c.json({ ok: true, transcripts: all });
  });
}
