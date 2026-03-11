# NPC Autonomous Simulation — Design Specification

**Date:** 2026-03-11
**Branch:** tick
**Status:** Draft
**Dependency:** NPC Memory Framework (docs/superpowers/specs/2026-03-11-npc-memory-framework-design.md)

## Overview

A new simulation flow — separate from the existing player-driven game — where NPCs run autonomously as self-directing agents. Each NPC has their own memory, goals, and planning. The existing tick processor executes their plans automatically with no player character involved.

The original player game pipeline remains untouched.

## Architecture

```
SimulationRunner (new, thin)
├── clock: setInterval (real-time) or step-by-step (manual)
├── end conditions: max days, manual stop, event triggers
├── calls: tickProcessor.runSimulationTick() (new exported function)
└── emits: SimulationEvent via EventEmitter → WebSocket

tickProcessor (refactored)
├── new export: runSimulationTick() — wraps executeSingleTick + time advancement
├── executeSingleTick gains mode: "player_turn" | "simulation"
├── simulation mode skips: player nodes, witness interrupts, skill selection
├── simulation mode adds: NPC clue discovery
└── everything else identical to player_turn mode
```

## 1. SimulationRunner

**File:** `src/dynamicworldagent/simulation/SimulationRunner.ts`

Manages simulation lifecycle and drives time forward.

### Configuration

```typescript
interface SimulationConfig {
  sessionId: string;
  moduleId: string;
  mode: "realtime" | "paused";       // initial mode
  tickIntervalMs: number;             // default 60000 (1 real minute = 1 tick = 5 in-game minutes)
  maxDays?: number;                   // time-bounded end condition
  stopEvents?: string[];              // event-driven end triggers
}

interface SimulationStatus {
  state: "running" | "paused" | "stopped" | "completed";
  currentDay: number;
  currentTime: string;                // HH:MM
  ticksExecuted: number;
  stopReason?: "manual" | "max_days" | "event_triggered";
}
```

### Lifecycle

```
create(config) → paused
start()        → running (begins setInterval at tickIntervalMs)
pause()        → paused (clears interval)
resume()       → running (restarts interval)
step(ticks?)   → executes N ticks while paused, stays paused
stop()         → stopped (terminal, clears interval, closes WebSocket)
```

### Tick Loop (per tick)

1. Call `tickProcessor.runSimulationTick()` (see Section 2 for details)
2. `runSimulationTick` advances game time by `TICK_DURATION_MINUTES` (5 min) via `dgsm.updateGameTime()`
3. If `dgsm.updateGameTime()` returns `{ dayChanged: true }` → call `NPCPlanningAgent.onNewDay(gameDay, sessionId, moduleId, language, registry)`
4. Collect emitted events from tick result
5. Persist events to `simulation_events` table
6. Emit events via EventEmitter → WebSocket
7. Check end conditions:
   - If `currentDay > maxDays` → complete with `stopReason: "max_days"`
   - If any emitted event type is in `stopEvents` → complete with `stopReason: "event_triggered"`

### Concurrency

- Ticks are **sequential** — never concurrent. If a tick's LLM calls take longer than `tickIntervalMs`, the next tick waits.
- `pause()` and `stop()` set a flag checked before each tick starts. If set mid-tick, the current tick completes but no further ticks execute.
- `step(N)` runs N ticks synchronously in sequence and resolves when all complete.

### Time Mapping

- 1 tick = 5 in-game minutes
- 1 real minute = 1 tick (default)
- 1 in-game day (~16 waking hours) ≈ 192 real minutes (~3.2 hours)

## 2. TickProcessor Refactor

**File:** `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

### New Exported Function

`executeSingleTick` is currently module-private (not exported). The exported entry points (`runPlayerAction`, `resumePlayerAction`) embed player-specific time-advancement logic. Add a new exported function for simulation:

```typescript
type TickMode = "player_turn" | "simulation";

/**
 * New exported function for simulation use.
 * Wraps executeSingleTick with simulation-specific time advancement.
 */
export async function runSimulationTick(params: {
  dgsm: DynamicGameStateManager;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  language: string;
  registry: Registry;
  ctx: TickRuntimeContext;
}): Promise<SimulationTickResult> {
  const result = await executeSingleTick({ ...params, mode: "simulation" });
  // Always advance by TICK_DURATION_MINUTES (5 min) — no player nodes to calculate from
  const { dayChanged } = dgsm.updateGameTime(TICK_DURATION_MINUTES);
  return { ...result, dayChanged };
}

