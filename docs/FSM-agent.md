# FSM Agent

## Responsabilidade

O FSM de agent em [src/persistence/plugins/fsm-agent.ts](/home/cyber/Work/FF/fifony/src/persistence/plugins/fsm-agent.ts) controla a política do harness.

Ele deve concentrar:

- dispatch eligibility por fase
- estado operacional do agente
- job files e watcher de processo
- semântica de `plan`, `execute`, `review`, `retry`, `re-review`
- política de `harnessMode`
- calibração adaptativa de `harnessMode` usando histórico de `contractNegotiationRuns` e `reviewRuns`
- calibração adaptativa de `checkpointPolicy` usando histórico de checkpoint review e final review
- contract negotiation planner↔reviewer antes da execução quando o plano é `contractual`
- seleção do perfil do evaluator por tipo de issue/risco
- roteamento explícito de provider por fase (`execute` vs `review`)
- persistência de `reviewRuns` com routing efetivo por ciclo (`provider/model/effort/overlays`)
- persistência de `reviewFailureHistory` por critério falhado
- persistência de `policyDecisions` quando o FSM muda o comportamento do harness
- semântica de sucesso, rework, block e cancel
- interpretação do `grading_report`
- distinção entre gate bloqueante e findings advisory no review
- budget de retries automáticos
- detecção de loops de review quando o mesmo critério bloqueante falha repetidamente
- quando rodar validation gate
- quando auto-approve é permitido
- quando checkpoint review é obrigatório antes do review final

## O que já está no FSM

- dispatch guard `canDispatchAgent`
- execução das fases `runPlanPhase`, `runExecutePhase`, `runReviewPhase`
- watcher de crash de processos via stale check (`ensureNotStale`) e `recoverOrphans` na boot
- derivação de operação semântica do agente
- requeue automático quando review falha
- budget de auto retries por review
- integração de `harnessMode`
  `solo`: review automatizado é pulado no `fsm-agent`
  `standard`: fluxo normal com reviewer quando disponível
  `contractual`: reviewer é obrigatório na prática e `grading_report` incompleto falha
- contract negotiation real
  durante `Planning`, planos `contractual` entram num loop planner↔reviewer antes de qualquer execução
  o reviewer pode aprovar ou pedir revisão do contrato; o planner refina o plano e o FSM persiste `contractNegotiationRuns`
  planos `contractual` reabertos em `Planning` com contrato ainda não aprovado voltam a ser despachados para esta negociação
- integração de `checkpointPolicy`
  `checkpointed`: o `fsm-agent` roda um checkpoint review real entre `execute` e `Reviewing`
  falha no checkpoint volta para `Queued` ou `Blocked` sem passar pelo review final
  `final_only`: mantém contract negotiation e review final, mas evita o gate intermediário quando checkpoint não mostra lift suficiente
- roteamento explícito por fase
  `execute` usa somente providers de execução
  `review` resolve um reviewer dedicado, separado do pipeline de execução
- especialização do evaluator
  perfis diferentes para UI, workflow/FSM, integração, API/contrato e segurança
  o perfil selecionado é persistido na issue, endurece a rubrica do review e aumenta effort/overlays do reviewer real
- histórico de routing do reviewer
  cada checkpoint/final review agora grava um `reviewRun` com profile, route, verdicts e status operacional
  isso é a base para calibrar lift por combinação real de provider/model/effort, em vez de inferir depois
- histórico estruturado de falhas de review
  cada ciclo de review também grava os critérios `FAIL` em `reviewFailureHistory`
  isso permite expor padrões recorrentes na UI, enriquecer o retry context e detectar loops de rework
- trilha de política do harness
  quando o FSM muda `harnessMode` ou troca rework por replan, ele registra a decisão em `policyDecisions`
  isso torna a política auditável na issue, em vez de ficar implícita só em events soltos
- adaptive harness policy orientada por histórico real
  a seleção de `harnessMode` passou a considerar não só gate pass e first-pass review, mas também o quanto o `contract negotiation`
  costuma encontrar concerns bloqueantes e forçar refinamentos para aquele profile de review
- adaptive checkpoint policy orientada por histórico real
  o `checkpointPolicy` deixou de ser sinónimo de `contractual`
  o FSM agora pode manter um plano `contractual` com `final_only` quando o contrato já puxa a qualidade para cima e o checkpoint não agrega lift
- policy enforcement do `grading_report`
  critérios bloqueantes em falta viram `FAIL`
  critérios advisory em falta viram `SKIP` estruturado
  `SKIP` bloqueante em modo `contractual` vira `FAIL`
  `blockingVerdict` passa a ser a semântica de gate usada pelo FSM
  `overallVerdict` pode falhar por findings advisory sem forçar rework automático
