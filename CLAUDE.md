# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The package is **`role-play-engine`** ("LLM World Engine"); the checkout directory is still `CoC-AI-agent` for historical reasons. Call of Cthulhu IP references were scrubbed — don't reintroduce named-setting terminology. A few `coc*` identifiers survive as leftovers (`src/planning/cocSkillList.ts`, `DEBUG=coc:*`); treat them as vestigial, not as a naming convention.

## Commands

Package manager is **pnpm** (enforced via `only-allow`); Node >= 18.

```bash
pnpm install                # also runs prisma generate
pnpm chat                   # start API + WebSocket server (client/server.ts on PORT or API_URL)
pnpm chat:frontend          # Vite dev server for React app in client/
pnpm chat:dev               # both concurrently
pnpm build                  # swc build src -> dist
pnpm build:tsc              # type-check + emit via tsc
pnpm check                  # biome check --apply (lint + format + organize imports)
pnpm test                   # vitest
pnpm test -- path/to/file.test.ts             # run a single test file
pnpm test -- -t "name"                        # run by test name pattern
```

`pnpm chat` is the app. The simulation harness is `scripts/test-agent-decisions.ts` (`pnpm test:agent-decisions`): each case stages a scene inside its **own real session** and runs the production pipeline for a few in-world minutes — no stubs. `pnpm lint:agent-cases` structurally checks the case table for free. Scripts that referenced the pre-refactor tree (`run-simulation.ts`, `probe-npc-decide.ts`, `test-role-agent.ts`, …) were deleted; don't resurrect them. Set `LLM_TRACE_DIR` (or pass `--dump-prompts`) to dump every model call, prompt and answer, to disk.

Prisma: **use `prisma db push`** rather than `migrate dev` — the `reminder_embeddings` schema has drift that makes `migrate dev` unsafe. Scenario rows have a compound unique key `(moduleId, scenarioId)`; query with `findFirst`, not `findUnique`.

Path alias `@/*` -> `src/*` is configured for vitest; respect that when adding tests.

## Architecture

This is a **tick-based LLM world simulation**, not a turn-based chat agent. One tick = one in-world minute. The legacy single-player chat / turn polling / memo path has been removed; only the simulation surface is active.

Two engines share the world: a **code engine** (deterministic — movement, time, weather, stamina, dice) and an **LLM engine** (open-ended outcomes, emitted as typed `WorldDelta`s). Every NPC is an LLM agent that perceives a rendered narrative, not the structured state.

### Runtime flow

```
SimulationRunner
   └─▶ TickEngine / tickOrchestrator (advances 1 in-world minute per tick)
          1. clock  2. movement runtimes  3. drain + validate command inbox
          4. collect resolution triggers
          5-7. ONE World Action Engine session (skipped when no triggers → 0 model calls)
          8. anchor subsystems + scripted events
          11. single Applier flush (StateChanges + WorldDeltas)
          12. commit action lifecycle, emit TickReport
                 │
                 ├─▶ SimulationEventEmitter ──▶ WebSocket broadcast
                 └─▶ NpcActionController
                        ├─ buildPerceivedBundle → renderer (SMALL model)
                        │     → first-person, citation-tagged narrative
                        ├─ RoleSimAgent.decide()  → act | continue | writeMemory
                        └─ trust boundary (commandValidator + commandBuilder)
                              → CommandInbox → next tick
```

There is **no central scheduler** and **no planning agent**. The pipeline is `perception → NPC agent → trust boundary → command inbox → engine`. Don't introduce a top-level scheduler that owns NPC actions, and don't reintroduce daily-plan generation.

### The two LLM seams

**World Action Engine** (`engine/resolution/worldActionEngine.ts`) — one agentic session per triggered tick, over the full world context. It may consult the deterministic code tools (`engine/tools/`: pathfinding, movement cost, inventory validation, dice) and must finish with a terminal `submit_resolution` call. Output is validated in code (`worldDeltaValidator.ts`), gets up to `MAX_REPAIR_ROUNDS` corrective rounds, and anything still invalid is dropped with its action failed. There are **no action types and no per-action prompts** — one rule document (`engine/rules/world-action-resolution.md`) governs everything.

