# Fifony MCP integration

Workspace root: `{{workspaceRoot}}`
Persistence root: `{{persistenceRoot}}`
State root: `{{stateRoot}}`

Recommended MCP client command:

```json
{
  "mcpServers": {
    "fifony": {
      "command": "npx",
      "args": ["fifony", "mcp", "--workspace", "{{workspaceRoot}}", "--persistence", "{{persistenceRoot}}"]
    }
  }
}
```

Expected workflow:

1. Read `fifony://guide/overview` and `fifony://state/summary`.
2. Use `fifony.list_issues` or read `fifony://issues`.
3. Create work with `fifony.create_issue`.
4. Update workflow state with `fifony.update_issue_state`.
5. Use the prompts exposed by this MCP server to structure planning or execution.

The MCP server is read-write against the same `s3db` filesystem store used by the Fifony runtime.
