# Four-Layer Architecture Redesign

## Motivation

From first principles: the system has four distinct concerns that should map to four layers, plus an independent NPC AI system and an orchestration pattern.

Current problems:
- Handlers directly mutate state instead of producing deltas
- Narrative generation is mixed into engine logic
- NPC Planning is tangled with engine execution
- No translation layer between action intent and engine operations
- `impactPipeline` mixes engine-level interruption with NPC-level re-decision

## Architecture Overview

```
┌──────────────┐    ┌──────────────┐
│ Player Input  │    │  NPC Agent   │
│ (future)      │    │ (autonomous) │
└──────┬───────┘    └──────┬───────┘
       │                   │
       │  submit tool calls │  submit tool calls
       │  (with game time)  │  (with game time)
       ↓                   ↓
┌──────────────────────────────────┐
│        Translation Layer          │
│   input -> EngineToolCall[]        │
│   (like LLM function calling)    │
└──────────────┬───────────────────┘
               ↓
┌──────────────────────────────────┐
│            Engine                 │
│   - Tick advances by game time    │
│   - ScheduledToolCall queue       │
│   - Each tick: execute due calls  │
│   - Features, interruption        │
│   - Does NOT depend on NPC AI     │
└──────────────┬───────────────────┘
               ↓
┌──────────────────────────────────┐
│      Narrative / Rendering        │
│   (deferred — keep as-is)         │
└──────────────────────────────────┘
```

**Key principle:** The engine ticks autonomously by game time. NPC agents and players are external consumers that submit tool calls through the translation layer. The engine does not ask NPCs what to do — it executes whatever tool calls are due in its queue.

