# LLM World Engine

`role-play-engine` is a tick-based world simulation in TypeScript. Every
non-player character is an LLM agent with its own memory, perception and
goals; the world itself is advanced by a deterministic code engine and an
LLM engine that resolves open-ended actions into typed state changes.

One tick is one in-world minute. There is no turn-based chat loop, no
central scheduler and no planning agent: each character perceives a
rendered narrative, decides for itself, and its decision is validated and
queued for the next tick.

The checkout directory is still named `CoC-AI-agent` for historical
reasons; the package and the code carry no named-setting terminology.

## Contents

- [How it works](#how-it-works)
- [Runtime flow](#runtime-flow)
- [The two LLM seams](#the-two-llm-seams)
- [Trust boundary and citations](#trust-boundary-and-citations)
- [Perception and rendering](#perception-and-rendering)
- [Memory](#memory)
- [Skills](#skills)
- [Modules (world data)](#modules-world-data)
- [Getting started](#getting-started)
- [Simulation API](#simulation-api)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [Repository layout](#repository-layout)
- [Testing](#testing)
- [Further reading](#further-reading)
- [License](#license)

## How it works

Two engines share one world state:

- **Code engine** — deterministic transitions: movement along the place
  graph, the clock, weather, sunlight, stamina, fire, item damage,
  condition expiry, dice.
- **LLM engine** — open-ended outcomes. A single model session reads the
  full world context, resolves every action that triggered this tick, and
  emits typed `WorldDelta`s that the code validates and applies.

Characters never see structured state. Each tick, what a character can
perceive is rendered into one first-person paragraph, and the character's
agent answers with a single tool call. The pipeline for every NPC is:

```
perception → NPC agent → trust boundary → command inbox → engine
```

Seen as a loop, each character's tick closes on itself:

```
        ┌─────────────────┐   act / continue    ┌─────────────────┐
        │  Character acts │ ───────────────────▶│  Trust boundary │
        │  (RoleSimAgent) │   intent only       │  validate + wrap│
        └─────────────────┘                     └────────┬────────┘
                 ▲                                       │ ActionCommand
                 │ first-person paragraph                │ (command inbox)
                 │ next tick                             ▼
        ┌────────┴────────┐                     ┌─────────────────┐
        │  Render scene   │ ◀──── TickReport ───│  Engine resolves│
        │  (renderer)     │   what this         │  code + LLM,    │
        │  [citation tags]│   character sees    │  applies deltas │
        └─────────────────┘                     └─────────────────┘
```

The character declares intent; the boundary checks that the intent points
at real things; the engine decides what actually happens and changes the
world; the renderer turns the part of that the character can perceive into
prose; the character reads it and decides again. No step sees more than it
should: the character never reads state, and the engine never reads the
character's private reasoning.

Nothing above the characters owns their actions. The engine reports what
happened; what a character makes of it is theirs to record.

## Runtime flow

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

`SimulationRunner` (`src/simulation/`) drives the tick engine, persists
runtime state, and broadcasts each `TickReport` over WebSocket. The tick
engine (`src/engine/core/`) owns every world-state transition and flushes
them through one `Applier` per tick.

## The two LLM seams

### World Action Engine

`src/engine/resolution/worldActionEngine.ts` runs one agentic session per
tick that has resolution triggers, over the full world context built by
the context builder. A tick with no triggers makes no model calls.

- **No action types, no per-action prompts.** One rule document,
  `src/engine/rules/world-action-resolution.md`, governs every action;
  `src/engine/rules/session-protocol.md` is the session contract.
- **Validated output.** The session ends with exactly one
  `submit_resolution` call. Its payload is checked in code by
  `worldDeltaValidator.ts`; invalid parts get up to `MAX_REPAIR_ROUNDS` (3)
  corrective rounds through `repair_resolution`, and whatever is still
  invalid is dropped with the originating action marked failed.
- **One code tool.** `damageRoll` (`src/engine/tools/diceTools.ts`) is the
  only tool the session can call, because a roll must never be the
  model's. The request already carries the place graph, the places and the
  items, so pathfinding, movement cost and inventory lookups are read from
  the context rather than queried.
- **Bounded turns.** Every turn re-sends the whole request, so a turn
  costs about what the resolution costs. `MAX_ITERATIONS` caps the
  session; after the force point the tools are withdrawn and a submission
  is demanded.
- **Sanity is judgement, not a tool.** `src/engine/rules/sanity-check.md`
  tells the session when a check is warranted (rarely) and it is reported
  as part of the resolution.

### RoleSimAgent

`src/roleSim/llmAgent.ts` is the per-character persona loop. It receives
the system prompt (profile, skill reference, tool guidance), the
character's memories and the perception stream, and answers with one of
three tools:

| Tool | Kind | Effect |
|---|---|---|
| `act` | terminal | Declares the one thing the character sets out to do. Consumes the tick. |
| `continue` | terminal | Keeps the in-flight action running. Consumes the tick. |
| `writeMemory` | instant | Records a memory; dispatched by `toolDispatcher.ts` in the same turn. |

`act` carries intent only, never outcome: a one- or two-sentence
`description`, `objectRefs` (`{id, role}` with `role` in
`target | tool | destination | recipient`), `proposedDurationTicks`, an
optional `skillId` from the catalog, `language` (for the Languages skill)
and an optional verbatim `utterance`. The engine decides what happens and
how long it takes. There is no recall tool; see [Memory](#memory).

## Trust boundary and citations

Agent output is untrusted. `src/engine/actions/commandValidator.ts` checks
shape, enums, duration bounds, and that every `objectRef` names something
real; `commandBuilder.ts` then wraps the result in a trusted
`ActionCommand` whose envelope (`commandId`, `actorId`, `issuedAt`,
`issuedSceneId`) the model can never write. Rejections carry one of six
structured codes (`invalid_description`, `invalid_object_refs`,
`unknown_ref`, `invalid_duration`, `invalid_skill`, `invalid_utterance`)
that the character reads as feedback on its next decision.

The boundary makes no semantic judgement. Reachability, feasibility, skill
fit and resistance are decided by the World Action Engine in full context,
where a stale reference can be answered as something the character
perceives instead of a rejection it never sees.

**What a character may point at** is defined by
`src/state/perceivableDirectory.ts`:

- Known people, items and scenes keep their real ids.
- Unknown people appear under a per-viewer alias such as `stranger_a`. The
  alias is derived from (viewer, target), so it is stable for as long as
  the person stays unknown; the boundary swaps in the real id before the
  engine sees the command.
- Connections are never citable. A passage is topology bookkeeping; prose
  cites the place it leads to, and a door that matters as an object is
  authored as an item.
- Road items may carry a `position` along the road; perception applies a
  reach radius (`ROAD_ITEM_REACH_MINUTES`, in `src/state/perceivedLocation.ts`)
  around the walker, and the boundary and the renderer share the resolver
  so the citable set and the rendered set never diverge.

Travel is stated, not computed by the model. The actor names
`movement.route` (and `vehicleId` when driving); code derives the duration.
A hop that does not exist fails back to the actor naming both places.

## Perception and rendering

`src/roleSim/renderer/` turns a `PerceivedBundle` (scene, own conditions,
own action posture, the occurrences this character perceives this tick)
into one first-person paragraph with a MEDIUM-class model call. Entities
carry bracketed citation tags (`[stranger_a]`, `[ITEM_7]`,
`[SCN_LIBRARY]`), and citing a tag is the only way a character can refer
to anything.

A paragraph that carries a tag the actor could not cite is sent back once,
quoting the exact string; `stripUncitableTags` drops whatever is still
uncitable before the paragraph reaches the actor. If the renderer fails the
character gets nothing for that tick. There is deliberately no god-eye
fallback.

The perception stream is append-only and injected whole, so it has a
ceiling. `src/roleSim/perceptionCompactor.ts` hands the character its own
prompt back and asks it to condense the early part into the account it
could still give, keeping recent paragraphs verbatim.
`src/roleSim/promptBudget.ts` measures per-block token spend (counting CJK
and Latin separately) and evicts nothing.

## Memory

`src/memory/` stores six memory types (`NpcMemoryType` in
`prisma/schema.prisma`): `general`, `plan`, `secret`, `relationship`, `map`,
`long_term_intent`. All of them are character-authored:

- A module seeds them through each NPC profile's `memory` array, including
  geographic knowledge as `map` memories in the character's own voice.
- In play, `writeMemory` writes the same types with an `op` of `add`
  (default), `replace` or `delete`. `replace` and `delete` address a memory
  by the tag `memoryFormatter.ts` renders at the head of each line; the tag
  resolves only against memories that were in that decision's prompt.
- Nothing is generated on the character's behalf: no bootstrap gazetteer,
  no end-of-day diary. A place absent from both profile and written
  memories does not exist for that character.

Memories are injected whole into the user prompt, which is why there is no
recall tool. Decay lives in `DecayEngine`; embeddings come from FastEmbed
via `src/rag/localEmbeddingManager.ts`.

A character's view of another is a `relationship` memory it writes itself;
writing one also updates `npcRelationshipGraph`. Knowing *who* someone is
is a separate fact: the graph node's `knownAs`, set when a name is said in
the character's hearing, is the only thing `isKnownTo` reads. The engine
has no relationship operation of its own.

## Skills

Skills are 17 broad ability domains defined in
`src/engine/rules/skillCatalog.ts`, each with a guidance document under
`src/engine/rules/skills/`:

Social · Knowledge & Craft · Science & Nature · Investigation · Athletics ·
Swimming · Stealth & Security · Repair & Engineering · Land Vehicle
Operation · Watercraft Operation · Aircraft Operation · Survival &
Navigation · Medicine & Psychology · Melee Combat · Ranged Combat ·
Languages · Occult

Specific approaches, tools and weapon types are judged from the action
description by the engine rather than tracked as separate stats.
`skillReference.ts` renders the catalog into both the character system
prompt and the engine session.

## Modules (world data)

A module is a directory of JSON files loaded by `src/state/moduleLoader.ts`
and validated by `src/state/moduleSchemaV2.ts`. Every rule in the authoring
contract, `testmods/DYNAMIC_WORLD_SCENE_SCHEMA.md`, is enforced at load
time; violations are collected into one `ModuleSchemaError`.

```
<module>/
  module_setup.json            optional: startDate + introduction + weather presets
  npc_injection_policy.json    optional: which NPCs simulate, by tier
  <scenes-dir>/                SCN_*.json (scenes), ROAD_*.json (roads), VEH_*.json (vehicles)
  <npc-dir>/*.json             NPC profiles (placement, stats, seeded memories)
  scripted-events/*.json       optional: event definitions
```

Schema v2 is prose-first: a scene's `description` is the complete text a
character perceives, every visible object, passage and condition is cited
inline as `[reference-id]`, and the matching machine-readable rows live in
the same file under `references`. Files without `schemaVersion: 2` are
rejected. There are two place kinds only — top-level scenes are geography
nodes and roads connect them; interiors attach to a scene through
`parentLocationId`.

`testmods/grayhaven/` is the reference module (about 70 places, around ten
NPCs). Runtime modules live under `data/Mods/`.

## Getting started

Prerequisites: Node >= 18, pnpm (enforced through `only-allow`), a
PostgreSQL database, and an API key for at least one model provider.

```bash
pnpm install                      # also runs prisma generate
cp .env.example .env              # set MODEL_PROVIDER, the matching *_API_KEY, DATABASE_URL, JWT_SECRET
pnpm prisma db push               # create the schema (see note below)
pnpm chat                         # API + WebSocket server on PORT (default 3000)
pnpm chat:frontend                # Vite dev server for the React viewer in client/
pnpm chat:dev                     # both at once
```

Use `prisma db push`, not `prisma migrate dev`: the `reminder_embeddings`
table has schema drift that makes `migrate dev` unsafe.

The React app in `client/src/` creates, inspects and controls simulations.
`godot-client/` is a separate GDScript client that consumes the same
WebSocket event stream.

## Simulation API

The server (`client/server.ts`) mounts everything under `/api`. Simulation
control requires a logged-in user (`/api/auth/register`, `/api/auth/login`);
the viewer reads are public.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/simulation` | body `{ moduleName, language?, config? }` |
| `POST` | `/api/simulation/:id/start` | |
| `POST` | `/api/simulation/:id/pause` | |
| `POST` | `/api/simulation/:id/resume` | |
| `POST` | `/api/simulation/:id/step` | body `{ ticks? }`, default 1 |
| `POST` | `/api/simulation/:id/stop` | |
| `DELETE` | `/api/simulation/:id` | |
| `GET` | `/api/simulations` | list the caller's simulations |
| `PUT` | `/api/simulation/:id/config` | |
| `POST` | `/api/simulation/:id/characters` | inject a character into a running world |
| `GET` | `/api/simulation/:id/status` | public |
| `GET` | `/api/simulation/:id/events` | public |
| `GET` | `/api/simulation/:id/topology` | public |
| `GET` | `/api/simulation/:id/map-layout` | public |
| `GET` | `/api/simulation/:id/positions` | public |
| `GET` | `/api/simulation/:id/npc-statuses` | public |

Live tick events are broadcast on the WebSocket endpoint at `/ws`.

## Configuration

`.env.example` is the reference. The variables that shape a run:

| Variable | Purpose |
|---|---|
| `MODEL_PROVIDER` | `anthropic`, `openai`, `google` or `deepseek` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY` | credentials per vendor |
| `{SMALL,MEDIUM,LARGE}_{ANTHROPIC,OPENAI,GOOGLE,DEEPSEEK}_MODEL` | model per class and vendor |
| `EMBEDDING_OPENAI_MODEL`, `EMBEDDING_GOOGLE_MODEL`, `IMAGE_OPENAI_MODEL` | embedding and image models |
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT`, `API_URL` | server port and base URL |
| `JWT_SECRET` | token signing secret |
| `LLM_TRACE_DIR` | dump every model call (prompt and answer) to disk |
| `NPC_DECIDE_CONCURRENCY` | parallel NPC decisions per tick |
| `SKIP_EMBEDDING_WARMUP` | skip loading the embedding model at boot |
| `PRISMA_LOG_QUERIES` | log SQL |

The model layer in `src/models/` has one adapter per vendor under
`providers/`; retries, model-class fallback and usage accounting live in
`generator.ts`. Native tool calls and provider prompt-cache breakpoints are
supported.

## Scripts

Free (no model calls):

```bash
pnpm test                   # vitest
pnpm check                  # biome lint + format + organize imports
pnpm build                  # swc build src -> dist
pnpm build:tsc              # type-check + emit with tsc
pnpm smoke:module           # load a module, report schema errors
pnpm lint:agent-cases       # structural check of the decision case table
```

Paid (every one of these calls real models; nothing is stubbed):

```bash
pnpm test:agent-decisions   # stage each case in its own session, run the pipeline a few in-world minutes
pnpm sim:full               # whole reference town, one session, resumable from the last completed tick
pnpm prompt:budget          # per-block token accounting for the character prompt
```

`test-agent-decisions.ts` accepts `--list`, `--only <case>`,
`--module grayhaven`, `--drop-sessions` and `--dump-prompts`. It records an
objective per-actor trace and does no grading. Set `LLM_TRACE_DIR` to keep
every prompt and answer from any run.

## Repository layout

```
src/
  engine/       tick runtime: core/ (tickEngine, applier, eventBus, scriptedEventRunner),
                actions/ (command intake, validator/builder, movement runtime),
                resolution/ (World Action Engine, context builder, WorldDelta schema/validator),
                tools/ (damageRoll), subsystem/ (fire, weather, sun, stamina, item damage,
                condition expiry), scriptedEvents/, rules/, shared/ (dice, pathfinding, topology)
  roleSim/      character agent: llmAgent, npcActionController, renderer/, systemPrompt,
                userPromptBuilder, memoryFormatter, perceptionCompactor, promptBudget, tools/
  simulation/   SimulationRunner, SimulationEventEmitter, runtimePersistence, characterInjection
  state/        DynamicGameState + loader, moduleLoader/moduleSchemaV2, gameClock,
                perceivableDirectory, perceivedLocation, connectionRegistry, characterSpot
  memory/       MemoryStore, MemoryRetriever, NpcMemoryManager, DecayEngine, handlers/
  models/       LLM layer: providers/ (anthropic, openai, google, deepseek), generator, trace
  rag/          local embedding manager
  i18n/         en / zh
  shared/       Prisma client, module scoping, seed data
  planning/     residual (sceneMapFormatter and a few types); being retired
client/         Express + WebSocket server (server.ts, server/) and React + Vite viewer (src/)
godot-client/   GDScript client for the WebSocket event stream
testmods/       reference module and the authoring schema
data/Mods/      runtime modules
prisma/         schema
scripts/        simulation harness, module smoke test, prompt budget, image generation
docs/           operations notes
```

Time is carried as a single ISO 8601 `gameDateTime` string everywhere
(`src/state/gameClock.ts`).

## Testing

Tests use vitest and live in `__tests__/` directories beside the source
they cover (`src/engine/**/__tests__`, `src/state/__tests__`,
`src/memory/__tests__`, `src/models/__tests__`, `src/roleSim/__tests__`,
`src/simulation/__tests__`). Engine integration tests build a world through
`src/engine/__tests__/integration/makeIntegrationEngine.ts`. The `@/*`
alias maps to `src/*`.

```bash
pnpm test                                # everything
pnpm test -- src/state/__tests__/x.test.ts
pnpm test -- -t "name pattern"
```

## Further reading

- `CLAUDE.md` — architecture notes and constraints kept current with the code.
- `docs/engine-operations.md` — the four operation layers of the engine (Chinese).
- `testmods/DYNAMIC_WORLD_SCENE_SCHEMA.md` — the module authoring contract.
- `src/engine/rules/*.md` — the rule documents the World Action Engine reads.

## License

MIT. See `LICENSE`.