interface SimulationTickResult {
  actions: CharacterAction[];
  events: SimulationEvent[];
  dayChanged: boolean;
}
```

### Mode Parameter on executeSingleTick

```typescript
executeSingleTick(
  ...,
  mode: TickMode = "player_turn"
)
```

### Behavior Differences by Mode

| Behavior | player_turn | simulation |
|---|---|---|
| Player nodes | Merged with NPC nodes | Skipped — no player |
| Player witness interrupt | Pause & return `player_interrupt` | Skipped — no one to interrupt |
| Skill selection pause | Player picks skill manually | Skipped — NPCs auto-select |
| Clue discovery | Player only, gated on success | NPCs can discover clues (same logic, scoped to acting NPC) |
| Player fumble damage | Applied | Skipped |

### Unchanged in Both Modes

- `ensureNpcNodesAvailable()` — two-tier plan refill
- NPC node execution via registry handlers
- Unplanned encounter scanning (NPC pairs with |relationship| >= 60)
- Relationship updates via LLM
- NPC memory logging (writes to NpcMemory framework)
- Impact propagation + plan revision triggers
- Feature temporal ticks (fire, weather, stamina, etc.)
- Feature overlay detection & propagation

### NPC Clue Discovery (New for Simulation)

Currently, `discoverClues()` is gated by `node.isPlayer` and calls `dgsm.getCurrentScene()` (player's scene). In simulation mode:

**Code changes required:**
1. Replace `if (action.status === "completed" && node.isPlayer)` with `if (action.status === "completed" && (node.isPlayer || mode === "simulation"))`
2. Pass the acting NPC's location to `discoverClues()` instead of using `dgsm.getCurrentScene()` — look up the scene by the NPC's `node.location`
3. Discovered clues are stored per-NPC in the NpcMemory framework (type: `clue`)
4. Clue difficulty gating based on NPC action success level (same thresholds as player)

## 3. Simulation Session & Initialization

### Init Flow

```
POST /api/simulation { moduleName, config }

  1. Create Session (sessionType: "simulation", no userId)
  2. Load module via ModuleLoader (module_digest.json)
  3. Load all NPCs via NPCLoader → create Character records
  4. Load all scenarios/locations via ScenarioLoader
  5. Initialize DynamicGameState (no player character)
  6. Set gameTime from module_digest initial time
  7. Inject NPC long-term intents from module data (pre-authored)
  8. Inject NPC day-1 schedules from module data (pre-authored)
  9. Return sessionId + SimulationStatus (state: "paused")
```

### Key Differences from Player Game Init

- No player character creation
- No user authentication required
- Long-term intents and day-1 schedules are **module-authored data**, not LLM-generated
- Everything else identical (module loading, NPC creation, scenario loading, relationship graph seeding)

### Handling No Player Character

`DynamicGameState.playerCharacter` is currently a required, non-nullable field. The tick processor and graph reference it in multiple places. For simulation mode:

- Make `playerCharacter` optional on `DynamicGameState`: `playerCharacter?: DynamicCharacterProfile`
- Add null-guards in tick processor where `playerCharacter` is accessed (lines referencing `state.playerCharacter?.id`, `playerCharacter.status.hp`, etc.)
- In simulation mode, `playerCharacter` is `undefined` — all player-specific code paths are already skipped by the `mode === "simulation"` checks
- `initialDynamicGameState` factory gets an optional `playerCharacter` parameter (omitted for simulation)

### Session Type Distinction

```typescript
sessionType: "player_game" | "simulation"
```

Added to Session / DynamicGameState so other subsystems (checkpoints, turn history) know not to expect a player.

### Module Authoring Requirement

NPC profile files in `[Module]_npc/` must include:
- `longTermIntent`: Pre-authored strategic goals for the NPC
- `dayOneSchedule`: Pre-authored `ScheduleEntry[]` for day 1

**Fallback:** If a module does not include these fields, the system falls back to LLM generation via `NPCPlanningAgent.generateLongTermIntents()` and `NPCPlanningAgent.generateDailySchedule()` at init time. This is slower but ensures any existing module can be used for simulation.

## 4. Event System

### Event Format

```typescript
interface SimulationEvent {
  id: string;                          // uuid
  sessionId: string;
  tick: number;
  gameDay: number;
  gameTime: string;                    // HH:MM
  type: SimulationEventType;
  actorNpcId: string;
  targetNpcId?: string;
  location: string;
  data: Record<string, unknown>;       // type-specific payload
  timestamp: Date;                     // real-world time
}

type SimulationEventType =
  | "action_executed"                  // NPC completes a plan node
  | "action_failed"                    // NPC action fails skill roll
  | "encounter"                        // unplanned NPC-NPC encounter
  | "relationship_changed"             // relationship score updated
  | "clue_discovered"                  // NPC finds a clue
  | "plan_revised"                     // NPC revises schedule or nodes
  | "memory_created"                   // new NpcMemory entry
  | "scene_updated"                    // scene state changes (items moved, doors opened, evidence left, etc.)
  | "day_transition"                   // new day begins
  | "feature_triggered"               // fire spread, weather change, etc.
  | "npc_death"                        // NPC HP reaches 0
  | "all_clues_discovered"            // every module clue has been found
  | "simulation_state_changed"         // started, paused, stopped, completed
