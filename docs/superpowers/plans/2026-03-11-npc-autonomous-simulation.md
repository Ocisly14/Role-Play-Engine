# NPC Autonomous Simulation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new simulation flow where NPCs run autonomously without a player, driven by the existing tick processor with a mode flag.

**Architecture:** Thin `SimulationRunner` manages a clock (real-time or manual step) and calls a new `runSimulationTick()` export on the existing tick processor. The tick processor gains a `mode: "simulation"` parameter that skips player-specific logic. Events are emitted via EventEmitter and streamed over WebSocket.

**Tech Stack:** TypeScript, Prisma, Express, WebSocket, Node EventEmitter

**Spec:** `docs/superpowers/specs/2026-03-11-npc-autonomous-simulation-design.md`

---

## File Structure

```
New files:
  src/dynamicworldagent/simulation/types.ts                    # All simulation types
  src/dynamicworldagent/simulation/SimulationEventEmitter.ts   # Event creation + emission
  src/dynamicworldagent/simulation/SimulationRunner.ts         # Core loop controller
  client/server/simulation/service.ts                          # Business logic
  client/server/simulation/controller.ts                       # Request handlers
  client/server/simulation/routes.ts                           # Express routes
  __tests__/simulation/types.test.ts                           # Type validation tests
  __tests__/simulation/simulationRunner.test.ts                # Runner unit tests
  __tests__/simulation/tickProcessor.simulation.test.ts        # Tick processor mode tests

Modified files:
  prisma/schema.prisma                                         # SimulationEvent model + Session.sessionType
  src/dynamicworldagent/state/DynamicGameState.ts              # playerCharacter optional
  src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts  # mode param + runSimulationTick
  src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts # SimulationTickResult type
  client/server/websocket/WebSocketManager.ts                  # Simulation client map
  client/server.ts                                             # Mount simulation routes
```

---

## Chunk 1: Types + Prisma Schema + DynamicGameState

### Task 1: Prisma Schema — SimulationEvent model + Session.sessionType

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add sessionType to Session model**

In `prisma/schema.prisma`, find the `Session` model (line ~463). Add after the `emailId` field:

```prisma
  sessionType     String           @default("player_game") @map("session_type")
```

- [ ] **Step 2: Add SimulationEvent model**

Add at end of `prisma/schema.prisma`:

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

- [ ] **Step 3: Add inverse relation on Session**

In the `Session` model, add to the relations section:

```prisma
  simulationEvents   SimulationEvent[]
```

- [ ] **Step 4: Push schema**

Run: `npx prisma db push`
Expected: Schema synced successfully.

- [ ] **Step 5: Generate client**

Run: `npx prisma generate`
Expected: Prisma Client generated.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(simulation): add SimulationEvent model and Session.sessionType"
```

---

### Task 2: Simulation Types

**Files:**
- Create: `src/dynamicworldagent/simulation/types.ts`

- [ ] **Step 1: Create types file**

```typescript
// src/dynamicworldagent/simulation/types.ts

export type SimulationEventType =
  | "action_executed"
  | "action_failed"
  | "encounter"
  | "relationship_changed"
  | "clue_discovered"
  | "plan_revised"
  | "memory_created"
  | "scene_updated"
  | "day_transition"
  | "feature_triggered"
  | "npc_death"
  | "all_clues_discovered"
  | "simulation_state_changed";

