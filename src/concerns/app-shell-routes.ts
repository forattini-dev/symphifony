export const APP_SHELL_ROUTES = [
  "/onboarding",
  "/kanban",
  "/services",
  "/milestones",
  "/issues",
  "/analytics",
  "/agents",
  "/settings",
  "/settings/project",
  "/settings/system",
  "/settings/agents",
  "/settings/notifications",
  "/settings/execution",
  "/settings/quality",
  "/settings/pipeline",
  "/settings/services",
  "/settings/appearance",
  "/settings/providers",
  "/chat",
] as const;

export type AppShellRoute = (typeof APP_SHELL_ROUTES)[number];
