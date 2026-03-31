# Tick Engine Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the tick/bucket two-layer model with a single tick-based execution model, make impact a core engine concept, and give features configurable tick intervals.

**Architecture:** Tick is the minimum world simulation unit (default 5 min). Player action triggers N ticks. Features declare `tickInterval` (how many ticks between settlements) and `impactScope`. Impact propagation is a shared engine utility. The old `runTick`/`resumeTick`/bucket logic is replaced by a `runPlayerAction` outer loop that drives individual ticks.

**Tech Stack:** TypeScript, LangGraph, existing engine/handler/feature infrastructure

---

### Task 1: Extract impact propagation to shared engine utility

**Files:**
- Create: `src/dynamicworldagent/engine/shared/impactPropagation.ts`
- Modify: `src/dynamicworldagent/engine/shared/index.ts`

**Step 1: Create `impactPropagation.ts`**

Extract the impact propagation logic (currently in `impactGateFeature.ts` lines 10-44 and 126-177) into a shared utility. This is pure spatial computation — no NPC planning calls.

```typescript
// src/dynamicworldagent/engine/shared/impactPropagation.ts
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { TransportEdge } from "../../world_builder/types.js";

const NEIGHBORHOOD_TRAVEL_MINUTES = 15;

function findNeighborMacroLocations(
  fromLocationId: string,
  transportEdges: TransportEdge[],
  maxTravelMinutes: number
): string[] {
  const visited = new Map<string, number>();
  visited.set(fromLocationId, 0);
  const queue: Array<{ locationId: string; travelTime: number }> = [
    { locationId: fromLocationId, travelTime: 0 },
  ];
  while (queue.length > 0) {
    const { locationId, travelTime } = queue.shift()!;
    for (const edge of transportEdges) {
      let neighbor: string | null = null;
      if (edge.fromLocationId === locationId) neighbor = edge.toLocationId;
      else if (edge.toLocationId === locationId) neighbor = edge.fromLocationId;
      if (!neighbor) continue;
      const newTime = travelTime + edge.travelTimeMinutes;
      if (newTime > maxTravelMinutes) continue;
      if (visited.has(neighbor) && visited.get(neighbor)! <= newTime) continue;
      visited.set(neighbor, newTime);
      queue.push({ locationId: neighbor, travelTime: newTime });
    }
  }
  visited.delete(fromLocationId);
  return [...visited.keys()];
}

function getParentLocationId(
  sceneId: string,
  dgsm: DynamicGameStateManager
): string | null {
  const scene = dgsm.getScene(sceneId);
  return scene?.parentLocationId ?? null;
}

/**
 * Find all characters affected by an action at a given impact level.
 * Returns Map<characterId, perceivedImpactLevel>.
 * Excludes the acting character itself.
 */
export function findAffectedCharacters(
  action: CharacterAction,
  impactLevel: number,
  dgsm: DynamicGameStateManager
): Map<string, number> {
  const state = dgsm.getState();
  const playerScene = state.currentSceneId;
  const playerId = state.playerCharacter?.id;

  const result = new Map<string, number>();

  const addChar = (charId: string, level: number) => {
    if (charId === action.characterId) return;
    const existing = result.get(charId);
    if (existing === undefined || level > existing) {
      result.set(charId, level);
    }
  };

  const allCharacterIds = [
    ...state.npcCharacters.map((n) => n.id),
    ...(playerId ? [playerId] : []),
  ];

  const getCharLocation = (charId: string): string | undefined => {
    if (charId === playerId) return playerScene ?? undefined;
    return dgsm.getNpcLocation(charId);
  };

  // Level 1: targeted
  if (impactLevel >= 1 && action.targetCharacterId) {
    addChar(action.targetCharacterId, 1);
  }

  // Level 2: same sub-scene
  if (impactLevel >= 2) {
    for (const charId of allCharacterIds) {
      if (getCharLocation(charId) === action.location) {
        addChar(charId, 2);
      }
    }
  }

  // Level 3: same macro location
  if (impactLevel >= 3) {
    const eventParent = getParentLocationId(action.location, dgsm);
    if (eventParent) {
      for (const charId of allCharacterIds) {
        const charLoc = getCharLocation(charId);
        if (charLoc && getParentLocationId(charLoc, dgsm) === eventParent) {
          addChar(charId, 3);
        }
      }
    }
  }

  // Level 4: neighborhood
  if (impactLevel >= 4) {
    const eventParent = getParentLocationId(action.location, dgsm);
    if (eventParent && state.transportEdges) {
      const neighbors = findNeighborMacroLocations(eventParent, state.transportEdges, NEIGHBORHOOD_TRAVEL_MINUTES);
      for (const charId of allCharacterIds) {
        const charLoc = getCharLocation(charId);
        if (charLoc) {
          const charParent = getParentLocationId(charLoc, dgsm);
          if (charParent && neighbors.includes(charParent)) {
            addChar(charId, 4);
          }
        }
      }
    }
  }

  // Level 5: global
  if (impactLevel >= 5) {
    for (const charId of allCharacterIds) {
      addChar(charId, 5);
    }
  }

  return result;
}

/**
 * Find all scene IDs affected by an event at a given scope level.
 */
export function findAffectedScenes(
  sourceSceneId: string,
  scopeLevel: number,
  dgsm: DynamicGameStateManager
): string[] {
  const state = dgsm.getState();
  const scenes = new Set<string>();

  // Level 2: same scene
  if (scopeLevel >= 2) {
    scenes.add(sourceSceneId);
  }

  // Level 3: same macro location
  if (scopeLevel >= 3) {
    const parent = getParentLocationId(sourceSceneId, dgsm);
    if (parent) {
      for (const [id, scene] of state.scenes) {
        if (scene.parentLocationId === parent) scenes.add(id);
      }
    }
  }

  // Level 4: neighborhood
  if (scopeLevel >= 4) {
    const parent = getParentLocationId(sourceSceneId, dgsm);
    if (parent && state.transportEdges) {
      const neighbors = findNeighborMacroLocations(parent, state.transportEdges, NEIGHBORHOOD_TRAVEL_MINUTES);
      for (const [id, scene] of state.scenes) {
        if (scene.parentLocationId && neighbors.includes(scene.parentLocationId)) {
          scenes.add(id);
        }
      }
    }
  }

  // Level 5: global
  if (scopeLevel >= 5) {
    for (const id of state.scenes.keys()) {
      scenes.add(id);
    }
  }

  return [...scenes];
}
```

