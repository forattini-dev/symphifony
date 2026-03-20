import { logger } from "../concerns/logger.ts";
import { TARGET_ROOT } from "../concerns/constants.ts";
import {
  loadAgentCatalog,
  loadSkillCatalog,
  filterByDomains,
  installAgents,
  installSkills,
} from "../agents/catalog.ts";

export function registerCatalogRoutes(app: any): void {
  app.get("/api/catalog/agents", async (c: any) => {
    const domainsParam = c.req.query("domains");
    const domains = typeof domainsParam === "string"
      ? domainsParam.split(",").map((d: string) => d.trim()).filter(Boolean)
      : [];
    const catalog = loadAgentCatalog();
    return c.json({ agents: domains.length ? filterByDomains(catalog, domains) : catalog });
  });

  app.get("/api/catalog/skills", async (c: any) => {
    const catalog = loadSkillCatalog();
    return c.json({ skills: catalog });
  });

  app.post("/api/install/agents", async (c: any) => {
    try {
      const payload = await c.req.json() as { agents?: string[] };
      const agentNames = Array.isArray(payload.agents) ? payload.agents.filter((a): a is string => typeof a === "string") : [];
      if (agentNames.length === 0) {
        return c.json({ ok: false, error: "No agent names provided." }, 400);
      }
      const catalog = loadAgentCatalog();
      const result = installAgents(TARGET_ROOT, agentNames, catalog);
      return c.json({ ok: true, ...result });
    } catch (error) {
      logger.error({ err: error }, "Failed to install agents");
      return c.json({ ok: false, error: "Failed to install agents." }, 500);
    }
  });

  app.post("/api/install/skills", async (c: any) => {
    try {
      const payload = await c.req.json() as { skills?: string[] };
      const skillNames = Array.isArray(payload.skills) ? payload.skills.filter((s): s is string => typeof s === "string") : [];
      if (skillNames.length === 0) {
        return c.json({ ok: false, error: "No skill names provided." }, 400);
      }
      const catalog = loadSkillCatalog();
      const result = installSkills(TARGET_ROOT, skillNames, catalog);
      return c.json({ ok: true, ...result });
    } catch (error) {
      logger.error({ err: error }, "Failed to install skills");
      return c.json({ ok: false, error: "Failed to install skills." }, 500);
    }
  });
}