- auto-replan por loop de review
  se checkpoint/final review volta a falhar no mesmo critério bloqueante dentro do mesmo plano, o `fsm-agent` replana em vez de insistir no mesmo ciclo de rework

## O que não pertence aqui

Não devem viver aqui:

- parser textual de CLI output
- templates de prompts
- detalhes de adapters por provider
- builders/commands específicos de `claude`, `codex` e `gemini`
- lógica de UI
- persistence genérica da issue

## Onde ainda existem outras regras de negócio

- [src/agents/directive-parser.ts](/home/cyber/Work/FF/fifony/src/agents/directive-parser.ts)
  Parsing do contrato de saída dos CLIs.

- [src/agents/adapters/index.ts](/home/cyber/Work/FF/fifony/src/agents/adapters/index.ts)
  Compilação de payloads e prompts, incluindo review e contract negotiation.

- [src/agents/adapters/shared.ts](/home/cyber/Work/FF/fifony/src/agents/adapters/shared.ts)
  Estrutura do payload, rendering do plano e contrato de execução.

- [src/agents/contract-negotiation.ts](/home/cyber/Work/FF/fifony/src/agents/contract-negotiation.ts)
  Orquestração do loop de contract negotiation, parsing de `contract_decision`, persistência de runs e refinement feedback.

- [src/agents/agent-pipeline.ts](/home/cyber/Work/FF/fifony/src/agents/agent-pipeline.ts)
  Orquestração low-level de sessões/turnos e invocação de provider.

- [src/domains/validation.ts](/home/cyber/Work/FF/fifony/src/domains/validation.ts)
  Execução concreta do validation gate que o `fsm-agent` decide quando usar.
- [src/domains/agents.ts](/home/cyber/Work/FF/fifony/src/domains/agents.ts)
  Fachada de domínio para o `fsm-agent` (delegação/observabilidade de status). Ela é o ponto de entrada recomendado para
  rotas e bootstrap; o plugin permanece com as regras de máquina de estado.
- [src/agents/adapters](/home/cyber/Work/FF/fifony/src/agents/adapters)
  Cada provider CLI já tem wrapper próprio: `claude.ts`, `codex.ts`, `gemini.ts` implementam compilação de comando, parser de saída e integração de schema. O harness referencia apenas o contrato do adapter.

- [src/agents/command-executor.ts](/home/cyber/Work/FF/fifony/src/agents/command-executor.ts)
  Infraestrutura de execução do CLI: spawn via PTY daemon (detached, sobrevive a crashes),
  inline PTY (fallback) ou bare spawn (Docker). Reattach automático a daemon vivo na boot.
  `writeToDaemon()` injeta texto no PTY stdin para slash commands em tempo real.
  Ver [docs/PTY-daemon.md](/home/cyber/Work/FF/fifony/docs/PTY-daemon.md) para modelo completo.

- [src/agents/pid-manager.ts](/home/cyber/Work/FF/fifony/src/agents/pid-manager.ts)
  Tracking de PID do agente e do daemon PTY. `isAgentStillRunning()` verifica daemon antes
  do PID bare. `issueHasResumableSession()` retorna `true` apenas se o processo está vivo de facto.

## Contrato da fronteira (nova)

- `src/domains/agents.ts` é a fachada de domínio para operações de agente:
  - reconcile e watcher (`reconcileAgentStateTransitions`, `startManagedAgentWatcher`)
  - observabilidade de sessão (`getAgentStatus`, `agentLogPath`)
- `src/boot.ts` e `src/routes/state.ts` devem preferir essa fachada e não importar diretamente
  `src/persistence/plugins/fsm-agent.ts`.

## Regra aplicada neste ciclo

- O fluxo permanece com decisão de estratégia no FSM de agente (quando/como revisar, rework, bloquear, auto-approve), enquanto a execução de CLI continua em adapters dedicados por provider.
- Se for introduzir novo provider, use `src/agents/adapters/registry.ts` para registrar novo adapter em vez de espalhar flags de provider no FSM/commands.

## Regra prática

Uma regra deve ir para o FSM de agent quando responde a qualquer destas perguntas:

- O harness deve usar `solo`, `standard` ou `contractual` aqui?
- Esta execução deve seguir para review, rework, block ou approve?
- O output do evaluator é suficiente para prosseguir?
- O retry deve ser automático, manual ou impossível?

Se a resposta for sim, a regra provavelmente pertence aqui.
