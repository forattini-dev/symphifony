import { logger } from "../concerns/logger.ts";
import {
  importReferenceArtifacts,
  listReferenceRepositories,
  syncReferenceRepositories,
} from "../domains/project.ts";
import { TARGET_ROOT } from "../concerns/constants.ts";
import type { ReferenceImportKind } from "../domains/project.ts";
import { discoverSkills, discoverAgents, discoverCommands } from "../agents/skills.ts";
import { updateClaudeMdManagedBlock } from "../agents/claude-md-manager.ts";

function normalizeReferenceKind(value: unknown): ReferenceImportKind {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "all";
  if (normalized === "all" || normalized === "" || typeof value === "undefined") {
    return "all";
  }
  if (normalized === "agents" || normalized === "agent") {
    return "agents";
  }
  if (normalized === "skills" || normalized === "skill") {
    return "skills";
  }
  throw new Error(`Invalid import kind: ${normalized}`);
}

export function registerReferenceRepositoryRoutes(app: any): void {
  app.get("/api/reference-repositories", async (c: any) => {
    const repositories = listReferenceRepositories();
    return c.json({
      ok: true,
      repositories,
    });
  });

  app.post("/api/reference-repositories/sync", async (c: any) => {
    try {
      const payload = await c.req.json().catch(() => ({})) as { repository?: string };
      const repository = typeof payload?.repository === "string"
        ? payload.repository.trim() || undefined
        : undefined;

      const results = syncReferenceRepositories(repository);
      const hasFailed = results.some((item) => item.action === "failed");
      return c.json({
        ok: true,
        failed: hasFailed,
        results,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, "Failed to sync reference repositories");
      const status = message.startsWith("Unknown reference repository") ? 400 : 500;
      return c.json({ ok: false, error: message }, status);
    }
  });

  app.post("/api/reference-repositories/import", async (c: any) => {
    try {
      const payload = await c.req.json() as {
        repository?: string;
        kind?: unknown;
        overwrite?: boolean;
        dryRun?: boolean;
        global?: boolean;
      };

      const repository = typeof payload?.repository === "string" ? payload.repository.trim() : "";
      if (!repository) {
        return c.json({ ok: false, error: "repository is required." }, 400);
      }

      const kind = normalizeReferenceKind(payload?.kind);
      const summary = importReferenceArtifacts(repository, TARGET_ROOT, {
        kind,
        overwrite: payload?.overwrite === true,
        dryRun: payload?.dryRun === true,
        importToGlobal: payload?.global === true,
      });

      if (!payload?.dryRun) {
        try {
          updateClaudeMdManagedBlock(TARGET_ROOT, discoverSkills(TARGET_ROOT), discoverAgents(TARGET_ROOT), discoverCommands(TARGET_ROOT));
        } catch { /* non-critical */ }
      }

      return c.json({
        ok: true,
        ...summary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, "Failed to import reference repository artifacts");
      const status = message.startsWith("Unknown reference repository") || message.startsWith("Repository not synced")
        ? 400
        : 500;
      return c.json({ ok: false, error: message }, status);
    }
  });
}