export interface SimulationEvent {
  id: string;
  sessionId: string;
  tick: number;
  gameDay: number;
  gameTime: string;
  type: SimulationEventType;
  actorNpcId: string;
  targetNpcId?: string;
  location: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

export type SimulationState = "running" | "paused" | "stopped" | "completed";
export type StopReason = "manual" | "max_days" | "event_triggered";

export interface SimulationConfig {
  sessionId: string;
  moduleId: string;
  mode: "realtime" | "paused";
  tickIntervalMs: number;
  maxDays?: number;
  stopEvents?: string[];
}

export interface SimulationStatus {
  state: SimulationState;
  currentDay: number;
  currentTime: string;
  ticksExecuted: number;
  stopReason?: StopReason;
}

export const DEFAULT_TICK_INTERVAL_MS = 60_000;
export const SIMULATION_EVENT_TYPES: readonly SimulationEventType[] = [
  "action_executed",
  "action_failed",
  "encounter",
  "relationship_changed",
  "clue_discovered",
  "plan_revised",
  "memory_created",
  "scene_updated",
  "day_transition",
  "feature_triggered",
  "npc_death",
  "all_clues_discovered",
  "simulation_state_changed",
] as const;
```

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/simulation/types.ts
git commit -m "feat(simulation): add simulation type definitions"
```

---

### Task 3: Make playerCharacter optional on DynamicGameState

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameState.ts`

- [ ] **Step 1: Make playerCharacter optional in interface**

In `DynamicGameState.ts` line 110, change:

```typescript
playerCharacter: DynamicCharacterProfile;
```

to:

```typescript
playerCharacter?: DynamicCharacterProfile;
```

- [ ] **Step 2: Make playerCharacter optional in initialDynamicGameState factory**

In `initialDynamicGameState` (line ~185), change the params type from:

```typescript
playerCharacter: DynamicCharacterProfile;
```

to:

```typescript
playerCharacter?: DynamicCharacterProfile;
```

And in the returned object, change the `playerCharacter` assignment to use the optional value:

```typescript
playerCharacter: params.playerCharacter,
```

If the factory currently spreads or assigns it unconditionally, guard it so that `undefined` is valid.

- [ ] **Step 3: Add null-guards across the entire `src/dynamicworldagent/` directory**

Search the entire `src/dynamicworldagent/` directory for `state.playerCharacter` and `this.state.playerCharacter` without optional chaining. Add `?.` or early returns where appropriate.

**Known locations requiring null-guards (not exhaustive — compiler will surface others):**

| File | Lines | Access Pattern |
|------|-------|----------------|
| `state/DynamicGameState.ts` | ~1005 (`applyActionUpdate`) | `this.updateCharacter(this.state.playerCharacter, ...)` |
| `state/DynamicGameState.ts` | ~1379 (`applyRest`) | `const player = this.state.playerCharacter` then `player.attributes?.siz` |
| `engine/shared/topologyHelpers.ts` | ~89 | `characterId === state.playerCharacter.id` |
| `engine/features/staminaFeature.ts` | ~140, 164, 183, 210-211 | Multiple unguarded accesses |
| `engine/features/sanityFeature.ts` | ~212, 239, 255, 290, 366, 440-441 | Multiple unguarded accesses |
| `dynamicBasicAgent/npcPlanning/PlayerPlanAgent.ts` | ~47 | `state.playerCharacter` direct access |

For each: add optional chaining (`?.`) and early return if `playerCharacter` is `undefined`. The player game flow always provides `playerCharacter`, so these guards only activate in simulation mode.

- [ ] **Step 4: Add `sessionType` field to DynamicGameState interface**

Per the spec, add to the `DynamicGameState` interface:

```typescript
sessionType?: "player_game" | "simulation";
```

And in `initialDynamicGameState`, default it:

```typescript
sessionType: params.sessionType ?? "player_game",
```

- [ ] **Step 5: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/dynamicworldagent/
git commit -m "feat(simulation): make playerCharacter optional on DynamicGameState"
```

---

## Chunk 2: TickProcessor Refactor

### Task 4: Add TickMode and mode parameter to executeSingleTick

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts`

- [ ] **Step 1: Add TickMode type to types.ts**

In `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts`, add:

```typescript
export type TickMode = "player_turn" | "simulation";
```

- [ ] **Step 2: Add mode to SingleTickParams**

In `tickProcessor.ts`, update `SingleTickParams` (line ~300) — add:

```typescript
mode?: TickMode;
```

And import `TickMode` from `./types.js`.

- [ ] **Step 3: Add simulation guards in executeSingleTick**

In `executeSingleTick` (line 335), destructure mode with default:

```typescript
const { mode = "player_turn", ...rest } = params;
const isSimulation = mode === "simulation";
```

Then add guards at these locations:

**Line ~411 — skip player failure tracking in simulation:**
```typescript
if (playerFailed && node.isPlayer && !isSimulation) {
```

**Line ~425 — skip player failure marking:**
```typescript
if (action.status === "failed" && node.isPlayer && !isSimulation) {
```

**Line ~618 — skip fumble damage:**
```typescript
if (node.isPlayer && action.successLevel === "fumble" && !isSimulation) {
```

**Note:** The witness interrupt / `player_interrupt` return logic (lines ~955-967) is in `runPlayerAction`, NOT in `executeSingleTick`. Since `runSimulationTick` calls `executeSingleTick` directly (bypassing `runPlayerAction`), this code path is already unreachable in simulation mode. No guard needed there.

- [ ] **Step 4: Skip player nodes in simulation mode (defense-in-depth)**

`runSimulationTick` already passes `playerNodes: []`, but add a belt-and-suspenders guard in the merge step:

```typescript
const effectivePlayerNodes = isSimulation ? [] : playerNodes;
```

Use `effectivePlayerNodes` in the merge instead of `playerNodes`.

- [ ] **Step 5: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts
git commit -m "feat(simulation): add TickMode param to executeSingleTick"
```

---

### Task 5: NPC clue discovery in simulation mode

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

- [ ] **Step 1: Modify clue discovery guard**

At line ~587, change:

```typescript
if (action.status === "completed" && node.isPlayer) {
```

to:

```typescript
if (action.status === "completed" && (node.isPlayer || isSimulation)) {
```

- [ ] **Step 2: Use NPC's scene for clue discovery**

Inside the clue discovery block, the current code calls `discoverClues(node, effectiveSuccess, dgsm, language)`. The `discoverClues` function internally uses `dgsm.getCurrentScene()` which returns the player's scene.

Modify `discoverClues` to accept an optional `sceneId` parameter:

```typescript
async function discoverClues(
  node: PlanNode,
  successLevel: SuccessLevel,
  dgsm: DynamicGameStateManager,
  language: string = "en",
  overrideSceneId?: string
): Promise<DiscoveredClueEntry[]> {
```

Inside `discoverClues`, change scene lookup:

```typescript
const scene = overrideSceneId
  ? dgsm.getScene(overrideSceneId)
  : dgsm.getCurrentScene();
```

At the call site (line ~589), pass the NPC's location in simulation mode:

```typescript
const clueSceneId = isSimulation ? node.location : undefined;
const clues = await discoverClues(node, effectiveSuccess, dgsm, language, clueSceneId);
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat(simulation): enable NPC clue discovery in simulation mode"
```

---

### Task 6: Add runSimulationTick exported function

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts`

- [ ] **Step 1: Add SimulationTickResult to types.ts**

In `types.ts`, add:

```typescript
import type { SimulationEvent } from "../../simulation/types.js";

export interface SimulationTickResult {
  actions: CharacterAction[];
  events: SimulationEvent[];
  dayChanged: boolean;
}
```

- [ ] **Step 2: Add runSimulationTick export to tickProcessor.ts**

At the end of `tickProcessor.ts`, add:

```typescript
import type { SimulationTickResult } from "./types.js";

export async function runSimulationTick(params: {
  dgsm: DynamicGameStateManager;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  moduleId: string;
  language: string;
  registry: GameEngineRegistry;
  ctx: ExecutionContext;
  memoryManager?: NpcMemoryManager;
}): Promise<SimulationTickResult> {
  const state = params.dgsm.getState();
  const tickStartMinutes =
    parseInt(state.timeOfDay.split(":")[0]) * 60 +
    parseInt(state.timeOfDay.split(":")[1]);

  const result = await executeSingleTick({
    tickStartMinutes,
    tickDurationMinutes: TICK_DURATION_MINUTES,
    playerNodes: [],
    mode: "simulation",
    ...params,
  });

  const { dayChanged } = params.dgsm.updateGameTime(TICK_DURATION_MINUTES);

  // SingleTickResult always has { actions, playerFailed, playerEvents, injectedNodes }
  // — no discriminated union, no .type field
  return {
    actions: result.actions,
    events: [],  // Events will be constructed by SimulationEventEmitter from actions
    dayChanged,
  };
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts
git commit -m "feat(simulation): add runSimulationTick exported function"
```

---

## Chunk 3: SimulationEventEmitter + SimulationRunner

### Task 7: SimulationEventEmitter

**Files:**
- Create: `src/dynamicworldagent/simulation/SimulationEventEmitter.ts`

- [ ] **Step 1: Create event emitter**

```typescript
// src/dynamicworldagent/simulation/SimulationEventEmitter.ts

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  SimulationEvent,
  SimulationEventType,
} from "./types.js";
import type { CharacterAction } from "../dynamicBasicAgent/npcPlanning/types.js";

export class SimulationEventEmitter extends EventEmitter {
  private sessionId: string;
  private tick: number = 0;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  setTick(tick: number): void {
    this.tick = tick;
  }

  emitSimulationEvent(
    type: SimulationEventType,
    actorNpcId: string,
    location: string,
    gameDay: number,
    gameTime: string,
    data: Record<string, unknown>,
    targetNpcId?: string
  ): SimulationEvent {
    const event: SimulationEvent = {
      id: randomUUID(),
      sessionId: this.sessionId,
      tick: this.tick,
      gameDay,
      gameTime,
      type,
      actorNpcId,
      targetNpcId,
      location,
      data,
      timestamp: new Date(),
    };
    this.emit("simulation_event", event);
    return event;
  }

  actionsToEvents(
    actions: CharacterAction[],
    gameDay: number
  ): SimulationEvent[] {
    const events: SimulationEvent[] = [];
    for (const action of actions) {
      const type: SimulationEventType =
        action.status === "completed" ? "action_executed" : "action_failed";

      events.push(
        this.emitSimulationEvent(
          type,
          action.characterId,
          action.location,
          gameDay,
          action.gameTime,
          {
            action: action.action,
            actionType: action.actionType,
            outcome: action.outcome,
            successLevel: action.successLevel,
            discoveredClues: action.discoveredClues,
          },
          action.targetCharacterId
        )
      );
    }
    return events;
  }
}
```

**V1 event coverage note:** The `actionsToEvents` method emits `action_executed` and `action_failed`. Other event types (`encounter`, `relationship_changed`, `clue_discovered`, `plan_revised`, `memory_created`, `scene_updated`, `feature_triggered`) are side effects happening deep inside `executeSingleTick`. In v1, these are not emitted as separate events — they can be inferred from action data. Granular event emission can be added later by passing the emitter into `executeSingleTick` and calling it at each relevant point.

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/simulation/SimulationEventEmitter.ts
git commit -m "feat(simulation): add SimulationEventEmitter"
```

---

### Task 8: SimulationRunner

**Files:**
- Create: `src/dynamicworldagent/simulation/SimulationRunner.ts`

- [ ] **Step 1: Create SimulationRunner**

```typescript
// src/dynamicworldagent/simulation/SimulationRunner.ts

import type {
  SimulationConfig,
  SimulationEvent,
  SimulationState,
  SimulationStatus,
  StopReason,
} from "./types.js";
import { DEFAULT_TICK_INTERVAL_MS } from "./types.js";
import { SimulationEventEmitter } from "./SimulationEventEmitter.js";
import { runSimulationTick } from "../dynamicBasicAgent/npcPlanning/tickProcessor.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { NPCPlanningAgent } from "../dynamicBasicAgent/npcPlanning/NPCPlanningAgent.js";
import type { GameEngineRegistry } from "../engine/registry.js";
import type { ExecutionContext } from "../engine/types.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";

export class SimulationRunner {
  readonly sessionId: string;
  private config: SimulationConfig;
  private state: SimulationState;
  private ticksExecuted: number = 0;
  private stopReason?: StopReason;
  private intervalId?: ReturnType<typeof setInterval>;
  private tickInProgress: boolean = false;
  private shouldStop: boolean = false;
  private shouldPause: boolean = false;
  private deadNpcIds: Set<string> = new Set(); // track already-reported deaths

  private dgsm: DynamicGameStateManager;
  private npcPlanningAgent: NPCPlanningAgent;
  private registry: GameEngineRegistry;
  private ctx: ExecutionContext;
  private memoryManager?: NpcMemoryManager;
  private language: string;

  readonly events: SimulationEventEmitter;
  private collectedEvents: SimulationEvent[] = [];

  constructor(
    config: SimulationConfig,
    dgsm: DynamicGameStateManager,
    npcPlanningAgent: NPCPlanningAgent,
    registry: GameEngineRegistry,
    ctx: ExecutionContext,
    language: string = "en",
    memoryManager?: NpcMemoryManager
  ) {
    this.sessionId = config.sessionId;
    this.config = {
      ...config,
      tickIntervalMs: config.tickIntervalMs || DEFAULT_TICK_INTERVAL_MS,
    };
    this.state = "paused";
    this.dgsm = dgsm;
    this.npcPlanningAgent = npcPlanningAgent;
    this.registry = registry;
    this.ctx = ctx;
    this.language = language;
    this.memoryManager = memoryManager;
    this.events = new SimulationEventEmitter(config.sessionId);
  }

  getStatus(): SimulationStatus {
    const gameState = this.dgsm.getState();
    return {
      state: this.state,
      currentDay: gameState.gameDay,
      currentTime: gameState.timeOfDay,
      ticksExecuted: this.ticksExecuted,
      stopReason: this.stopReason,
    };
  }

  async start(): Promise<void> {
    if (this.state !== "paused") return;
    this.state = "running";
    this.shouldStop = false;
    this.shouldPause = false;
    this.emitStateChange("running");
    this.scheduleNextTick();
  }

  pause(): void {
    if (this.state !== "running") return;
    this.shouldPause = true;
    if (!this.tickInProgress && this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      this.state = "paused";
      this.shouldPause = false;
      this.emitStateChange("paused");
    }
  }

  async resume(): Promise<void> {
    return this.start();
  }

  async step(ticks: number = 1): Promise<SimulationEvent[]> {
    if (this.state !== "paused") return [];
    this.collectedEvents = [];

    for (let i = 0; i < ticks; i++) {
      if (this.state === "completed" || this.state === "stopped") break;
      await this.executeTick();
    }

    return this.collectedEvents;
  }

  stop(): void {
    this.shouldStop = true;
    if (!this.tickInProgress) {
      this.finalize("manual");
    }
  }

  private scheduleNextTick(): void {
    this.intervalId = setInterval(async () => {
      if (this.tickInProgress) return; // skip if previous tick still running
      await this.executeTick();

      if (this.shouldPause) {
        clearInterval(this.intervalId!);
        this.intervalId = undefined;
        this.state = "paused";
        this.shouldPause = false;
        this.emitStateChange("paused");
      }

      if (this.shouldStop) {
        this.finalize("manual");
      }
    }, this.config.tickIntervalMs);
  }

  private async executeTick(): Promise<void> {
    this.tickInProgress = true;
    this.ticksExecuted++;
    this.events.setTick(this.ticksExecuted);

    try {
      const result = await runSimulationTick({
        dgsm: this.dgsm,
        npcPlanningAgent: this.npcPlanningAgent,
        sessionId: this.config.sessionId,
        moduleId: this.config.moduleId,
        language: this.language,
        registry: this.registry,
        ctx: this.ctx,
        memoryManager: this.memoryManager,
      });

      // Convert actions to events
      const gameState = this.dgsm.getState();
      const tickEvents = this.events.actionsToEvents(
        result.actions,
        gameState.gameDay
      );
      this.collectedEvents.push(...tickEvents);

      // Handle day transition
      if (result.dayChanged) {
        const dayEvent = this.events.emitSimulationEvent(
          "day_transition",
          "system",
          "",
          gameState.gameDay,
          gameState.timeOfDay,
          { previousDay: gameState.gameDay - 1 }
        );
        this.collectedEvents.push(dayEvent);

        await this.npcPlanningAgent.onNewDay(
          this.dgsm,
          this.config.sessionId,
          this.config.moduleId,
          gameState.gameDay,
          this.language,
          this.registry
        );
      }

      // Check derived end conditions
      this.checkDerivedEvents(gameState.gameDay, gameState.timeOfDay);

      // Check end conditions
      if (
        this.config.maxDays &&
        gameState.gameDay > this.config.maxDays
      ) {
        this.finalize("max_days");
        return;
      }

      if (this.config.stopEvents?.length) {
        const triggered = tickEvents.find((e) =>
          this.config.stopEvents!.includes(e.type)
        );
        if (triggered) {
          this.finalize("event_triggered");
          return;
        }
      }
    } catch (error) {
      // Auto-pause on error
      this.state = "paused";
      this.emitStateChange("paused", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = undefined;
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  private checkDerivedEvents(gameDay: number, gameTime: string): void {
    const state = this.dgsm.getState();

    // Check NPC deaths — npcCharacters is an array, not an object
    // Track already-reported deaths to avoid emitting npc_death every tick
    for (const npc of state.npcCharacters ?? []) {
      if (
        npc.status?.hp !== undefined &&
        npc.status.hp <= 0 &&
        !this.deadNpcIds.has(npc.id)
      ) {
        this.deadNpcIds.add(npc.id);
        const event = this.events.emitSimulationEvent(
          "npc_death",
          npc.id,
          "",
          gameDay,
          gameTime,
          { npcName: npc.name }
        );
        this.collectedEvents.push(event);
      }
    }

    // Check all clues discovered — collect from scenes Map + NPC clues
    const sceneClues = [...(state.scenes?.values() ?? [])].flatMap(
      (s) => s.clues ?? []
    );
    const npcClues = (state.npcCharacters ?? []).flatMap(
      (n) => n.clues ?? []
    );
    const totalClueCount = sceneClues.length + npcClues.length;
    const discoveredCount = (state.discoveredClues ?? []).length;
    if (totalClueCount > 0 && discoveredCount >= totalClueCount) {
      const event = this.events.emitSimulationEvent(
        "all_clues_discovered",
        "system",
        "",
        gameDay,
        gameTime,
        { totalClues: totalClueCount }
      );
      this.collectedEvents.push(event);
    }
  }

  private finalize(reason: StopReason): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.stopReason = reason;
    this.state = reason === "manual" ? "stopped" : "completed";
    this.emitStateChange(this.state, { stopReason: reason });
  }

  private emitStateChange(
    newState: string,
    extra: Record<string, unknown> = {}
  ): void {
    const gameState = this.dgsm.getState();
    this.events.emitSimulationEvent(
      "simulation_state_changed",
      "system",
      "",
      gameState.gameDay,
      gameState.timeOfDay,
      { state: newState, ...extra }
    );
  }
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/simulation/SimulationRunner.ts
git commit -m "feat(simulation): add SimulationRunner with lifecycle and end conditions"
```

---

## Chunk 4: Simulation Service + API

### Task 9: Simulation Service

**Files:**
- Create: `client/server/simulation/service.ts`

- [ ] **Step 1: Create service**

This service manages the in-memory `Map<sessionId, SimulationRunner>` and handles session creation, module loading, and runner lifecycle.

```typescript
// client/server/simulation/service.ts

import { PrismaClient } from "@prisma/client";
import { SimulationRunner } from "../../../src/dynamicworldagent/simulation/SimulationRunner.js";
import type {
  SimulationConfig,
  SimulationEvent,
  SimulationStatus,
} from "../../../src/dynamicworldagent/simulation/types.js";
import { DEFAULT_TICK_INTERVAL_MS } from "../../../src/dynamicworldagent/simulation/types.js";

// Reference: follow patterns from client/server/game/ for module loading and state init

const runners = new Map<string, SimulationRunner>();

export function getRunner(sessionId: string): SimulationRunner | undefined {
  return runners.get(sessionId);
}

export function listSimulations(): (SimulationStatus & { sessionId: string })[] {
  return Array.from(runners.entries()).map(([sessionId, runner]) => ({
    sessionId,
    ...runner.getStatus(),
  }));
}

export async function createSimulation(
  prisma: PrismaClient,
  moduleName: string,
  config?: Partial<SimulationConfig>
): Promise<{ sessionId: string; status: SimulationStatus }> {
  // 1. Create session with sessionType: "simulation"
  // 2. Load module via existing ModuleLoader
  // 3. Load NPCs via NPCLoader
  // 4. Load scenarios via ScenarioLoader
  // 5. Init DynamicGameState (no playerCharacter)
  // 6. Inject long-term intents from module data (or fall back to LLM generation)
  // 7. Inject day-1 schedules from module data (or fall back to LLM generation)
  // 8. Create SimulationRunner
  // 9. Register event listener to persist events to DB
  // 10. Store runner in map

  // Implementation depends on how game init is structured in client/server/game/
  // Follow the same pattern but skip player character creation and auth

  throw new Error("TODO: implement createSimulation — follow game init pattern");
}

export async function startSimulation(sessionId: string): Promise<void> {
  const runner = runners.get(sessionId);
  if (!runner) throw new Error(`Simulation ${sessionId} not found`);
  await runner.start();
}

export function pauseSimulation(sessionId: string): void {
  const runner = runners.get(sessionId);
  if (!runner) throw new Error(`Simulation ${sessionId} not found`);
  runner.pause();
}

export async function resumeSimulation(sessionId: string): Promise<void> {
  const runner = runners.get(sessionId);
  if (!runner) throw new Error(`Simulation ${sessionId} not found`);
  await runner.resume();
}

export async function stepSimulation(
  sessionId: string,
  ticks: number = 1
): Promise<SimulationEvent[]> {
  const runner = runners.get(sessionId);
  if (!runner) throw new Error(`Simulation ${sessionId} not found`);
  return runner.step(ticks);
}

export function stopSimulation(sessionId: string): void {
  const runner = runners.get(sessionId);
  if (!runner) throw new Error(`Simulation ${sessionId} not found`);
  runner.stop();
  runners.delete(sessionId);
}

export async function getSimulationEvents(
  prisma: PrismaClient,
  sessionId: string,
  filters?: {
    type?: string;
    npcId?: string;
    day?: number;
    fromTime?: string;
    toTime?: string;
  }
): Promise<SimulationEvent[]> {
  const where: Record<string, unknown> = { sessionId };
  if (filters?.type) where.type = filters.type;
  if (filters?.npcId) where.actorNpcId = filters.npcId;
  if (filters?.day) where.gameDay = filters.day;

  const rows = await prisma.simulationEvent.findMany({
    where,
    orderBy: { timestamp: "asc" },
  });

  return rows as unknown as SimulationEvent[];
}
```

Note: `createSimulation` is left as a TODO stub because it depends on understanding the exact game init flow (module loading, state initialization). The implementer should follow the pattern in `client/server/game/` and adapt it for simulation (no player, no auth).

- [ ] **Step 2: Commit**

```bash
git add client/server/simulation/service.ts
git commit -m "feat(simulation): add simulation service layer"
```

---

### Task 10: Simulation Controller

**Files:**
- Create: `client/server/simulation/controller.ts`

- [ ] **Step 1: Create controller**

```typescript
// client/server/simulation/controller.ts

import type { Request, Response } from "express";
import * as simulationService from "./service.js";
import { DatabaseManager } from "../core/DatabaseManager.js";

export async function createSimulation(req: Request, res: Response) {
  try {
    const { moduleName, config } = req.body;
    if (!moduleName) {
      return res.status(400).json({ error: "moduleName is required" });
    }
    const prisma = DatabaseManager.getInstance().getPrisma();
    const result = await simulationService.createSimulation(
      prisma,
      moduleName,
      config
    );
    return res.status(201).json(result);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function startSimulation(req: Request, res: Response) {
  try {
    await simulationService.startSimulation(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export function pauseSimulation(req: Request, res: Response) {
  try {
    simulationService.pauseSimulation(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export async function resumeSimulation(req: Request, res: Response) {
  try {
    await simulationService.resumeSimulation(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export async function stepSimulation(req: Request, res: Response) {
  try {
    const ticks = req.body?.ticks ?? 1;
    const events = await simulationService.stepSimulation(req.params.id, ticks);
    return res.json({ success: true, events });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export function stopSimulation(req: Request, res: Response) {
  try {
    simulationService.stopSimulation(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(404).json({
      error: error instanceof Error ? error.message : "Not found",
    });
  }
}

export function getStatus(req: Request, res: Response) {
  try {
    const runner = simulationService.getRunner(req.params.id);
    if (!runner) {
      return res.status(404).json({ error: "Simulation not found" });
    }
    return res.json(runner.getStatus());
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function getEvents(req: Request, res: Response) {
  try {
    const prisma = DatabaseManager.getInstance().getPrisma();
    const events = await simulationService.getSimulationEvents(
      prisma,
      req.params.id,
      {
        type: req.query.type as string | undefined,
        npcId: req.query.npcId as string | undefined,
        day: req.query.day ? parseInt(req.query.day as string) : undefined,
      }
    );
    return res.json({ events });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export function listSimulations(_req: Request, res: Response) {
  const simulations = simulationService.listSimulations();
  return res.json({ simulations });
}
```

- [ ] **Step 2: Commit**

```bash
git add client/server/simulation/controller.ts
git commit -m "feat(simulation): add simulation controller"
```

---

### Task 11: Simulation Routes

**Files:**
- Create: `client/server/simulation/routes.ts`
- Modify: `client/server.ts`

- [ ] **Step 1: Create routes**

```typescript
// client/server/simulation/routes.ts

import { Router } from "express";
import * as simulationController from "./controller.js";

const router = Router();

// No authentication — simulation mode is open
router.post("/simulation", simulationController.createSimulation);
router.post("/simulation/:id/start", simulationController.startSimulation);
router.post("/simulation/:id/pause", simulationController.pauseSimulation);
router.post("/simulation/:id/resume", simulationController.resumeSimulation);
router.post("/simulation/:id/step", simulationController.stepSimulation);
router.post("/simulation/:id/stop", simulationController.stopSimulation);
router.get("/simulation/:id/status", simulationController.getStatus);
router.get("/simulation/:id/events", simulationController.getEvents);
router.get("/simulations", simulationController.listSimulations);

export default router;
```

- [ ] **Step 2: Mount routes in server.ts**

In `client/server.ts`, import and mount the simulation routes alongside existing routes:

```typescript
import simulationRoutes from "./server/simulation/routes.js";
// ...
app.use("/api", simulationRoutes);
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add client/server/simulation/routes.ts client/server.ts
git commit -m "feat(simulation): add REST API routes"
```

---

## Chunk 5: WebSocket + Event Persistence

### Task 12: WebSocket for simulation events

**Files:**
- Modify: `client/server/websocket/WebSocketManager.ts`

- [ ] **Step 1: Add simulation client map**

In `WebSocketManager`, add a new client map alongside the existing ones. Use `WSClient` (not raw `WebSocket`) to stay consistent with existing maps:

```typescript
private simulationClients: Map<string, Map<string, WSClient>> = new Map();
```

- [ ] **Step 2: Add register/remove methods**

```typescript
registerSimulationClient(sessionId: string, clientId: string, client: WSClient): void {
  if (!this.simulationClients.has(sessionId)) {
    this.simulationClients.set(sessionId, new Map());
  }
  this.simulationClients.get(sessionId)!.set(clientId, client);
}

removeSimulationClient(sessionId: string, clientId: string): void {
  const clients = this.simulationClients.get(sessionId);
  if (clients) {
    clients.delete(clientId);
    if (clients.size === 0) this.simulationClients.delete(sessionId);
  }
}

getSimulationClients(sessionId: string): Map<string, WSClient> {
  return this.simulationClients.get(sessionId) ?? new Map();
}
```

- [ ] **Step 3: Handle simulation WebSocket connections**

In the WebSocket connection handler (`setupConnectionHandling`), add the simulation branch **BEFORE** the auth check (lines ~55-58), since simulation mode has no auth:

```typescript
// At the top of the connection handler, before auth validation:
const type = request.url ? new URL(request.url, "http://localhost").searchParams.get("type") : null;

if (type === "simulation" && sessionId) {
  const clientId = randomUUID();
  const client: WSClient = { ws, sessionId, lastHeartbeat: new Date() };
  this.registerSimulationClient(sessionId, clientId, client);
  ws.on("close", () => this.removeSimulationClient(sessionId, clientId));
  return; // Skip normal auth flow
}

// ... existing auth check follows
```

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add client/server/websocket/WebSocketManager.ts
git commit -m "feat(simulation): add WebSocket support for simulation events"
```

---

### Task 13: Wire event persistence and WebSocket broadcasting

**Files:**
- Modify: `client/server/simulation/service.ts`

- [ ] **Step 1: Add event persistence helper**

In `service.ts`, add a function to persist events and broadcast via WebSocket:

```typescript
import { WebSocketManager } from "../websocket/WebSocketManager.js";

function wireEventListener(
  sessionId: string,
  runner: SimulationRunner,
  prisma: PrismaClient
): void {
  runner.events.on("simulation_event", async (event: SimulationEvent) => {
    // Persist to DB
    try {
      await prisma.simulationEvent.create({
        data: {
          id: event.id,
          sessionId: event.sessionId,
          tick: event.tick,
          gameDay: event.gameDay,
          gameTime: event.gameTime,
          type: event.type,
          actorNpcId: event.actorNpcId,
          targetNpcId: event.targetNpcId,
          location: event.location,
          data: event.data,
          timestamp: event.timestamp,
        },
      });
    } catch (err) {
      console.error("[simulation] Failed to persist event:", err);
    }

    // Broadcast via WebSocket
    const wsManager = WebSocketManager.getInstance();
    if (wsManager) {
      const clients = wsManager.getSimulationClients(sessionId);
      const message = JSON.stringify(event);
      for (const [, client] of clients) {
        if (client.ws.readyState === client.ws.OPEN) {
          client.ws.send(message);
        }
      }
    }
  });
}
```

This function should be called in `createSimulation` after creating the runner:

```typescript
wireEventListener(sessionId, runner, prisma);
runners.set(sessionId, runner);
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add client/server/simulation/service.ts
git commit -m "feat(simulation): wire event persistence and WebSocket broadcast"
```

---

## Chunk 6: Integration Test + Verification

### Task 14: Manual integration verification

- [ ] **Step 1: Build the full project**

Run: `pnpm build`
Expected: Clean build, no type errors.

- [ ] **Step 2: Verify Prisma schema is in sync**

Run: `npx prisma db push`
Expected: Schema is already in sync (or applies cleanly).

- [ ] **Step 3: Verify existing game flow is unbroken**

Run: `pnpm chat:dev`
Start a regular player game. Verify that:
- Game init works normally
- Player turns execute without errors
- NPC actions still fire during player turns

The `playerCharacter` change to optional should have no effect on the player game flow since it always provides a player character.

- [ ] **Step 4: Test simulation API (manual)**

With the server running, test the simulation endpoints:

```bash
# Create simulation
curl -X POST http://localhost:3000/api/simulation \
  -H "Content-Type: application/json" \
  -d '{"moduleName": "<your-module-name>"}'

# Check status
curl http://localhost:3000/api/simulation/<sessionId>/status

# Step one tick
curl -X POST http://localhost:3000/api/simulation/<sessionId>/step \
  -H "Content-Type: application/json" \
  -d '{"ticks": 1}'

# List events
curl http://localhost:3000/api/simulation/<sessionId>/events
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(simulation): NPC autonomous simulation system"
```