**ScheduledToolCall queue:** The engine maintains its own queue of scheduled tool calls. This is separate from PlanNode (which is the NPC agent's internal concept). The flow:

1. NPC agent produces PlanNodes (NPC's own planning format)
2. Translation layer converts PlanNode → ScheduledToolCall[] and submits to engine queue
3. Engine each tick fetches due ScheduledToolCalls and executes them

```typescript
interface ScheduledToolCall {
  id: string;                // unique call id
  toolId: string;            // which EngineTool to invoke
  params: Record<string, unknown>;
  startTime: string;         // when to execute (game time)
  endTime: string;           // when it ends
  submittedBy: string;       // who submitted (npc_id / player_id)
  status: "pending" | "in_progress" | "completed" | "failed";
}
```

PlanNode is the NPC's concept. ScheduledToolCall is the engine's concept. The engine never sees PlanNode.

## Directory Structure

```
src/
  input/                    # Player input (reserved for future)

  npc/                      # NPC Agent (autonomous, external to engine)
    planning/               #   Proactive: daily schedule generation
    decision/               #   Reactive: re-decision after interruption

  translation/              # Translation Layer (thin)
    actionTranslator.ts     #   input -> EngineToolCall[]

  engine/                   # Engine (autonomous tick + tool execution)
    tick.ts                 #   Tick progression — engine's core capability
    registry.ts             #   EngineTool/feature registration
    registerDefaults.ts
    types.ts                #   EngineTool, Feature interfaces + delta types
    operations/             #   Registered engine tools (unified handlers + tools)
      actionOp.ts
      movementOp.ts
      characterInteractionOp.ts
      itemOp.ts
      resolvers/            #   LLM state resolvers (produce delta + narrative)
        actionStateResolver.ts
        interactionStateResolver.ts
        itemStateResolver.ts
    features/               #   World feature systems
    runtime/                #   Impact evaluation, interruption mechanism
    shared/                 #   skillRoll, pathfinding, dice, etc.
    index.ts

  simulation/               # Glue: creates NPC agents + starts engine + lifecycle
    SimulationRunner.ts     #   Lifecycle management (start/stop/pause/persist)

  state/                    # Cross-cutting: state management
  memory/                   # Cross-cutting: memory storage
  models/                   # Cross-cutting: LLM invocation wrapper
```

## Layer Responsibilities

### Input Layer (`src/input/`)

Reserved for future player input handling. When implemented, it will receive player natural language and pass it to the translation layer, which converts it into engine tool calls.

### NPC Agent (`src/npc/`)

Autonomous agent, external to the engine. Interacts with the engine the same way a player would — through the translation layer.

**Planning** (`npc/planning/`):
- Proactively generates daily schedules via LLM
- Submits planned actions (PlanNodes) to the engine's tool call queue with scheduled game times
- The engine executes them when the time comes — the NPC doesn't drive ticks

**Decision** (`npc/decision/`):
- Reactive re-decision after engine interruption
- Engine notifies NPC of interruption → NPC decides new actions → submits new tool calls

**Key constraint:** NPC agent does not know about engine internals. It submits tool calls through the translation layer. The engine does not depend on NPC AI — it would tick forward even with zero NPCs.

### Translation Layer (`src/translation/`)

Directly converts input into engine tool calls — like LLM function calling.

The engine registers a set of tools (unified from current handlers + tools), each with a parameter schema. The translation layer produces an array of tool calls — exactly like an LLM's `tool_calls` output.

```typescript
// Definition side: registered in engine registry
interface EngineTool {
  id: string;
  schema: ParameterSchema;
  execute(params: unknown): { delta, narrative };
}

// Call side: produced by translation layer
type EngineToolCall = {
  toolId: string;
  params: Record<string, unknown>;
}

// One translation produces multiple tool calls
function translate(input: unknown, state: GameState): EngineToolCall[]
```

No intermediate `Action` type needed. The translation layer takes whatever input it receives (NPC PlanNode, player natural language, etc.) and produces ScheduledToolCalls that are submitted to the engine's queue. Currently rule-based; can evolve to LLM-based for player natural language input.

### Engine Layer (`src/engine/`)

Autonomous tick-based engine. Advances game time independently, executes due tool calls each tick.

**Tick progression** is the engine's core capability:
1. Advance game time by one tick
2. Fetch due ScheduledToolCalls from the queue (`startTime` <= current tick)
3. Execute each via registered `EngineTool` → `{ delta, narrative }`
4. Apply deltas to state
5. Run feature ticks/propagation
6. Evaluate impact → trigger interruptions (notify submitters via callback)

The engine does NOT depend on NPC AI. It would tick forward with an empty queue.

**Unified delta flow:**
1. Tool executes, produces `{ delta, narrative }` — no direct state mutation
2. Engine collects all deltas
3. Deltas applied to state in order via registered appliers
4. Narrative data collected for downstream consumption

```typescript
interface DeltaApplier<T> {
  apply(state: DynamicGameState, delta: T): void;
}
```

Delta types remain heterogeneous (`SceneStateDelta`, `InteractionStateDelta`, `ObjectStateDelta`, `FireDelta`, etc.). Each registers its own applier. The flow is uniform; the types are not.

**LLM resolvers** produce `{ delta, narrative }` in a single LLM call. Engine consumes only `delta`; `narrative` is passed through.

**Interruption mechanism** (engine's responsibility):
- After action execution, engine evaluates event impact
- If impact exceeds threshold, engine interrupts the NPC's pending tool calls
- Engine notifies the NPC agent of the interruption (callback/event)
- NPC agent handles re-decision independently → submits new tool calls

**What moves out of engine:**
- NPC re-decision logic (currently in `impactPipeline`) -> `src/npc/decision/`
- Memory recording of narrative -> stays as-is for now (narrative layer deferred)

### Narrative / Rendering Layer

Deferred. Current behavior retained: handlers produce outcome text and memory, `SimulationEventEmitter` broadcasts events, client renders.

Future: centralized `narrativeDispatcher` that receives all `narrative` outputs from a tick and distributes to consumers (memory writer, event broadcaster, client push).

## Engine Tick vs Simulation

**Engine tick** (`src/engine/tick.ts`) is the engine's own capability:
```
engine.tick():
  1. Advance game time
  2. Fetch due ScheduledToolCalls from queue
  3. Execute each → { delta, narrative }
  4. Apply deltas
  5. Feature tick/propagation
  6. Impact evaluation → interrupt affected calls, notify submitters
```

**Simulation** (`src/simulation/`) is just glue:
```
SimulationRunner:
  - Creates NPC agents
  - NPC agents plan → translate → submit ScheduledToolCalls to engine queue
  - Starts engine ticking
  - On interruption callback: NPC agent re-decides → submits new calls
  - Manages lifecycle (start/stop/pause/persist/broadcast)
```

The engine runs independently. Simulation wires NPC agents into it.

## Cross-Cutting Concerns

- **`state/`**: `DynamicGameState` — read by all layers, mutated only by engine's delta apply
- **`memory/`**: Memory storage — written by narrative flow, read by NPC AI for context
- **`models/`**: LLM wrapper — used by NPC AI (planning) and engine (resolvers)

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Delta types | Heterogeneous, uniform flow | Each handler/feature has different state concerns; forcing a single type adds needless complexity |
| LLM in resolver | Single call -> delta + narrative | Splitting into two LLM calls doubles cost/latency for no structural benefit |
| Translation layer | Produces ScheduledToolCalls submitted to engine queue | NPC PlanNode → ScheduledToolCall; future player input → same queue |
| Handlers + Tools unified | Unified as `EngineTool` in registry | Both are "things the engine can do"; artificial distinction removed |
| PlanNode vs ScheduledToolCall | Separate concepts | PlanNode is NPC's internal plan; ScheduledToolCall is engine's execution unit. Engine never sees PlanNode |
| NPC Agent | External to engine | NPC submits tool calls like a player would. Engine doesn't depend on NPC AI |
| Tick progression | Engine's own capability | Engine ticks by game time autonomously. Simulation just wires agents in |
| Impact pipeline split | Interruption in engine, re-decision in NPC AI | Interruption is a game mechanism; re-decision is NPC intelligence |
| Narrative layer | Deferred | Current narrative flow works; refactoring it simultaneously would bloat scope |

## Migration Plan (High-Level)

Steps 1–7 are DONE. Remaining:

1. ~~Define new types: `EngineTool`, `EngineToolCall`, `ScheduledToolCall`~~ ✅
2. ~~Unify handlers + tools into `EngineTool`~~ ✅
3. ~~Operations return `{ delta, narrative }`~~ ✅
4. ~~Delta apply pipeline in registry~~ ✅
5. ~~Translation layer~~ ✅
6. ~~Move planning to `src/npc/planning/`~~ ✅
7. ~~Split `impactPipeline`~~ ✅
8. Define `ScheduledToolCall` type + engine queue (replaces PlanNode as engine's execution unit)
9. Update translation layer to produce `ScheduledToolCall[]` and submit to engine queue
10. Build `engine/tick.ts` — engine's autonomous tick method using the queue
11. Refactor `SimulationRunner` to be pure glue: create NPC agents + start engine + lifecycle
