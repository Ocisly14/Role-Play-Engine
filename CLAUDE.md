# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The package is **`role-play-engine`** ("LLM World Engine"); the checkout directory is still `CoC-AI-agent` for historical reasons. Call of Cthulhu IP references were scrubbed — don't reintroduce named-setting terminology. A few `CoC` mentions survive as leftovers (file-header comments in `src/models/*`, the `allowedHosts` entry in `vitest.config.ts`); treat them as vestigial, not as a naming convention.

**`src/planning/README.md` is stale.** It still describes the pre-refactor design (`ActionStep` with `engine: "llm" | "code"` routing, per-skill schemas, a "task processor"). None of that exists any more — see *The LLM seams* below for what actually runs. The root `README.md` was rewritten against the current code.

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

`pnpm chat` is the app. Every other script below spends real money on model calls — none of them stub the LLM.

```bash
pnpm test:agent-decisions   # scripts/test-agent-decisions.ts — the simulation harness
pnpm lint:agent-cases       # structural check of the case table; free, run it first
pnpm sim:full               # scripts/full-injection-run.ts — whole town, one session, resumable
pnpm smoke:module           # module loads clean, no model calls
pnpm prompt:budget          # per-block token accounting for the character prompt
```

`test-agent-decisions.ts` stages each case inside its **own real session** and runs the production pipeline for a few in-world minutes — no stubs, no grading, just an objective per-actor record. Useful flags: `--list`, `--only <case>`, `--module grayhaven` (compact table, loads from `testmods/` instead of `data/Mods/`), `--drop-sessions`, `--dump-prompts`. Cost scales with actor *slots*, not actor·ticks. `full-injection-run.ts` is the other half: every character present, measuring prompt blocks at full roster size; it resumes from the last completed tick and stops itself when the same error signature repeats.

Scripts that referenced the pre-refactor tree (`run-simulation.ts`, `probe-npc-decide.ts`, `test-role-agent.ts`, …) were deleted; don't resurrect them. Set `LLM_TRACE_DIR` (or pass `--dump-prompts`) to dump every model call, prompt and answer, to disk.

Prisma: **use `prisma db push`** rather than `migrate dev` — the `reminder_embeddings` schema has drift that makes `migrate dev` unsafe. Scenario rows have a compound unique key `(moduleId, scenarioId)`; query with `findFirst`, not `findUnique`.

Path alias `@/*` -> `src/*` is configured for vitest; respect that when adding tests.

### Environment

`.env.example` is the reference. `MODEL_PROVIDER` picks the vendor; each class is overridable per vendor — `{SMALL,MEDIUM,LARGE}_{ANTHROPIC,OPENAI,GOOGLE}_MODEL` plus `EMBEDDING_*` / `IMAGE_*`. Other knobs that matter when running the sim: `LLM_TRACE_DIR` (dump every prompt), `NPC_DECIDE_CONCURRENCY` (parallel NPC decisions per tick), `SKIP_EMBEDDING_WARMUP`, `PRISMA_LOG_QUERIES`, `PORT` / `API_URL`.

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
                        ├─ buildPerceivedBundle → renderer (MEDIUM model)
                        │     → first-person, citation-tagged narrative
                        ├─ RoleSimAgent.decide()  → act | continue | writeMemory
                        └─ trust boundary (commandValidator + commandBuilder)
                              → CommandInbox → next tick
