# PTY Daemon — Execução e Recovery de Agentes

## Modelo de execução

O CLI do agente (claude/codex/gemini) roda num pseudo-terminal real via `node-pty`,
gerenciado por um processo daemon independente.

```
fifony (pai)
  └── pty-daemon.ts (detached + unref — sobrevive ao crash do pai)
        ├── mantém o PTY master aberto
        ├── spawna o CLI como slave do PTY (isatty = true)
        ├── escreve output em live-output.log
        ├── grava daemon.pid + agent.pid
        └── expõe Unix socket: .fifony/workspaces/{id}/agent.sock
              protocolo NDJSON:
                S→C: { t: "d", v: string }     — chunk de output
                S→C: { t: "x", c: number }     — exit com código
                S→C: { t: "tail", v: string }  — resposta a pedido de tail
                C→S: { t: "cancel" }           — sinalizar cancelamento
                C→S: { t: "tail" }             — pedir tail do log
                C→S: { t: "write", v: string } — injetar texto no PTY stdin
```

**Por que daemon separado?** Quando o PTY master fecha, o kernel envia SIGHUP ao processo
slave (morte imediata do CLI). Com `detached + unref`, o daemon sobrevive ao crash do
fifony e mantém o PTY master aberto, preservando a sessão do agente.

## Arquivos críticos

| Arquivo | Papel |
|---------|-------|
| `src/agents/pty-daemon.ts` | Processo daemon — cria PTY, spawna CLI, serve socket |
| `src/agents/command-executor.ts` | `runCommandWithTimeout()` — spawn/reattach do daemon; `writeToDaemon()` |
| `src/agents/pid-manager.ts` | `readDaemonPid`, `isDaemonAlive`, `isDaemonSocketReady`, `isAgentStillRunning` |
| `src/persistence/plugins/queue-workers.ts` | `recoverOrphans()` — detecção e reattach na boot |

## Três caminhos de execução (em ordem de preferência)

1. **Daemon PTY** (padrão, não-Docker): spawna `pty-daemon.ts` detached, aguarda `agent.sock`, chama `attachToDaemon()`
2. **Inline PTY** (fallback, sem daemon): `nodePty.spawn()` direto — tem TTY real mas não sobrevive a crashes
3. **Bare spawn** (Docker ou sem node-pty): `spawn(..., { stdio: "pipe" })` — output bufferizado, sem TTY

## Reattach a daemon vivo

Quando `runCommandWithTimeout` é chamado e já existe um `agent.sock` com daemon vivo
(e.g. fifony reiniciou no meio de uma execução), o path é:

```
existsSync(agent.sock) + isDaemonAlive() → attachToDaemon() direto
```

O socket existente **não é removido**. Nenhum daemon novo é spawnado.
O output do `live-output.log` acumulado até o momento é preservado.

## Recovery na boot

`recoverOrphans()` em `queue-workers.ts` roda na boot e classifica cada issue Running/Queued:

| Situação detectada | Ação |
|--------------------|------|
| `isDaemonAlive` + `isDaemonSocketReady` | Marca Running, re-enfileira como execute → reattach |
| Daemon morto, `isAgentStillRunning` (PID vivo) | Mantém Running, re-enfileira como execute |
| Processo morto | `lastError = "crashed"`, transiciona para Queued (auto-retry) |

## Stale check (30s interval)

`ensureNotStale()` em `scheduler.ts` roda a cada 30s enquanto fifony está ativo:

- `issueHasResumableSession(issue)` — retorna `true` apenas se daemon ou processo bare
  estiver **realmente vivo** (evita bypass do stale check para processos mortos)
- PID morto detectado em issue Running → auto-recupera para Queued silenciosamente
- Sem updates por N minutos em Running/Reviewing → transiciona para Blocked

## Canal de escrita (slash commands)

`writeToDaemon(workspacePath, text)` envia `{ t: "write", v: text }` via socket.
O daemon escreve no PTY stdin — o CLI recebe como se o usuário tivesse digitado.

Rota HTTP: `POST /api/issues/:id/agent/write` — valida estado Running + socket pronto.

Exemplos de comandos: `/usage`, `/status`, `/stats session`, `/insights`, `/simplify`.

## Artifacts em `.fifony/workspaces/{id}/`

| Arquivo | Criado por | Conteúdo |
|---------|-----------|---------|
| `agent.pid` | daemon | PID do CLI do agente |
| `daemon.pid` | daemon | PID do daemon PTY |
| `agent.sock` | daemon | Unix socket NDJSON |
| `live-output.log` | daemon | Output acumulado do agente |
| `daemon.exit.json` | daemon (na saída limpa) | `{ exitCode, success, duration }` |