**RoleSimAgent** (`roleSim/llmAgent.ts`) — per-NPC persona loop. Tools: `act` and `continue` are terminal (consume the tick, return to the controller); `writeMemory` is an instant tool dispatched by `toolDispatcher.ts` and rides along in the same turn. There is no recall tool — see Memory below.

### Trust boundary

Agent output is **untrusted**. `engine/actions/commandValidator.ts` checks shape, enums, duration bounds, and that every `objectRef` names something real; `commandBuilder.ts` then wraps the result into a trusted `ActionCommand`. Rejections carry a structured reason the agent reads as feedback next decision. No semantic judgement happens at the boundary — feasibility, skill fit, and resistance are the Engine's job in full context.

`state/perceivableDirectory.ts` defines what an actor may point at. Unknown characters are addressed by a **per-tick alias** (`stranger_a`); the boundary swaps in the real id before the Engine sees the command, so canonical names never enter the actor's context. Known people, items, and scenes keep their real ids.

The alias is derived from (viewer, target), so it is stable: the same stranger wears the same tag for the same actor for as long as they stay unknown. Every id space is therefore stable, and the boundary asks only one thing of a citation — **does it name something real**. Whether the thing is still within reach is the Engine's question, and it can answer it as something the actor perceives ("the display where the daisies were is empty") instead of a rejection the actor never sees.

### Perception / render layer

