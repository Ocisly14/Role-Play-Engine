# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (enforced via `only-allow`); Node >= 18.

```bash
pnpm install                # also runs prisma generate
pnpm chat                   # start API + WebSocket server (client/server.ts on PORT or API_URL)
pnpm chat:frontend          # Vite dev server for React app in client/
pnpm chat:dev               # both concurrently
pnpm dev:debug              # tsx with DEBUG=coc:*
pnpm build                  # swc build src -> dist
pnpm build:tsc              # type-check + emit via tsc
pnpm check                  # biome check --apply (lint + format + organize imports)
pnpm test                   # vitest
pnpm test -- path/to/file.test.ts             # run a single test file
pnpm test -- -t "name"                        # run by test name pattern
```

Prisma: **use `prisma db push`** rather than `migrate dev` — the `reminder_embeddings` schema has drift that makes `migrate dev` unsafe. Scenario rows have a compound unique key `(moduleId, scenarioId)`; query with `findFirst`, not `findUnique`.

Path alias `@/*` -> `src/*` is configured for vitest; respect that when adding tests.

## Architecture

This is a **tick-based tabletop horror RPG world simulation**, not a turn-based chat agent. The legacy single-player chat / turn polling / memo path has been removed; only the simulation surface is active.

### Runtime flow

```
SimulationRunner ──▶ tickProcessor (advances 1 in-world minute/tick)
                       │
                       ├─▶ NPCPlanningAgent  (LLM daily plans + replans)
                       ├─▶ roleSim (LLM persona simulation per NPC)
                       ├─▶ engine/handlers + engine/features (state mutations)
                       └─▶ SimulationEventEmitter ──▶ WebSocket broadcast
```

There is **no central scheduler**. The pipeline is `NPC AI → Translation → Queue → Engine`. Don't introduce a top-level scheduler that owns NPC actions.

### Source layout (`src/`)

- `engine/` — tick runtime: `core/`, `handlers/`, `features/`, `interpreter/`, `resolver/`, `tools/`, `scriptedEvents/`, `codeEngine/`, plus tool/`definitions`. Owns all world-state transitions.
- `planning/` — `NPCPlanningAgent`, prompt construction, `cocSkillList`, `sceneMapFormatter`, plan types. Daily plans + replanning.
- `roleSim/` — LLM persona-simulation layer (`llmAgent`, `npcActionController`, `perceptionRenderer`, `profileFormatter`, `sanityGuidance`, `seedIntents`, `systemPrompt`, `toolDispatcher`, `toolSkills/`, `userPromptBuilder`, `dailySummarization`).
- `simulation/` — `SimulationRunner`, `PlaybackScheduler`, `SimulationEventEmitter`, `runtimePersistence`, `characterInjection`. The driver layer between API and engine.
- `state/` — `DynamicGameState` + `DynamicGameStateLoader`, `moduleLoader`/`moduleImporter`, `gameClock`, `topologyTypes`, `blockedConnections`. Module loading is YAML-driven.
- `memory/` — 7-type NPC memory: `MemoryStore`, `MemoryRetriever`, `NpcMemoryManager`, `DecayEngine`, `mapMemory`, plus `handlers/`. Embeddings via FastEmbed (see `rag/localEmbeddingManager`).
- `rag/` — Discovery RAG only (turn-based QA RAG was removed).
- `models/` — LLM wrapper around LangChain `ChatAnthropic` / OpenAI / Google.
- `i18n/` — en/zh.

### Time

The codebase has migrated to **ISO 8601 `gameDateTime` strings** as the single time field (collapsed from prior `gameDay` + `tickTime`). New code must use `gameDateTime`; do not reintroduce split day/time fields. See `src/state/gameClock.ts`.

### Server (`client/server.ts` + `client/server/`)

Express + WebSocket. Route modules are mounted from `client/server/{auth,character,data,maps,mod,simulation,skills,analytics}/routes.ts`. `WebSocketManager` handles live simulation events. `DatabaseManager` wraps the Prisma client. Daily analytics scheduler is started/stopped from the entrypoint.

### Frontend (`client/src/`)

React + Vite + Tailwind. Used to manage and inspect simulations; no in-browser turn-based chat surface.

## Testing conventions

- Unit tests live in `__tests__/` directories beside source (e.g. `src/engine/__tests__`, `src/state/__tests__`, `src/memory/__tests__`, `src/planning/__tests__`, `src/roleSim/__tests__`). End-to-end-ish simulation tests live under top-level `__tests__/simulation/`.
- Skip TDD for trivial code (pure types, thin delegation). Keep tests for algorithmic logic.
- Prefer batching verification at the end of a multi-step plan rather than per-step smoke tests.

## Workflow notes

- Don't auto-commit. Let the user review changes first; when committing, batch all changes for a plan into one commit rather than per-step commits.
- Don't commit specs/docs ahead of the implementation they describe.
- Old `src/dynamicworldagent/` has been fully refactored into `engine/`, `planning/`, `memory/`, `state/`, `simulation/`, `i18n/`, `rag/` — don't recreate it.