```

There is **no central scheduler** and **no planning agent**. The pipeline is `perception → NPC agent → trust boundary → command inbox → engine`. Don't introduce a top-level scheduler that owns NPC actions, and don't reintroduce daily-plan generation.

### The LLM seams

**World Action Engine** (`engine/resolution/worldActionEngine.ts`) — one agentic session per triggered tick, over the full world context. Output is validated in code (`worldDeltaValidator.ts`), gets up to `MAX_CORRECTION_ROUNDS` (3) corrective rounds in which the model resubmits the complete resolution through the same `submit_resolution` tool (there is no patch tool), and a tick still invalid after that applies nothing. There are **no action types and no per-action prompts** — one rule document (`engine/rules/world-action-resolution.md`) governs everything, with `engine/rules/session-protocol.md` as the session contract.

The session's economics are part of its design: every turn re-sends the whole request, so **a turn costs about what the resolution costs**. Hence exactly **one** code tool — `damageRoll` (`engine/tools/diceTools.ts`, registered flat by name in `registerDefaults.ts`) — because a roll must never be the model's. Pathfinding, movement cost and inventory lookups were deliberately removed: the request already carries the graph, the places and the items, so the model reads rather than queries. The turn budget is a code constant *and* a prompt sentence (`FORCE_SUBMIT_AFTER` / `MAX_ITERATIONS` templated into the protocol); after the force point the tools are withdrawn and a submission is demanded. Every session must end with exactly one `submit_resolution` call, alone in its turn.

**RoleSimAgent** (`roleSim/llmAgent.ts`) — per-NPC persona loop. Tools: `act` and `continue` are terminal (consume the tick, return to the controller); `writeMemory` is an instant tool dispatched by `toolDispatcher.ts` and rides along in the same turn. There is no recall tool — see Memory below.

**Weather engine** (`engine/weather/weatherEngine.ts`) — one small session per region per weather change. The weather subsystem keeps the state machine and the numbers; on a change it raises an internal `weather.transition` signal, and the orchestrator (Phase 8b, after scripted events) asks this engine which passages the weather closes and what each outdoor place is like, from the places' own prose. The signal is consumed before the public event stream. Code diffs the answer against the last one (`judgedBlockIds`), attaches the skill penalties, and folds it into the same flush. Every weather change is judged, clear skies included — a clear sky closes nothing but still says what each outdoor place is like, and the storm's conditions are replaced rather than merely deleted. A failed judgement leaves passages and conditions as they were, except under a clear sky, where the empty judgement is applied anyway so the storm's closures cannot outlive it.

Connection blocks are one flag per edge with a reason. Three writers — the weather engine, scripted events and the World Action Engine — and the last write wins; any of them may clear what another set. There is no refcount. A character getting past an obstacle that stays uses the exact blocked edge's one-shot `movement.passBlockedConnectionId`, not a cleared block; it cannot accompany an unresolved check.

### Trust boundary

Agent output is **untrusted**. `engine/actions/commandValidator.ts` checks shape, enums, duration bounds, and that every `objectRef` names something real; `commandBuilder.ts` then wraps the result into a trusted `ActionCommand`. Rejections carry a structured reason the agent reads as feedback next decision. No semantic judgement happens at the boundary — feasibility, skill fit, and resistance are the Engine's job in full context.

`state/perceivableDirectory.ts` defines what an actor may point at. Unknown characters are addressed by a **per-tick alias** (`stranger_a`); the boundary swaps in the real id before the Engine sees the command, so canonical names never enter the actor's context. Known people, items, and scenes keep their real ids. Connections are **never citable**: a passage is topology bookkeeping — the v2 prose cites the PLACE a passage leads to (`[SCN_*]`), and a door that matters as an object (lockable, breakable) is authored as an item. A road item may carry a `position` (0-1 along the length); perception applies a 5-minute reach radius (`ROAD_ITEM_REACH_MINUTES`) around the walker, and boundary + renderer read the same resolver so the citable set and the rendered set never diverge.

The alias is derived from (viewer, target), so it is stable: the same stranger wears the same tag for the same actor for as long as they stay unknown. Every id space is therefore stable, and the boundary asks only one thing of a citation — **does it name something real**. Whether the thing is still within reach is the Engine's question, and it can answer it as something the actor perceives ("the display where the daisies were is empty") instead of a rejection the actor never sees.

Travel is stated, not computed by the model: the actor names `movement.route` (and `vehicleId` when driving), code derives the duration and overrides whatever the Engine wrote. A hop that doesn't exist fails back to the actor naming both places, which is how they learn to correct it.

### Perception / render layer

`roleSim/renderer/` turns a `PerceivedBundle` (scene, own conditions, own action posture, the tick's occurrences this character perceives) into **one first-person paragraph** via a MEDIUM-model call. Entities carry bracketed citation tags — `[stranger_a]`, `[ITEM_7]`, `[SCN_LIBRARY]` — and citing a tag is the only way a character can point at anything. A paragraph carrying a tag the actor could not cite is sent back once, quoting the exact string it invented; `stripUncitableTags` then drops whatever is still uncitable before the paragraph reaches the actor. On renderer failure the wrapper returns null; there is deliberately **no god-eye fallback**.

The perception stream is append-only and injected whole, so it has a ceiling: `roleSim/perceptionCompactor.ts` hands the character their own prompt back and asks *them* to condense the early part into the account they could still give, keeping the most recent paragraphs verbatim. The judgement belongs to the person whose day it was — same principle as `writeMemory` having no curator. `roleSim/promptBudget.ts` measures per-block spend (counting CJK and Latin separately, since this world runs in Chinese); it is measurement only and evicts nothing.

### Skills

The 57 CoC skills were consolidated into **17 broad ability domains** (`engine/rules/skillCatalog.ts`, one `.md` per domain in `engine/rules/skills/`, with YAML frontmatter). Specific approaches, tools, and weapon types are judged from the action description by the Engine, not tracked as separate stats. `engine/rules/skillReference.ts` renders the catalog into *both* prompts (roleSim system prompt and the Engine session). When deleting routing machinery, keep the skill knowledge — it lives in those files.

### Source layout (`src/`)

- `engine/` — tick runtime. `core/` (tickEngine/tickOrchestrator/applier/eventBus/scriptedEventRunner), `actions/` (ActionCommand intake, command validator/builder, EngineAction store, skill adjudication, movement runtime), `resolution/` (World Action Engine + context builder + WorldDelta schema/validator), `weather/` (the weather engine: request/validation/changes + the LLM call), `tools/` (the code-tool registry and `damageRoll`), `subsystem/` (weather, sun, stamina, item damage, condition expiry), `scriptedEvents/`, `rules/`, `shared/` (dice, pathfinding, impact propagation, topology helpers, JSON parsing). Owns all world-state transitions. No interpreter, no per-action definitions.
- `roleSim/` — LLM persona layer: `llmAgent`, `agent` (contracts), `npcActionController`, `renderer/`, `systemPrompt`, `userPromptBuilder`, `profileFormatter`, `memoryFormatter`, `perceptionCompactor`, `promptBudget`, `seedIntents`, `toolDispatcher`, `tools/` (`act`, `continue`, `writeMemory`, `schemas`).
- `simulation/` — `SimulationRunner`, `SimulationEventEmitter`, `runtimePersistence`, `characterInjection`. The driver layer between API and engine.
- `state/` — `DynamicGameState` + `DynamicGameStateLoader`, `moduleLoader`/`moduleImporter`/`moduleSchemaV2`, `gameClock`, `perceivableDirectory`, `perceivedLocation`, `connectionRegistry`, `blockedConnections`, `characterSpot`, `topologyTypes`.
- `memory/` — `MemoryStore`, `MemoryRetriever`, `NpcMemoryManager`, `DecayEngine`, plus per-type `handlers/`. Embeddings via FastEmbed (`rag/localEmbeddingManager`). Nothing geographic is generated at bootstrap — the old `contextMemory`/`knownLocations`/`knownMapSeed` layer is gone.
- `models/` — in-house LLM layer. `providers/` holds one adapter per vendor (`anthropic`, `openai`, `google`, `deepseek` — the first three over vendor SDKs, DeepSeek over `fetch` since it ships none); policy (retries, model-class fallback, usage accounting) lives in `generator.ts`, `tokenUsage.ts` tracks spend, `trace.ts` implements `LLM_TRACE_DIR`. Supports native tool calls and provider prompt-cache breakpoints (`SystemBlock.cacheControl`). **LangChain has been removed — don't reintroduce it.**
- `shared/agents/memory/database/` — Prisma client, module scoping, seed data.
- `planning/` — nearly gutted; only `sceneMapFormatter.ts` and a few types remain, still imported by the engine and server. The module is on its way out — don't add to it.
- `rag/` — `localEmbeddingManager` (used by memory) and a Discovery-RAG service under `session/` that is currently unwired.
- `i18n/` — en/zh.

`godot-client/` (top level) is a separate GDScript client that consumes the WebSocket event stream.

### Modules (world data)

Modules are **JSON**, not YAML, and load through `state/moduleLoader.ts` + `state/moduleSchemaV2.ts`. The authoring contract is `testmods/DYNAMIC_WORLD_SCENE_SCHEMA.md` — everything in it is enforced at LOAD time, and a violation throws a single aggregated `ModuleSchemaError` rather than failing silently later.

```
<module>/
  module_setup.json            optional: startDate + introduction + weather presets
  npc_injection_policy.json    optional: which NPCs simulate, by tier
  <scenes-dir>/                SCN_*.json (scenes), ROAD_*.json, VEH_*.json (vehicles)
  scripted-events/*.json       optional: event definitions (arrays)
```

Schema **v2 is prose-first**: `description` is the complete scene text a character perceives, every visible object / passage / condition is cited inline as `[reference-id]`, and the matching machine-readable rows live in the same file under `references`. v1 files (no `schemaVersion: 2`) are rejected outright. Retired and rejected by the loader: `scenarios_outline.json` and the `LOC_*` macro-location layer, `JUNC_*` files (a crossroads is a top-level scene), `truth_timeline.json`, `knowledge_matrix.json`, `macro_scene.json`, `module_digest.json`.

`testmods/grayhaven/` is the live reference module (71 place files, ~10 NPCs — `grayhaven_npc/*.json` profiles alongside `characters/*.md` prose). Runtime modules live in `data/Mods/`.

### Memory

Six memory types (`NpcMemoryType` in `prisma/schema.prisma`), all **character-authored** — `general`, `plan`, `secret`, `relationship`, `map`, `long_term_intent`. A module seeds them through each NPC profile's `memory` array (geographic knowledge included, as `map` memories in the character's own voice); in play `writeMemory` writes the same types. **Nothing is generated on the character's behalf** — no bootstrap gazetteer (the `context` type and `knownMapSeed` are gone), no end-of-day diary. What a character knows about the map is exactly what their profile says plus what they wrote down; a place absent from both does not exist for them, which is the whole loss-in-the-woods mechanic. Macro-location containers are likewise gone: `parentLocationId` survives only as the interior-scene marker (any non-empty value) and a viewer-side grouping label, placement uses scene ids directly (`currentLocation`/`residence` on the profile), and the topology attaches deep interiors transitively by itself.

There is **no recall tool**: memories are injected whole into the user prompt, so a memory absent from the prompt does not exist for that character. Decay lives in `DecayEngine`.

A character's view of another is a `relationship` memory they write themselves, and writing one is also what updates `npcRelationshipGraph` — one author, two indexes. Knowing WHO someone is is a separate fact: the graph node's `knownAs` (what this viewer calls them), set by the character when a name is said in their hearing, and the only thing `isKnownTo` reads. Having an opinion about a face is not an introduction — conflating the two used to hand every character the canonical name of anyone they had merely noticed. The Engine has **no** relationship operation: it reports what happened, and what anyone makes of it is theirs to record. (It had one; told to note that a shopkeeper had grown wary of a customer, the applier wrote the same score and the same note onto the customer's row too, inventing his opinion of her out of hers of him.)

`writeMemory` carries an `op` — `add` (default), `replace`, `delete`. `replace`/`delete` address a memory by the tag `memoryFormatter.ts` renders at the head of each line (`M3f9a2c`, derived from the row id so it never repoints). The tag resolves only against the memories that were in THAT decision's prompt, and the store call scopes on `(id, sessionId, npcId)` — the same "you may only point at what you were shown" rule the `act` boundary applies to objectRefs. The character's own long-term goal is a `long_term_intent` memory in the same block, not a prompt section of its own.

### Time

The codebase uses **ISO 8601 `gameDateTime` strings** as the single time field (collapsed from prior `gameDay` + `tickTime`). New code must use `gameDateTime`; do not reintroduce split day/time fields. See `src/state/gameClock.ts`.

### Server (`client/server.ts` + `client/server/`)

Express + WebSocket. Mounted route modules are `maps`, `auth`, `simulation/mapRoutes` (public viewer reads), `analytics`, `data`, `simulation` — **in that order**; the public/unauthenticated routers must stay ahead of the authenticated ones, and the SPA fallback after all of them. The `character/`, `mod/` and `skills/` directories are now empty leftovers — character creation, the mod manager and skill lookup were deleted from both server and frontend; don't wire them back. `WebSocketManager` handles live simulation events, `DatabaseManager` wraps the Prisma client, and the daily analytics scheduler is started/stopped from the entrypoint.

### Frontend (`client/src/`)

React + Vite + Tailwind. Used to manage and inspect simulations; no in-browser turn-based chat surface, no character sheet, no mod editor.

## Testing conventions

- Unit tests live in `__tests__/` directories beside source (`src/engine/**/__tests__`, `src/state/__tests__`, `src/memory/__tests__`, `src/models/__tests__`, `src/roleSim/__tests__`, `src/roleSim/renderer/__tests__`, `src/simulation/__tests__`). Engine integration helpers are in `src/engine/__tests__/integration/makeIntegrationEngine.ts`. There is no top-level `__tests__/` directory.
- Skip TDD for trivial code (pure types, thin delegation). Keep tests for algorithmic logic.
- Prefer batching verification at the end of a multi-step plan rather than per-step smoke tests.

## Workflow notes

- Don't auto-commit. Let the user review changes first; when committing, batch all changes for a plan into one commit rather than per-step commits.
- Don't commit specs/docs ahead of the implementation they describe.
- Old `src/dynamicworldagent/` has been fully refactored into `engine/`, `planning/`, `memory/`, `state/`, `simulation/`, `i18n/`, `rag/` — don't recreate it.