`roleSim/renderer/` turns a `PerceivedBundle` (scene, own conditions, own action posture, the tick's occurrences this character perceives) into **one first-person paragraph** via a SMALL-model call. Entities carry bracketed citation tags — `[stranger_a]`, `[ITEM_7]` — and citing a tag is the only way a character can point at anything. `stripUncitableTags` drops tags the renderer invented before the paragraph reaches the actor. On renderer failure the wrapper returns null; there is deliberately **no god-eye fallback**.

### Skills

The 57 CoC skills were consolidated into **17 broad ability domains** (`engine/rules/skillCatalog.ts`, one `.md` per domain in `engine/rules/skills/`). Specific approaches, tools, and weapon types are judged from the action description by the Engine, not tracked as separate stats. `engine/rules/skillReference.ts` renders the catalog into *both* prompts (roleSim system prompt and the Engine session). When deleting routing machinery, keep the skill knowledge — it lives in those files.

### Source layout (`src/`)

- `engine/` — tick runtime. `core/` (tickEngine/tickOrchestrator/applier/eventBus/scriptedEventRunner), `actions/` (ActionCommand intake, command validator/builder, EngineAction store, skill adjudication, movement runtime), `resolution/` (World Action Engine + context builder + WorldDelta schema/validator), `tools/` (deterministic code tools), `subsystem/` (fire, weather, sun, stamina, movement, item damage, condition expiry), `scriptedEvents/`, `rules/`, `shared/` (dice, pathfinding, impact propagation, topology helpers, JSON parsing). Owns all world-state transitions. No interpreter, no per-action definitions.
- `roleSim/` — LLM persona layer: `llmAgent`, `agent` (contracts), `npcActionController`, `renderer/`, `systemPrompt`, `userPromptBuilder`, `profileFormatter`, `memoryFormatter`, `sanityGuidance`, `seedIntents`, `toolDispatcher`, `tools/` (`act`, `continue`, `writeMemory`, `schemas`).
- `simulation/` — `SimulationRunner`, `PlaybackScheduler`, `SimulationEventEmitter`, `runtimePersistence`, `characterInjection`. The driver layer between API and engine.
- `state/` — `DynamicGameState` + `DynamicGameStateLoader`, `moduleLoader`/`moduleImporter`, `gameClock`, `perceivableDirectory`, `perceivedLocation`, `topologyTypes`, `blockedConnections`. Module loading is YAML-driven.
- `memory/` — `MemoryStore`, `MemoryRetriever`, `NpcMemoryManager`, `DecayEngine`, `contextMemory`, `knownLocations`, plus per-type `handlers/`. Embeddings via FastEmbed (`rag/localEmbeddingManager`).
- `models/` — in-house LLM layer. `providers/` holds one thin adapter per vendor (`anthropic`, `openai`, `google`); policy (retries, model-class fallback, usage accounting) lives in `generator.ts`, and `tokenUsage.ts` tracks spend. Supports native tool calls and provider prompt-cache breakpoints (`SystemBlock.cacheControl`). **LangChain has been removed — don't reintroduce it.**
- `shared/agents/memory/database/` — Prisma client, module scoping, seed data.
- `planning/` — nearly gutted; only `cocSkillList.ts` (base values), `sceneMapFormatter.ts`, and a few types remain, still imported by the engine and server. Its README is stale. The module is on its way out — don't add to it.
- `rag/` — `localEmbeddingManager` (used by memory) and a Discovery-RAG service under `session/` that is currently unwired.
- `i18n/` — en/zh.

`godot-client/` (top level) is a separate GDScript client that consumes the WebSocket event stream.

### Memory

Seven memory types (`NpcMemoryType` in `prisma/schema.prisma`). Six are **character-authored** via `writeMemory` — `general`, `plan`, `secret`, `relationship`, `map`, `long_term_intent`. One is **system-authored**: `context` (the world as the character already knows it at session start: one per macro location, one per interior scene, one for topology). Nothing else is recorded on the character's behalf — there is no end-of-day diary, so what remains of a day is only what the character chose to write.

There is **no recall tool**: memories are injected whole into the user prompt, so a memory absent from the prompt does not exist for that character. Decay lives in `DecayEngine`.

A character's view of another is a `relationship` memory they write themselves, and writing one is also what updates `npcRelationshipGraph` — one author, two indexes. Knowing WHO someone is is a separate fact: the graph node's `knownAs` (what this viewer calls them), set by the character when a name is said in their hearing, and the only thing `isKnownTo` reads. Having an opinion about a face is not an introduction — conflating the two used to hand every character the canonical name of anyone they had merely noticed. The Engine has **no** relationship operation: it reports what happened, and what anyone makes of it is theirs to record. (It had one; told to note that a shopkeeper had grown wary of a customer, the applier wrote the same score and the same note onto the customer's row too, inventing his opinion of her out of hers of him.)

`writeMemory` carries an `op` — `add` (default), `replace`, `delete`. `replace`/`delete` address a memory by the tag `memoryFormatter.ts` renders at the head of each line (`M3f9a2c`, derived from the row id so it never repoints). The tag resolves only against the memories that were in THAT decision's prompt, and the store call scopes on `(id, sessionId, npcId)` — the same "you may only point at what you were shown" rule the `act` boundary applies to objectRefs. System-authored types stay unwritable through all three ops. The character's own long-term goal is a `long_term_intent` memory in the same block, not a prompt section of its own.

### Time

The codebase uses **ISO 8601 `gameDateTime` strings** as the single time field (collapsed from prior `gameDay` + `tickTime`). New code must use `gameDateTime`; do not reintroduce split day/time fields. See `src/state/gameClock.ts`.

### Server (`client/server.ts` + `client/server/`)

Express + WebSocket. Route modules are mounted from `client/server/{auth,character,data,maps,mod,simulation,skills,analytics}/routes.ts`. `WebSocketManager` handles live simulation events. `DatabaseManager` wraps the Prisma client. Daily analytics scheduler is started/stopped from the entrypoint.

### Frontend (`client/src/`)

React + Vite + Tailwind. Used to manage and inspect simulations; no in-browser turn-based chat surface.

## Testing conventions

- Unit tests live in `__tests__/` directories beside source (`src/engine/**/__tests__`, `src/state/__tests__`, `src/memory/__tests__`, `src/models/__tests__`, `src/roleSim/__tests__`, `src/roleSim/renderer/__tests__`). Engine integration helpers are in `src/engine/__tests__/integration/`. The top-level `__tests__/simulation/` directory is currently empty.
- Skip TDD for trivial code (pure types, thin delegation). Keep tests for algorithmic logic.
- Prefer batching verification at the end of a multi-step plan rather than per-step smoke tests.

## Workflow notes

- Don't auto-commit. Let the user review changes first; when committing, batch all changes for a plan into one commit rather than per-step commits.
- Don't commit specs/docs ahead of the implementation they describe.
- Old `src/dynamicworldagent/` has been fully refactored into `engine/`, `planning/`, `memory/`, `state/`, `simulation/`, `i18n/`, `rag/` — don't recreate it.
