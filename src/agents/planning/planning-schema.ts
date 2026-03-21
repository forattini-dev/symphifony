// ── Plan JSON schema definitions ─────────────────────────────────────────────

// Reusable step schema (used in both steps[] and phases[].tasks[])
export const STEP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["step", "action", "files", "details", "doneWhen"],
  properties: {
    step: { type: "number" },
    action: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    details: { type: "string" },
    doneWhen: { type: "string" },
  },
};

export const PLAN_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["summary", "steps", "estimatedComplexity", "suggestedPaths", "suggestedEffort"],
  properties: {
    summary: { type: "string" },
    estimatedComplexity: { type: "string", enum: ["trivial", "low", "medium", "high"] },
    assumptions: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "object", additionalProperties: false, properties: { question: { type: "string" }, whyItMatters: { type: "string" }, howToResolve: { type: "string" } }, required: ["question", "whyItMatters", "howToResolve"] } },
    successCriteria: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: STEP_SCHEMA },
    phases: { type: "array", items: { type: "object", additionalProperties: false, required: ["phaseName", "goal", "tasks"], properties: {
      phaseName: { type: "string" },
      goal: { type: "string" },
      tasks: { type: "array", items: STEP_SCHEMA },
      dependencies: { type: "array", items: { type: "string" } },
      outputs: { type: "array", items: { type: "string" } },
    } } },
    risks: { type: "array", items: { type: "object", additionalProperties: false, required: ["risk", "impact", "mitigation"], properties: { risk: { type: "string" }, impact: { type: "string" }, mitigation: { type: "string" } } } },
    validation: { type: "array", items: { type: "string" } },
    deliverables: { type: "array", items: { type: "string" } },
    suggestedPaths: { type: "array", items: { type: "string" } },
    suggestedSkills: { type: "array", items: { type: "string" } },
    suggestedAgents: { type: "array", items: { type: "string" } },
    suggestedEffort: { type: "object", additionalProperties: false, required: ["default"], properties: { default: { type: "string" }, planner: { type: "string" }, executor: { type: "string" }, reviewer: { type: "string" } } },
  },
});

/** Parsed schema object for OpenAI API json_schema response_format. */
export const PLAN_SCHEMA_OBJECT = JSON.parse(PLAN_JSON_SCHEMA) as Record<string, unknown>;