**Step 2: Export from shared/index.ts**

Add to `src/dynamicworldagent/engine/shared/index.ts`:
```typescript
export * from "./impactPropagation.js";
```

**Step 3: Build**

Run: `pnpm build`
Expected: 177 files compiled successfully


---

### Task 2: Update `engine/types.ts` — new WorldFeature interface

**Files:**
- Modify: `src/dynamicworldagent/engine/types.ts`

**Step 1: Rewrite the WorldFeature interface and related types**

Replace the entire WorldFeature section (lines 29-107) with:

```typescript
// ===== World Feature: self-running world system =====

/** Result returned by WorldFeature.onTickEnd */
export interface WorldFeatureResult {
  /** New PlanNodes to inject into subsequent ticks */
  newNodes?: PlanNode[];
  /** Player witness events (for interrupt handling) */
  playerEvents?: Array<{ event: CharacterAction; impact: number }>;
}

/** Minimal interface for NPC planning capabilities needed by WorldFeatures */
export interface NpcPlanningCapability {
  getLongTermIntent(sessionId: string, npcId: string): Promise<string>;
  getPendingNodes(sessionId: string, npcId: string, gameDay: number): Promise<PlanNode[]>;
  runImpactGateForNpc(
    candidate: {
      npcId: string;
      npcName: string;
      currentLocation: string;
      longTermIntent: string;
      pendingNodesSummary: string;
      triggeringEvents: string;
    },
    bucketTime: string,
    language: string
  ): Promise<{ shouldRevise: boolean; witnessEntry: string }>;
  appendMemoryLog(
    sessionId: string, npcId: string, entry: string,
    gameDay: number, gameTime: string, location: string
  ): Promise<void>;
  getMemoryLog(sessionId: string, npcId: string, gameDay?: number): Promise<string[]>;
  revisePlans(
    dgsm: DynamicGameStateManager, sessionId: string, npcId: string,
    context: RevisePlansContext, language: string
  ): Promise<void>;
}

/** Runtime dependencies passed to WorldFeature hooks */
export interface TickRuntimeContext {
  sessionId: string;
  gameDay: number;
  language: string;
  /** Current tick's time label (HH:MM) */
  tickTime: string;
  /** Duration of this tick in minutes (usually 5, can be less for final tick) */
  tickDurationMinutes: number;
  npcPlanning: NpcPlanningCapability;
}

export interface WorldFeature {
  /** Unique identifier */
  id: string;

  /** Human-readable description */
  description: string;

  /** How many full ticks between settlements (1 = every tick, 2 = every 10 min) */
  tickInterval: number;

  /**
   * Spatial scope of this feature's effects.
   * A number (0-5) uses the impact level scale.
   * "dynamic" means scope follows each action's own impact level.
   */
  impactScope: number | "dynamic";

  /**
   * Static prompt section describing this feature's effects.
   * Injected into the planning agent prompt. Should NOT describe impact levels
   * (those are handled by the engine). Return "" to omit.
   */
  planningPrompt: string;

  /** Generate current state description for LLM context. Return "" to omit. */
  stateDescription(dgsm: DynamicGameStateManager): string;

  /** Called at tick end. Receives all actions from this tick. */
  onTickEnd(
    tickActions: CharacterAction[],
    dgsm: DynamicGameStateManager,
    runtime: TickRuntimeContext
  ): Promise<WorldFeatureResult>;
}
```

