import type { RuntimeState } from "../types.ts";
import type { RouteRegistrar } from "./http.ts";
import { logger } from "../concerns/logger.ts";
import { broadcastToWebSocketClients } from "./websocket.ts";
import { listVariables, upsertVariable, deleteVariable } from "../persistence/resources/variables.resource.ts";
import { upsertVariableInVaulter, deleteVariableFromVaulter } from "../persistence/vaulter.ts";

export function registerVariableRoutes(
  app: RouteRegistrar,
  state: RuntimeState,
): void {
  // GET /api/variables — list all (optional ?scope= filter)
  app.get("/api/variables", async (c) => {
    const result = await listVariables(c);
    return c.json(result.body, result.status ?? 200);
  });

  // PUT /api/variables/:id — upsert { key, value, scope }
  app.put("/api/variables/:id", async (c) => {
    const result = await upsertVariable(c, {
      upsertPersistedVariable: (entry) => upsertVariableInVaulter(entry),
    });
    if ((result.status ?? 200) < 400) {
      broadcastToWebSocketClients({ type: "variables", action: "upsert" });
    }
    return c.json(result.body, result.status ?? 200);
  });

  // DELETE /api/variables/:id — delete
  app.delete("/api/variables/:id", async (c) => {
    const id = c.req.param("id");
    const result = await deleteVariable(c, {
      deletePersistedVariable: (varId) => deleteVariableFromVaulter(varId),
    });
    if ((result.status ?? 200) < 400) {
      broadcastToWebSocketClients({ type: "variables", action: "delete", id });
    }
    return c.json(result.body, result.status ?? 200);
  });
}