```

### Delivery

- `SimulationRunner` emits events via Node `EventEmitter`
- WebSocket endpoint `/ws/simulation/:sessionId` streams events to connected clients
- Events persisted to `simulation_events` table for post-hoc inspection

### No Narrative

Events are raw structured data. Narrative generation is not part of the simulation flow.

### End Condition Events

`npc_death` and `all_clues_discovered` are derived events, not directly emitted by the tick processor:
- **`npc_death`**: Emitted by `SimulationRunner` when it detects an NPC's HP has reached 0 after a tick (check `dgsm` character state post-tick)
- **`all_clues_discovered`**: Emitted when the set of discovered clues across all NPCs equals the module's total clue set

### Error Handling

If an LLM call fails during a tick (network error, rate limit):
- The tick is marked as failed with an error event
- SimulationRunner auto-pauses and emits `simulation_state_changed` with error details
- User can `resume()` to retry from the failed tick

### In-Memory Registry

`SimulationRunner` instances are held in a `Map<sessionId, SimulationRunner>` managed by the simulation service layer. On server restart, running simulations are not auto-resumed — they must be manually restarted.

## 5. API & WebSocket

**Routes:** `client/server/simulation/`

### REST Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/simulation` | Create simulation from module |
| POST | `/api/simulation/:id/start` | Start real-time mode |
| POST | `/api/simulation/:id/pause` | Pause simulation |
| POST | `/api/simulation/:id/resume` | Resume real-time |
| POST | `/api/simulation/:id/step` | Advance N ticks while paused (body: `{ ticks?: number }`) |
| POST | `/api/simulation/:id/stop` | Stop simulation (terminal) |
| GET | `/api/simulation/:id/status` | Get current SimulationStatus |
| GET | `/api/simulation/:id/events` | Query persisted events (filters: type, npcId, day, time range) |
| GET | `/api/simulations` | List all simulations |

### WebSocket

- Connect to `/ws/simulation/:sessionId`
- Receives `SimulationEvent` objects in real-time
- Observation only — no client-to-server messages

### No Authentication

Simulation mode does not require user auth.

## 6. End Conditions

Three stop triggers, checked after each tick completes.

### Manual Stop

Client calls `POST /api/simulation/:id/stop`. SimulationRunner clears interval, sets state to `stopped`.

### Time-Bounded

Config specifies `maxDays`. After each tick, if `currentDay > maxDays`, simulation completes with `stopReason: "max_days"`.

### Event-Driven

Config specifies `stopEvents` — array of event type strings. After each tick, if any emitted event matches a stop event type, simulation completes with `stopReason: "event_triggered"`.

Built-in triggers:
- `npc_death` — an NPC's HP reaches 0
- `all_clues_discovered` — every clue in the module has been found

### Priority

Manual stop takes effect immediately. Time and event checks run after tick completion. If both trigger on the same tick, first match wins.

### On Completion

SimulationRunner persists final state, emits `simulation_state_changed` event, closes WebSocket connections. Session and all events remain in DB for inspection.

## 7. Data Model Additions

### Prisma Schema

```prisma
model SimulationEvent {
  id          String   @id @default(uuid())
  sessionId   String   @map("session_id")
  tick        Int
  gameDay     Int      @map("game_day")
  gameTime    String   @map("game_time")
  type        String
  actorNpcId  String   @map("actor_npc_id")
  targetNpcId String?  @map("target_npc_id")
  location    String
  data        Json
  timestamp   DateTime @default(now())

  session     Session  @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)

  @@index([sessionId])
  @@index([sessionId, type])
  @@index([sessionId, gameDay])
  @@map("simulation_events")
}
```

### Session Model Update

Add `sessionType` field to distinguish simulation from player game:

```prisma
model Session {
  // ... existing fields
  sessionType  String  @default("player_game") @map("session_type")
  // ... existing relations
  simulationEvents SimulationEvent[]
}
```

**Migration:** Apply via `prisma db push` (consistent with existing project convention for schema changes). Existing sessions get default value `"player_game"`. No impact on existing queries.

**Note:** `actorNpcId` and `targetNpcId` on `SimulationEvent` are plain strings (not foreign keys to Character) — intentional loose coupling since NPC IDs may differ from Character PKs.

## 8. File Structure

```
src/dynamicworldagent/simulation/
├── SimulationRunner.ts          # Core loop controller
├── SimulationEventEmitter.ts    # Event creation + emission
└── types.ts                     # SimulationConfig, SimulationStatus, SimulationEvent, etc.

client/server/simulation/
├── controller.ts                # Request handlers
├── routes.ts                    # Express routes
└── service.ts                   # Business logic (create, start, stop, query events)
```

## Dependencies

- **NPC Memory Framework** must be implemented first — simulation writes NPC memories via the new NpcMemory system
- **Module authoring** — modules must include per-NPC `longTermIntent` and `dayOneSchedule` data
- **TickProcessor** refactor is the integration point — minimal changes to existing code
