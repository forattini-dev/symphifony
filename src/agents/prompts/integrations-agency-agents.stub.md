---
agent:
  providers:
    - provider: claude
      role: planner
      profile: agency-senior-project-manager
    - provider: codex
      role: executor
      profile: agency-senior-developer
    - provider: claude
      role: reviewer
      profile: agency-code-reviewer
codex:
  command: "codex"
claude:
  command: "claude"
---

Use local agency agent profiles discovered from workspace or home directories.
Workspace: {{workspaceRoot}}