Key changes from current:
- Remove `conditionTypes`, `onTickStart`, `onBucketEnd`
- Add `tickInterval`, `impactScope`
- Single `onTickEnd` hook (was `onBucketEnd`)
- `TickRuntimeContext` gains `tickTime` and `tickDurationMinutes`
- `WorldFeatureResult` comments updated (buckets → ticks)

**Step 2: Build**

Run: `pnpm build`
Expected: Build succeeds (feature implementations will break but SWC doesn't check types)

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/types.ts
git commit -m "feat: update WorldFeature interface for single-tick model"
```

---

### Task 3: Add `buildImpactPrompt()` to registry

**Files:**
- Modify: `src/dynamicworldagent/engine/registry.ts`

**Step 1: Add tick counter state and impact prompt generation**

Add to `GameEngineRegistry`:

```typescript
// New private state
private featureTickCounters = new Map<string, number>();

/** Reset all feature tick counters (call at session start) */
resetTickCounters(): void {
  this.featureTickCounters.clear();
}

/** Increment tick counter for a feature, return true if feature should fire this tick */
shouldFeatureFire(featureId: string, isFullTick: boolean): boolean {
  if (!isFullTick) return false;
  const current = (this.featureTickCounters.get(featureId) ?? 0) + 1;
  this.featureTickCounters.set(featureId, current);
  const feature = this.features.get(featureId);
  if (!feature) return false;
  return current % feature.tickInterval === 0;
}

/** Generate the impact level prompt (engine-owned, not feature-owned) */
buildImpactPrompt(): string {
  return `## Impact Levels

The \`impact\` field on every PlanNode determines **who in the game world perceives and reacts to** the action. The tick engine propagates events outward based on this level:

- **0 — Private / unnoticed**: Only the acting character knows. No one else perceives or reacts.
  Examples: thinking, reading alone, checking belongings, observing from afar, writing notes, resting
- **1 — Targeted / one-on-one**: Only the specific target character perceives it. A private exchange.
  Examples: whispering, passing a note, pickpocketing someone, private conversation, discreet item handoff
- **2 — Sub-scene / room-wide**: Everyone in the current room or sub-scene perceives it. Visible/audible to bystanders.
  Examples: speaking loudly, firing a gun, breaking a door, starting a fight, searching a room openly, screaming
- **3 — Building / macro-location-wide**: Everyone in the same building or macro location perceives it (all rooms/floors).
  Examples: fire alarm, shouting down a stairwell, smoke filling the building, event audible throughout
- **4 — Neighborhood**: Perceived at the current building and nearby buildings within walking distance.
  Examples: explosion heard across the block, gunshot echoing, building collapse, large fire
- **5 — Global / far-reaching**: The entire game world is affected. Consequences ripple everywhere.
  Examples: triggering a town alarm, summoning ritual, radio broadcast, earthquake

**Required field:** \`"impact": 0|1|2|3|4|5\` on every PlanNode.`;
}
```

Also remove the old `buildFeaturePlanningPrompt` and replace with one that combines impact + features:

```typescript
/** Auto-generate full planning prompt: impact levels + all feature prompts */
buildPlanningPrompt(): string {
  const sections: string[] = [this.buildImpactPrompt()];
  for (const feature of this.features.values()) {
    if (feature.planningPrompt) {
      sections.push(feature.planningPrompt);
    }
  }
  return sections.join("\n\n");
}
```

**Step 2: Build**

Run: `pnpm build`

---

### Task 4: Update ImpactGateFeature to new interface

**Files:**
- Modify: `src/dynamicworldagent/engine/features/impactGateFeature.ts`

**Step 1: Rewrite to use new WorldFeature interface and shared propagation utility**

Key changes:
- Remove inline `findNeighborMacroLocations`, `getParentLocationId` (now in shared)
- Remove impact level descriptions from `planningPrompt` (now in registry)
- Change `onBucketEnd` → `onTickEnd`
- Remove `conditionTypes`, `onTickStart`
- Add `tickInterval: 1`, `impactScope: "dynamic"`
- Use `findAffectedCharacters` from shared utility

```typescript
import type { WorldFeature, WorldFeatureResult, TickRuntimeContext } from "../types.js";
import type { CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { findAffectedCharacters } from "../shared/impactPropagation.js";

export class ImpactGateFeature implements WorldFeature {
  id = "impact_gate";
  description = "Impact propagation: high-impact actions alert nearby NPCs who may revise plans";
  tickInterval = 1;
  impactScope = "dynamic" as const;
  planningPrompt = "";  // Impact levels described by engine, not this feature

  stateDescription(_dgsm: DynamicGameStateManager): string {
    return "";
  }

  async onTickEnd(
    tickActions: CharacterAction[],
    dgsm: DynamicGameStateManager,
    runtime: TickRuntimeContext
  ): Promise<WorldFeatureResult> {
    const impactEvents = tickActions.filter((a) => a.impact > 0);
    if (impactEvents.length === 0) return {};

    const state = dgsm.getState();
    const { sessionId, gameDay, language, tickTime, npcPlanning } = runtime;
    const playerId = state.playerCharacter?.id;

    // Aggregate affected characters across all impact events
    const characterEventsMap = new Map<string, Array<{ event: CharacterAction; impact: number }>>();

    for (const event of impactEvents) {
      const affected = findAffectedCharacters(event, event.impact, dgsm);
      for (const [charId, level] of affected) {
        if (!characterEventsMap.has(charId)) characterEventsMap.set(charId, []);
        const existing = characterEventsMap.get(charId)!;
        const idx = existing.findIndex((e) => e.event === event);
        if (idx >= 0) {
          if (level > existing[idx].impact) existing[idx].impact = level;
        } else {
          existing.push({ event, impact: level });
        }
      }
    }

    // Separate player events
    const playerEvents = playerId ? characterEventsMap.get(playerId) : undefined;
    if (playerId) characterEventsMap.delete(playerId);

    // NPC processing — parallel LLM calls
    if (characterEventsMap.size > 0) {
      await Promise.all(
        [...characterEventsMap.entries()].map(async ([npcId, npcEvents]) => {
          const npc = state.npcCharacters.find((n) => n.id === npcId);
          const longTermIntent = await npcPlanning.getLongTermIntent(sessionId, npcId);
          const pendingNodes = await npcPlanning.getPendingNodes(sessionId, npcId, gameDay);
          const triggeringEvents = npcEvents
            .map((e) => `[impact ${e.impact}] ${e.event.characterName}: ${e.event.outcome}`)
            .join("\n");

          const result = await npcPlanning.runImpactGateForNpc(
            {
              npcId,
              npcName: npc?.name ?? npcId,
              currentLocation: dgsm.getNpcLocation(npcId) ?? "unknown",
              longTermIntent,
              pendingNodesSummary: pendingNodes.map((n) => `${n.gameTime} ${n.action}`).join("; "),
              triggeringEvents,
            },
            tickTime,
            language
          );

          const logEntry = `Day${gameDay} ${tickTime} [witness] - ${result.witnessEntry}`;
          const npcLoc = dgsm.getNpcLocation(npcId) ?? "unknown";
          await npcPlanning.appendMemoryLog(sessionId, npcId, logEntry, gameDay, tickTime, npcLoc);

          if (result.shouldRevise) {
            const memoryLog = await npcPlanning.getMemoryLog(sessionId, npcId, gameDay);
            const sortedEvents = [...npcEvents].sort((a, b) => b.impact - a.impact);
            await npcPlanning.revisePlans(dgsm, sessionId, npcId, {
              longTermIntent,
              memoryLog,
              pendingNodes,
              trigger: {
                type: "impact",
                triggeringAction: sortedEvents[0].event,
              },
            }, language);
          }
        })
      );
    }

    return { playerEvents: playerEvents ?? undefined };
  }
}
```

**Step 2: Build**

Run: `pnpm build`


---

### Task 5: Rewrite tickProcessor.ts — single tick model

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

This is the largest task. The old `runTick`/`resumeTick` with bucket logic is replaced by:
- `executeSingleTick()` — executes one 5-min tick (fetch NPC nodes, execute, fire features)
- `runPlayerAction()` — outer loop that drives N ticks for a player action

**Step 1: Replace time helpers**

Remove `minutesToBucket`. Keep `timeToMinutes` and rename `getBucketLabel` → `minutesToTimeLabel`.

```typescript
function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTimeLabel(minutes: number): string {
  const clamped = Math.min(minutes, 1439);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const TICK_DURATION_MINUTES = 5;
```

**Step 2: Write `executeSingleTick()`**

Core single-tick function. Handles:
- Fetch NPC nodes for this tick's time window
- Merge with player nodes in range
- Sort and execute
- Fire eligible features via `registry.shouldFeatureFire()`
- Return tick result with possible player events

```typescript
interface SingleTickParams {
  tickStartMinutes: number;
  tickDurationMinutes: number;
  playerNodes: PlanNode[];
  dgsm: DynamicGameStateManager;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  language: string;
  registry: GameEngineRegistry;
  ctx: ExecutionContext;
}

interface SingleTickResult {
  actions: CharacterAction[];
  playerFailed: boolean;
  playerEvents: PlayerWitnessEvent[];
  /** New nodes injected by features for subsequent ticks */
  injectedNodes: PlanNode[];
}

async function executeSingleTick(params: SingleTickParams): Promise<SingleTickResult> {
  const {
    tickStartMinutes, tickDurationMinutes,
    playerNodes, dgsm, npcPlanningAgent,
    sessionId, language, registry, ctx
  } = params;

  const state = dgsm.getState();
  const gameDay = state.gameDay;
  const tickEndMinutes = tickStartMinutes + tickDurationMinutes;
  const tickStartTime = minutesToTimeLabel(tickStartMinutes);
  const tickEndTime = minutesToTimeLabel(tickEndMinutes - 1); // inclusive end
  const isFullTick = tickDurationMinutes >= TICK_DURATION_MINUTES;

  const tickRuntime: TickRuntimeContext = {
    sessionId, gameDay, language,
    tickTime: tickStartTime,
    tickDurationMinutes,
    npcPlanning: npcPlanningAgent,
  };

  // 1. Fetch NPC nodes for this tick's window
  const dueNpcNodes = await npcPlanningAgent.getDueNpcNodes(
    sessionId, gameDay, tickEndTime, dgsm
  );
  // Filter to only nodes >= tickStartTime
  const tickNpcNodes = dueNpcNodes.filter(
    (n) => timeToMinutes(n.gameTime) >= tickStartMinutes
  );

  // 2. Filter player nodes in range
  const tickPlayerNodes = playerNodes.filter((n) => {
    const t = timeToMinutes(n.gameTime);
    return t >= tickStartMinutes && t < tickEndMinutes;
  });

  // 3. Merge, sort, scan encounters
  const allNodes: PlanNode[] = [...tickNpcNodes, ...tickPlayerNodes];
  allNodes.sort((a, b) => {
    const timeDiff = a.gameTime.localeCompare(b.gameTime);
    if (timeDiff !== 0) return timeDiff;
    const npcA = state.npcCharacters.find((n) => n.id === a.characterId);
    const npcB = state.npcCharacters.find((n) => n.id === b.characterId);
    return (npcB?.attributes?.DEX ?? 50) - (npcA?.attributes?.DEX ?? 50);
  });
  scanUnplannedEncounters(allNodes, dgsm);

  // 4. Execute all nodes
  const tickActions: CharacterAction[] = [];
  let playerFailed = false;

  for (const node of allNodes) {
    if (playerFailed && node.isPlayer) continue;

    const handler = registry.getHandler(node.type);
    if (!handler) {
      console.warn(`[TickProcessor] No handler for node type: ${node.type}, skipping`);
      continue;
    }
    const action = handler.execute(node, dgsm, ctx);
    tickActions.push(action);

    if (action.status === "failed" && node.isPlayer) {
      playerFailed = true;
    }

    // === Post-execution processing (same as current) ===

    // Relationship update
    let relationshipChange: string | undefined;
    if (action.status === "completed" && node.type === "character_interaction" && node.targetCharacterId) {
      const relResult = await npcPlanningAgent.updateRelationshipViaLLM(
        dgsm, node.characterId, node.targetCharacterId, action.outcome, language
      );
      if (relResult) {
        const sign = relResult.scoreDelta >= 0 ? "+" : "";
        relationshipChange = `[relationship ${sign}${relResult.scoreDelta} → ${relResult.newScore}, ${relResult.note}]`;
      }
    }

    // NPC logging
    if (!node.isPlayer) {
      let logEntry = `Day${gameDay} ${action.gameTime} [${action.location}] - ${action.outcome}`;
      if (relationshipChange) logEntry += ` ${relationshipChange}`;
      await npcPlanningAgent.appendMemoryLog(sessionId, node.characterId, logEntry, gameDay, action.gameTime, action.location);
      await npcPlanningAgent.markNodeCompleted(sessionId, node.characterId, gameDay, node.nodeId, action.outcome);
    }

    // Player clue discovery
    if (action.status === "completed" && node.isPlayer) {
      const effectiveSuccess: SuccessLevel = action.successLevel ?? "regular";
      const clues = await discoverClues(node, effectiveSuccess, dgsm, language);
      if (clues.length > 0) {
        action.discoveredClues = clues;
        embedDiscoveredClues(clues, dgsm, language as "en" | "zh");
        for (const entry of clues) {
          if (entry.source === "scene") dgsm.markScenarioClueDiscovered(entry.clueId, node.characterName);
          else if (entry.source === "npc") dgsm.markNpcClueRevealed(entry.sourceId, entry.clueId);
          dgsm.addDiscoveredClue({
            text: entry.clueText,
            type: entry.source === "scene" ? "scenario" : entry.clueId.includes("_secret_") ? "secret" : "npc",
            sourceName: entry.sourceName,
            discoveredBy: node.characterName,
            discoveredAt: new Date().toISOString(),
            difficulty: entry.difficulty,
            method: node.action,
          });
        }
      }
    }

    // Fumble damage
    if (node.isPlayer && action.successLevel === "fumble") {
      const scene = dgsm.getCurrentScene();
      const damageable = scene?.clues?.filter((c) => !c.discovered && !c.damaged) ?? [];
      if (damageable.length > 0) {
        const victim = damageable[Math.floor(Math.random() * damageable.length)];
        dgsm.damageScenarioClue(victim.id, node.characterName, `Fumbled: ${node.action}`);
        action.damagedClue = { clueId: victim.id, sourceName: scene!.name };
      }
    }

    // Scene event logging
    if (action.status === "completed" && action.impact >= 2 && !node.isPlayer) {
      const scene = dgsm.getScene(node.location);
      if (scene) scene.events.push(`${node.characterName}: ${action.outcome}`);
    }

    // NPC failure → revisePlans
    if (action.status === "failed" && !node.isPlayer) {
      const longTermIntent = await npcPlanningAgent.getLongTermIntent(sessionId, node.characterId);
      const memoryLog = await npcPlanningAgent.getMemoryLog(sessionId, node.characterId, gameDay);
      const pendingNodes = await npcPlanningAgent.getPendingNodes(sessionId, node.characterId, gameDay);
      await npcPlanningAgent.revisePlans(dgsm, sessionId, node.characterId, {
        longTermIntent, memoryLog, pendingNodes,
        trigger: { type: "failure", failureReason: action.failureReason!, action: action.action, gameTime: action.gameTime },
      }, language);
    }
  }

  // 5. Fire eligible features
  let allPlayerEvents: Array<{ event: CharacterAction; impact: number }> = [];
  const injectedNodes: PlanNode[] = [];

  for (const feature of registry.getAllFeatures()) {
    if (!registry.shouldFeatureFire(feature.id, isFullTick)) continue;
    const result = await feature.onTickEnd(tickActions, dgsm, tickRuntime);
    if (result.newNodes?.length) injectedNodes.push(...result.newNodes);
    if (result.playerEvents?.length) allPlayerEvents = allPlayerEvents.concat(result.playerEvents);
  }

  // Convert to PlayerWitnessEvent
  const playerWitnessEvents: PlayerWitnessEvent[] = allPlayerEvents.map((e) => ({
    characterName: e.event.characterName,
    action: e.event.action,
    outcome: e.event.outcome,
    location: e.event.location,
    gameTime: e.event.gameTime,
    impact: e.impact,
  }));

  return { actions: tickActions, playerFailed, playerEvents: playerWitnessEvents, injectedNodes };
}
```

**Step 3: Write `runPlayerAction()` — the new entry point**

Replaces both `runTick` and `resumeTick`. Drives N ticks in a loop.

```typescript
export async function runPlayerAction(
  playerNodes: PlanNode[],
  dgsm: DynamicGameStateManager,
  npcPlanningAgent: NPCPlanningAgent,
  sessionId: string,
  language: string = "en",
  registry: GameEngineRegistry,
  ctx: ExecutionContext
): Promise<TickResult> {
  const state = dgsm.getState();
  const currentMinutes = timeToMinutes(state.timeOfDay);
  const maxPlayerAdvance = playerNodes.reduce((max, n) => Math.max(max, n.timeAdvanceMinutes), 0);
  const totalMinutes = Math.min(maxPlayerAdvance, 1439 - currentMinutes);

  const allActions: CharacterAction[] = [];
  let minutesProcessed = 0;
  let pendingInjectedNodes: PlanNode[] = [];

  while (minutesProcessed < totalMinutes) {
    const remaining = totalMinutes - minutesProcessed;
    const tickDuration = Math.min(TICK_DURATION_MINUTES, remaining);
    const tickStart = currentMinutes + minutesProcessed;

    // Include any nodes injected by features from previous ticks
    const tickPlayerNodes = [...playerNodes, ...pendingInjectedNodes];

    const tickResult = await executeSingleTick({
      tickStartMinutes: tickStart,
      tickDurationMinutes: tickDuration,
      playerNodes: tickPlayerNodes,
      dgsm, npcPlanningAgent, sessionId, language, registry, ctx,
    });

    allActions.push(...tickResult.actions);
    pendingInjectedNodes = tickResult.injectedNodes;

    // Player interrupt
    if (tickResult.playerEvents.length > 0) {
      const existing = (dgsm.getContextualData("playerWitnessEvents") as any[]) ?? [];
      dgsm.setContextualData("playerWitnessEvents", [...existing, ...tickResult.playerEvents]);

      return {
        type: "player_interrupt",
        actions: allActions,
        witnessEvents: tickResult.playerEvents,
        remainingMinutes: totalMinutes - minutesProcessed - tickDuration,
        resumeFromMinutes: tickStart + tickDuration,
        gameDay: state.gameDay,
      };
    }

    // Player failed — stop
    if (tickResult.playerFailed) break;

    minutesProcessed += tickDuration;
  }

  // Advance game time
  const successfulPlayerAdvance = allActions
    .filter((a) => a.isPlayer && a.status === "completed")
    .reduce((sum, a) => {
      const matchingNode = playerNodes.find((n) => n.characterId === a.characterId && n.action === a.action);
      return sum + (matchingNode?.timeAdvanceMinutes ?? 0);
    }, 0);
  dgsm.updateGameTime(successfulPlayerAdvance > 0 ? successfulPlayerAdvance : maxPlayerAdvance);

  return { type: "completed", actions: allActions };
}
```

**Step 4: Write `resumePlayerAction()` — resume after interrupt**

```typescript
export async function resumePlayerAction(
  playerNodes: PlanNode[],
  previousActions: CharacterAction[],
  resumeFromMinutes: number,
  remainingMinutes: number,
  dgsm: DynamicGameStateManager,
  npcPlanningAgent: NPCPlanningAgent,
  sessionId: string,
  language: string = "en",
  registry: GameEngineRegistry,
  ctx: ExecutionContext
): Promise<TickResult> {
  const allActions: CharacterAction[] = [...previousActions];
  let minutesProcessed = 0;
  let pendingInjectedNodes: PlanNode[] = [];

  while (minutesProcessed < remainingMinutes) {
    const remaining = remainingMinutes - minutesProcessed;
    const tickDuration = Math.min(TICK_DURATION_MINUTES, remaining);
    const tickStart = resumeFromMinutes + minutesProcessed;

    const tickPlayerNodes = [...playerNodes, ...pendingInjectedNodes];

    const tickResult = await executeSingleTick({
      tickStartMinutes: tickStart,
      tickDurationMinutes: tickDuration,
      playerNodes: tickPlayerNodes,
      dgsm, npcPlanningAgent, sessionId, language, registry, ctx,
    });

    allActions.push(...tickResult.actions);
    pendingInjectedNodes = tickResult.injectedNodes;

    if (tickResult.playerEvents.length > 0) {
      const existing = (dgsm.getContextualData("playerWitnessEvents") as any[]) ?? [];
      dgsm.setContextualData("playerWitnessEvents", [...existing, ...tickResult.playerEvents]);

      return {
        type: "player_interrupt",
        actions: allActions,
        witnessEvents: tickResult.playerEvents,
        remainingMinutes: remainingMinutes - minutesProcessed - tickDuration,
        resumeFromMinutes: tickStart + tickDuration,
        gameDay: dgsm.getState().gameDay,
      };
    }

    if (tickResult.playerFailed) break;
    minutesProcessed += tickDuration;
  }

  const maxPlayerAdvance = playerNodes.reduce((max, n) => Math.max(max, n.timeAdvanceMinutes), 0);
  const successfulPlayerAdvance = allActions
    .filter((a) => a.isPlayer && a.status === "completed")
    .reduce((sum, a) => {
      const matchingNode = playerNodes.find((n) => n.characterId === a.characterId && n.action === a.action);
      return sum + (matchingNode?.timeAdvanceMinutes ?? 0);
    }, 0);
  dgsm.updateGameTime(successfulPlayerAdvance > 0 ? successfulPlayerAdvance : maxPlayerAdvance);

  return { type: "completed", actions: allActions };
}
```

**Step 5: Keep `scanUnplannedEncounters` unchanged (bottom of file)**

**Step 6: Remove old `runTick`, `resumeTick`, `minutesToBucket` functions**

**Step 7: Build**

Run: `pnpm build`

---

### Task 6: Update TickResult type and exports

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/index.ts`

**Step 1: Update TickResult in types.ts**

Replace the `player_interrupt` variant to use minutes instead of buckets:

```typescript
export type TickResult =
  | { type: "completed"; actions: CharacterAction[] }
  | {
      type: "player_interrupt";
      actions: CharacterAction[];
      witnessEvents: PlayerWitnessEvent[];
      /** Minutes remaining after this interrupt */
      remainingMinutes: number;
      /** Game-time minute offset to resume from */
      resumeFromMinutes: number;
      gameDay: number;
    };
```

**Step 2: Update exports in index.ts**

Replace `runTick, resumeTick` with `runPlayerAction, resumePlayerAction`:

```typescript
export { runPlayerAction, resumePlayerAction } from "./tickProcessor.js";
```

**Step 3: Build**

Run: `pnpm build`

**Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts src/dynamicworldagent/dynamicBasicAgent/npcPlanning/index.ts
git commit -m "feat: update TickResult type and exports for new tick model"
```

---

### Task 7: Update dynamicGraph.ts caller

**Files:**
- Modify: `src/dynamicworldagent/graph/dynamicGraph.ts`

**Step 1: Update imports and call sites**

Replace:
```typescript
import { runTick, resumeTick } from "../dynamicBasicAgent/npcPlanning/tickProcessor.js";
```
With:
```typescript
import { runPlayerAction, resumePlayerAction } from "../dynamicBasicAgent/npcPlanning/tickProcessor.js";
```

Update the `resumeTick` call site (~line 475) to pass new params:
- `remainingBuckets` → `remainingMinutes` + `resumeFromMinutes` from the stored interrupt
- Old: `resumeTick(pendingInterrupt.remainingBuckets, pendingInterrupt.previousActions, ...)`
- New: `resumePlayerAction(playerNodes, pendingInterrupt.previousActions, pendingInterrupt.resumeFromMinutes, pendingInterrupt.remainingMinutes, ...)`

Update the `runTick` call site (~line 494):
- Old: `runTick(pendingPlayerNodes, dgsm, npcPlanningAgent, ...)`
- New: `runPlayerAction(pendingPlayerNodes, dgsm, npcPlanningAgent, ...)`

Also update the `pendingTickInterrupt` storage to save `remainingMinutes` and `resumeFromMinutes` instead of `remainingBuckets`.

**Step 2: Read the full dynamicGraph.ts context around the call sites to ensure correct parameter mapping**

Consult: `src/dynamicworldagent/graph/dynamicGraph.ts` lines 460-510

**Step 3: Build**

Run: `pnpm build`

**Step 4: Commit**

```bash
git add src/dynamicworldagent/graph/dynamicGraph.ts
git commit -m "refactor: update dynamicGraph to use runPlayerAction/resumePlayerAction"
```

---

### Task 8: Update planning templates — impact from registry

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanAgent.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts`

**Step 1: Update PlayerPlanAgent**

Replace `buildFeaturePlanningPrompt` with `buildPlanningPrompt` (which now includes impact + features):

```typescript
// Before:
const handlerPrompt = registry?.buildHandlerPrompt();
const worldStatePrompt = registry?.buildWorldStatePrompt(dgsm);
const featurePlanningPrompt = registry?.buildFeaturePlanningPrompt();

// After:
const handlerPrompt = registry?.buildHandlerPrompt();
const worldStatePrompt = registry?.buildWorldStatePrompt(dgsm);
const planningPrompt = registry?.buildPlanningPrompt();  // impact + features combined
```

Update `PlayerPlanParams`:
- Replace `featurePlanningPrompt?: string` with `planningPrompt?: string`

Update `PlayerPlanTemplate.ts`:
- Replace `${params.featurePlanningPrompt || ""}` with `${params.planningPrompt || ""}`

**Step 2: Same for NPCPlanningAgent/Template**

Replace `featurePlanningPrompt` with `planningPrompt` in `DailyPlanParams` and the template.

**Step 3: Build**

Run: `pnpm build`
---

### Task 9: Update engine exports and registerDefaults

**Files:**
- Modify: `src/dynamicworldagent/engine/index.ts`
- Modify: `src/dynamicworldagent/engine/registerDefaults.ts`

**Step 1: Update index.ts exports**

Remove `NpcPlanningCapability` from old exports if renamed, ensure new types exported. Add `findAffectedCharacters`, `findAffectedScenes` to exports.

**Step 2: Verify registerDefaults.ts**

Should already register `ImpactGateFeature` — just verify it still works with the new constructor (no args needed).

**Step 3: Build**

Run: `pnpm build`


---

### Task 10: Final build verification and cleanup

**Step 1: Full build**

Run: `pnpm build`

**Step 2: TypeScript check**

Run: `pnpm build:tsc`
Expected: No new errors

**Step 3: Search for any remaining references to old APIs**

```bash
grep -r "onBucketEnd\|onTickStart\|conditionTypes\|minutesToBucket\|runTick\b\|resumeTick\b\|buildFeaturePlanningPrompt\|featurePlanningPrompt\|remainingBuckets" src/ --include="*.ts" -l
```

Expected: No matches (or only in test files / comments)
