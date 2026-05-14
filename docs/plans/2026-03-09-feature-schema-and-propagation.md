# Feature Schema Injection & Propagation System

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make WorldFeature purely declarative — schema + propagation config — and move impact propagation logic out of ImpactGateFeature into the tick engine as a built-in step. Features declare `planNodeSchema` (injected as "Feature Overlay" in the output prompt, LLM freely combines with any node type) and optional `propagation` config (engine drives spatial spread). `onTickEnd` is removed.

**Architecture:** Features become data declarations. The tick engine takes over all runtime responsibilities: (1) built-in impact propagation (the old ImpactGateFeature logic), (2) scanning executed nodes for feature overlay fields → registering propagation sources, (3) driving `propagate()` on schedule. Features only declare WHAT they are; the engine handles WHEN and HOW.

**Tech Stack:** TypeScript, existing GameEngineRegistry / tickProcessor / impactPropagation infrastructure

---

## Design Overview

### Current State

```
WorldFeature {
  id, description, tickInterval, impactScope,
  planningPrompt: string,
  planNodeFields?: Array<{field, type, description}>,  // unused by anyone
  stateDescription(dgsm): string,
  onTickEnd(actions, dgsm, runtime): WorldFeatureResult  // imperative callback
}

ImpactGateFeature implements WorldFeature {
  onTickEnd → scans impact>0 actions, runs LLM gate, revises NPC plans
}
```

### Target State

```
WorldFeature {
  id, description,
  planningPrompt: string,
  planNodeSchema?: FeatureNodeSchema,        // rich schema for LLM output
  propagation?: FeaturePropagationConfig,    // spatial spread config
  stateDescription(dgsm): string,
  propagate?(source, hop, dgsm, runtime): Promise<PropagationResult>
}

tickProcessor (engine-built-in):
  Step 6: Impact propagation (was ImpactGateFeature.onTickEnd)
  Step 7: Detect feature overlay fields → register propagation sources
  Step 8: Drive feature propagation on schedule
```

### Key Decisions

1. **`onTickEnd` removed** — Features don't need a tick callback. Impact propagation is an engine concern (always runs), and feature-specific logic lives in `propagate()`.

2. **`tickInterval` and `impactScope` removed from WorldFeature** — `tickInterval` was only used by `onTickEnd`; the new `propagation.tickInterval` replaces it for spread scheduling. `impactScope` was only used by ImpactGateFeature (now engine-built-in). The engine's impact propagation always uses "dynamic" scope (each action's own impact level).

3. **Impact propagation becomes engine-built-in** — The logic from `ImpactGateFeature.onTickEnd` moves into `tickProcessor.executeSingleTick()` as step 6. `ImpactGateFeature` class is deleted. `NpcPlanningCapability`, `TickRuntimeContext`, `WorldFeatureResult` remain for the engine's internal use.

4. **Feature overlay detection is automatic** — After executing nodes, the engine scans each feature's `planNodeSchema.requiredFields` against executed PlanNodes. If any feature field is found, the engine registers a propagation source at that location.

5. **`propagate()` returns `PropagationResult`** — Contains `spreadTo` (new scene IDs) and optional `playerEvents` / `newNodes` for integration with the tick result.

---

## Generated Output (with a hypothetical Fire feature registered)

```
### Feature Overlays (can be added to ANY node type)

**fire** — Fire system: actions can ignite flammable objects or locations.
When a node involves fire, add these fields:
- `"fireIntensity"`: (REQUIRED, number 1-5) intensity of the fire
- `"fuelSource"`: (optional, string) what is burning e.g. `"wooden_bookshelf"`

Example:
```json
{
  "nodeId": "si2",
  "action": "Set fire to the wooden bookshelf",
  "location": "library_main",
  "type": "scene_interaction",
  "impact": 3,
  "status": "pending",
  "fireIntensity": 3,
  "fuelSource": "wooden_bookshelf"
}
```
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/dynamicworldagent/engine/types.ts` | Remove `onTickEnd`, `tickInterval`, `impactScope` from WorldFeature. Add `FeatureNodeSchema`, `FeaturePropagationConfig`, `PropagationResult`, `propagate()`. |
| `src/dynamicworldagent/engine/registry.ts` | Remove `shouldFeatureFire` / `featureTickCounters`. Update `buildOutputSchemaPrompt()` Section 4 for `planNodeSchema`. Add propagation state tracking + `detectFeatureOverlays()`. Remove `buildImpactPrompt()` / `buildPlanningPrompt()` (move to engine util). |
| `src/dynamicworldagent/engine/features/impactGateFeature.ts` | **Delete file.** |
| `src/dynamicworldagent/engine/registerDefaults.ts` | Remove ImpactGateFeature registration. |
| `src/dynamicworldagent/engine/index.ts` | Remove ImpactGateFeature export. Add new type exports. |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Replace feature fire loop (step 6) with built-in impact propagation. Add step 7 (detect overlays) + step 8 (drive propagation). |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts` | Add index signature to `PlanNode`. |
| `PlayerPlanTemplate.ts` / `NPCPlanningTemplate.ts` | Update assembly instruction in fallback schemas. |

---

### Task 1: Rewrite types in `types.ts`

**Files:**
- Modify: `src/dynamicworldagent/engine/types.ts`

**Step 1: Add new types after `WorldFeatureResult` (after line 37)**

```typescript
// ===== Feature schema & propagation declarations =====

/** Schema declaration for fields a feature adds to PlanNode output */
export interface FeatureNodeSchema {
  /** Fields the LLM must provide when using this feature overlay */
  requiredFields: Array<{ field: string; type: string; description: string }>;
  /** Fields the LLM may optionally provide */
  optionalFields?: Array<{ field: string; type: string; description: string }>;
  /** Complete example node showing this feature's fields merged with a real node */
  exampleNode: Record<string, unknown>;
}

/** Propagation configuration for features that spread spatially */
export interface FeaturePropagationConfig {
  /** How many ticks between each propagation step (e.g. 2 = every 10 min) */
  tickInterval: number;
  /** Maximum number of propagation hops from the source scene */
  maxHops: number;
}

/** Result returned by WorldFeature.propagate() */
export interface PropagationResult {
  /** Scene IDs the feature spread to this step */
  spreadTo: string[];
  /** New PlanNodes to inject (e.g. NPC reaction to fire arrival) */
  newNodes?: PlanNode[];
  /** Player witness events from propagation */
  playerEvents?: Array<{ event: CharacterAction; impact: number }>;
}
```

**Step 2: Rewrite `WorldFeature` interface**

Replace the entire `WorldFeature` interface (lines 78-118) with:

```typescript
export interface WorldFeature {
  /** Unique identifier (e.g. "fire", "rain", "poison_gas") */
  id: string;

  /** Human-readable description */
  description: string;

  /**
   * Static prompt section describing this feature's rules and behavior.
   * Injected into the planning agent prompt. Return "" to omit.
   */
  planningPrompt: string;

  /**
   * Schema for fields this feature adds to PlanNode output.
   * Rendered as a "Feature Overlay" section — LLM can combine with ANY node type.
   * Undefined if this feature adds no output fields.
   */
  planNodeSchema?: FeatureNodeSchema;

  /**
   * Propagation configuration. If defined, the tick engine will:
   * 1. Detect this feature's overlay fields on executed nodes → register propagation sources
   * 2. Call propagate() on schedule to spread effects to adjacent scenes
   */
  propagation?: FeaturePropagationConfig;

  /** Generate current state description for LLM context. Return "" to omit. */
  stateDescription(dgsm: DynamicGameStateManager): string;

  /**
   * Called by the tick engine when this feature should propagate from a source scene.
   * hop 0 = initial activation (feature just appeared at source), hop 1+ = subsequent spread.
   * Only called if `propagation` is defined.
   */
  propagate?(
    sourceSceneId: string,
    currentHop: number,
    dgsm: DynamicGameStateManager,
    runtime: TickRuntimeContext
  ): Promise<PropagationResult>;
}
```

**Step 3: Build and verify**

Run: `pnpm build`
Expected: FAILS — `ImpactGateFeature` still implements old interface with `onTickEnd`. This is expected; we fix it in Task 3.

---

### Task 2: Add index signature to `PlanNode`

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts:38-57`

**Step 1: Add index signature**

Add before the closing `}` of `PlanNode` (after `outcome?: string;`):

```typescript
  /** Feature overlay fields — arbitrary keys added by WorldFeature schemas */
  [key: string]: unknown;
```

**Step 2: Build and verify**

Run: `pnpm build`
Expected: Still fails (ImpactGateFeature), but no new errors from PlanNode change.

---

### Task 3: Delete ImpactGateFeature and update registration

**Files:**
- Delete: `src/dynamicworldagent/engine/features/impactGateFeature.ts`
- Modify: `src/dynamicworldagent/engine/registerDefaults.ts`
- Modify: `src/dynamicworldagent/engine/index.ts`

**Step 1: Delete `impactGateFeature.ts`**

Remove the file entirely.

**Step 2: Update `registerDefaults.ts`**

Remove the ImpactGateFeature import and registration:

```typescript
import { GameEngineRegistry } from "./registry.js";
import {
  routineHandler,
  movementHandler,
  characterInteractionHandler,
  objectInteractionHandler,
  sceneInteractionHandler,
} from "./handlers/index.js";

export function createDefaultRegistry(): GameEngineRegistry {
  const registry = new GameEngineRegistry();
  registry.registerHandler(routineHandler);
  registry.registerHandler(movementHandler);
  registry.registerHandler(characterInteractionHandler);
  registry.registerHandler(objectInteractionHandler);
  registry.registerHandler(sceneInteractionHandler);
  return registry;
}
```

**Step 3: Update `engine/index.ts`**

Remove `ImpactGateFeature` export, add new type exports:

```typescript
export { GameEngineRegistry } from "./registry.js";
export { createExecutionContext } from "./executionContext.js";
export { createDefaultRegistry } from "./registerDefaults.js";
export type {
  NodeHandler, WorldFeature, ExecutionContext, SkillRollResult,
  WorldFeatureResult, TickRuntimeContext, NpcPlanningCapability,
  FeatureNodeSchema, FeaturePropagationConfig, PropagationResult,
} from "./types.js";
export {
  routineHandler,
  movementHandler,
  characterInteractionHandler,
  objectInteractionHandler,
  sceneInteractionHandler,
} from "./handlers/index.js";
export { findAffectedCharacters, findAffectedScenes } from "./shared/impactPropagation.js";
```

**Step 4: Build and verify**

Run: `pnpm build`
Expected: Passes. Nothing references ImpactGateFeature outside of registerDefaults.ts and index.ts (tickProcessor uses the generic `feature.onTickEnd()` call which we'll update next).

---

### Task 4: Update registry — remove onTickEnd infra, add propagation + overlay detection

**Files:**
- Modify: `src/dynamicworldagent/engine/registry.ts`

**Step 1: Remove `featureTickCounters` and `shouldFeatureFire`**

Delete these members — they were only used for `onTickEnd` scheduling:

- Delete: `private featureTickCounters = new Map<string, number>();`
- Delete: the `resetTickCounters()` method body's `this.featureTickCounters.clear();` line
- Delete: the entire `shouldFeatureFire()` method

**Step 2: Add propagation state and methods**

Add after the existing `getFeature()` method:

```typescript
  // ===== Propagation state management =====

  private propagationTickCounters = new Map<string, number>();
  private propagationSources = new Map<string, Array<{ sceneId: string; currentHop: number }>>();

  /** Reset all tick counters and propagation state (call at session start) */
  resetTickCounters(): void {
    this.propagationTickCounters.clear();
    this.propagationSources.clear();
  }

  /** Register a new propagation source for a feature */
  addPropagationSource(featureId: string, sceneId: string): void {
    if (!this.propagationSources.has(featureId)) {
      this.propagationSources.set(featureId, []);
    }
    const sources = this.propagationSources.get(featureId)!;
    if (!sources.some(s => s.sceneId === sceneId)) {
      sources.push({ sceneId, currentHop: 0 });
    }
  }

  /** Check if a feature's propagation should fire this tick */
  shouldPropagationFire(featureId: string, isFullTick: boolean): boolean {
    if (!isFullTick) return false;
    const feature = this.features.get(featureId);
    if (!feature?.propagation) return false;
    const current = (this.propagationTickCounters.get(featureId) ?? 0) + 1;
    this.propagationTickCounters.set(featureId, current);
    return current % feature.propagation.tickInterval === 0;
  }

  /** Get current propagation sources for a feature */
  getPropagationSources(featureId: string): Array<{ sceneId: string; currentHop: number }> {
    return this.propagationSources.get(featureId) ?? [];
  }

  /** Update propagation sources after a propagation step */
  updatePropagationSources(featureId: string, newSources: Array<{ sceneId: string; currentHop: number }>): void {
    const feature = this.features.get(featureId);
    const maxHops = feature?.propagation?.maxHops ?? 0;
    this.propagationSources.set(featureId, newSources.filter(s => s.currentHop < maxHops));
  }

  /**
   * Scan executed PlanNodes for feature overlay fields.
   * For each feature with planNodeSchema, checks if any node contains
   * at least one of the feature's required fields → registers propagation source.
   */
  detectFeatureOverlays(executedNodes: import("../dynamicBasicAgent/npcPlanning/types.js").PlanNode[]): void {
    for (const feature of this.features.values()) {
      if (!feature.planNodeSchema || !feature.propagation) continue;
      const featureFields = feature.planNodeSchema.requiredFields.map(f => f.field);
      for (const node of executedNodes) {
        const hasOverlay = featureFields.some(field => (node as Record<string, unknown>)[field] !== undefined);
        if (hasOverlay) {
          this.addPropagationSource(feature.id, node.location);
        }
      }
    }
  }
```

**Step 3: Update `buildOutputSchemaPrompt()` Section 4**

Replace the existing Section 4 block (the `featureFieldLines` section) with:

```typescript
    // Section 4: Feature Overlays
    const featureOverlaySections: string[] = [];
    for (const feature of this.features.values()) {
      if (!feature.planNodeSchema) continue;
      const schema = feature.planNodeSchema;

      const lines: string[] = [];
      lines.push(`**${feature.id}** — ${feature.description}`);
      lines.push(`When a node involves ${feature.id}, add these fields:`);
      for (const f of schema.requiredFields) {
        lines.push(`- \`"${f.field}"\`: (REQUIRED, ${f.type}) ${f.description}`);
      }
      if (schema.optionalFields?.length) {
        for (const f of schema.optionalFields) {
          lines.push(`- \`"${f.field}"\`: (optional, ${f.type}) ${f.description}`);
        }
      }
      lines.push("");
      lines.push("Example:");
      lines.push("```json");
      lines.push(JSON.stringify(schema.exampleNode, null, 2));
      lines.push("```");

      featureOverlaySections.push(lines.join("\n"));
    }

    if (featureOverlaySections.length > 0) {
      sections.push("");
      sections.push("### Feature Overlays (can be added to ANY node type)");
      sections.push("");
      sections.push(featureOverlaySections.join("\n\n"));
    }
```

**Step 4: Update assembly instruction (Section 1)**

Change:
```
"3. **Feature fields** if applicable (see below)"
```
to:
```
"3. **Feature overlay fields** if the action involves an active world feature (see below)"
```

**Step 5: Build and verify**

Run: `pnpm build`
Expected: Passes.

---

### Task 5: Rewrite tickProcessor — inline impact propagation + feature overlay detection + propagation loop

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

This is the biggest change. The existing step 6 (feature fire loop, lines 500-522) is replaced with three new steps.

**Step 1: Add import for `findAffectedCharacters`**

At top of file, add:

```typescript
import { findAffectedCharacters } from "../../engine/shared/impactPropagation.js";
import type { WorldFeatureResult } from "../../engine/types.js";
```

**Step 2: Replace step 6 (lines 500-522) with built-in impact propagation**

Delete the entire existing step 6 block and replace with:

```typescript
  // 6. Built-in impact propagation (was ImpactGateFeature)
  //    Scans for actions with impact > 0, notifies affected NPCs,
  //    runs LLM impact gate, triggers plan revision if needed.
  let allPlayerEvents: PlayerWitnessEvent[] = [];
  const injectedNodes: PlanNode[] = [];

  const impactEvents = tickActions.filter((a) => a.impact > 0);
  if (impactEvents.length > 0 && isFullTick) {
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

    if (playerEvents) {
      allPlayerEvents = playerEvents.map((e) => ({
        characterName: e.event.characterName,
        action: e.event.action,
        outcome: e.event.outcome,
        location: e.event.location,
        gameTime: e.event.gameTime,
        impact: e.impact,
      }));
    }

    // NPC processing — parallel LLM calls
    if (characterEventsMap.size > 0) {
      await Promise.all(
        [...characterEventsMap.entries()].map(async ([npcId, npcEvents]) => {
          const npc = state.npcCharacters.find((n) => n.id === npcId);
          const longTermIntent = await npcPlanningAgent.getLongTermIntent(sessionId, npcId);
          const pendingNodes = await npcPlanningAgent.getPendingNodes(sessionId, npcId, gameDay);
          const triggeringEvents = npcEvents
            .map((e) => `[impact ${e.impact}] ${e.event.characterName}: ${e.event.outcome}`)
            .join("\n");

          const result = await npcPlanningAgent.runImpactGateForNpc(
            {
              npcId,
              npcName: npc?.name ?? npcId,
              currentLocation: dgsm.getNpcLocation(npcId) ?? "unknown",
              longTermIntent,
              pendingNodesSummary: pendingNodes.map((n) => `${n.gameTime} ${n.action}`).join("; "),
              triggeringEvents,
            },
            tickRuntime.tickTime,
            language
          );

          const logEntry = `Day${gameDay} ${tickRuntime.tickTime} [witness] - ${result.witnessEntry}`;
          const npcLoc = dgsm.getNpcLocation(npcId) ?? "unknown";
          await npcPlanningAgent.appendMemoryLog(sessionId, npcId, logEntry, gameDay, tickRuntime.tickTime, npcLoc);

          if (result.shouldRevise) {
            const memoryLog = await npcPlanningAgent.getMemoryLog(sessionId, npcId, gameDay);
            const sortedEvents = [...npcEvents].sort((a, b) => b.impact - a.impact);
            await npcPlanningAgent.revisePlans(dgsm, sessionId, npcId, {
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
  }
```

**Step 3: Add step 7 — detect feature overlay fields**

```typescript
  // 7. Detect feature overlay fields on executed nodes → register propagation sources
  registry.detectFeatureOverlays(allNodes);
```

**Step 4: Add step 8 — drive feature propagation**

```typescript
  // 8. Drive feature propagation on schedule
  for (const feature of registry.getAllFeatures()) {
    if (!feature.propagation || !feature.propagate) continue;
    if (!registry.shouldPropagationFire(feature.id, isFullTick)) continue;

    const sources = registry.getPropagationSources(feature.id);
    if (sources.length === 0) continue;

    const nextSources: Array<{ sceneId: string; currentHop: number }> = [];

    for (const source of sources) {
      const propResult = await feature.propagate(
        source.sceneId, source.currentHop, dgsm, tickRuntime
      );

      // New scenes become sources at hop+1
      for (const newSceneId of propResult.spreadTo) {
        nextSources.push({ sceneId: newSceneId, currentHop: source.currentHop + 1 });
      }
      // Original source persists at hop+1
      nextSources.push({ sceneId: source.sceneId, currentHop: source.currentHop + 1 });

      // Collect propagation results
      if (propResult.newNodes?.length) {
        injectedNodes.push(...propResult.newNodes);
      }
      if (propResult.playerEvents?.length) {
        const witnessEvents: PlayerWitnessEvent[] = propResult.playerEvents.map((e) => ({
          characterName: e.event.characterName,
          action: e.event.action,
          outcome: e.event.outcome,
          location: e.event.location,
          gameTime: e.event.gameTime,
          impact: e.impact,
        }));
        allPlayerEvents = allPlayerEvents.concat(witnessEvents);
      }
    }

    registry.updatePropagationSources(feature.id, nextSources);
  }
```

**Step 5: Keep existing witness events storage (lines 524-528) — no change**

The existing code that stores `allPlayerEvents` into `contextualData` remains unchanged.

**Step 6: Build and verify**

Run: `pnpm build`
Expected: Passes. With no features registered, steps 7+8 are no-ops. Step 6 is the same logic as ImpactGateFeature.onTickEnd, now inlined.

---

### Task 6: Update registry prompt methods

**Files:**
- Modify: `src/dynamicworldagent/engine/registry.ts`

The `buildImpactPrompt()` and `buildPlanningPrompt()` methods currently live on the registry and reference `this.features` for `planningPrompt`. With features becoming purely declarative, these methods still work — they iterate features for `planningPrompt` strings.

**Step 1: Verify `buildPlanningPrompt()` still works**

It iterates `this.features.values()` and collects `feature.planningPrompt`. This still works because `planningPrompt` remains on the interface. No change needed.

**Step 2: Verify `buildWorldStatePrompt()` still works**

It iterates features and calls `feature.stateDescription(dgsm)`. This still works. No change needed.

**Step 3: Build and verify**

Run: `pnpm build`
Expected: Passes.

---

### Task 7: Update default fallback output schemas in templates

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts`

**Step 1: Update `DEFAULT_PLAYER_OUTPUT_SCHEMA` assembly instruction**

In the `DEFAULT_PLAYER_OUTPUT_SCHEMA` string, the current assembly instruction says:

```
Each node is a single flat JSON object combining:
1. All **Base Fields** (required on every node)
2. **Type-specific fields** for the chosen \`type\` (see below — omit if type has none)
```

Change to:

```
Each node is a single flat JSON object combining:
1. All **Base Fields** (required on every node)
2. **Type-specific fields** for the chosen \`type\` (see below — omit if type has none)
3. **Feature overlay fields** if the action involves an active world feature (see below)
```

**Step 2: Same change in `DEFAULT_NPC_OUTPUT_SCHEMA`**

Apply the identical assembly instruction update.

**Step 3: Build and verify**

Run: `pnpm build`
Expected: Passes.

---

### Task 8: Final verification

**Step 1: Full build**

Run: `pnpm build`
Expected: Passes with no errors.

**Step 2: Verify backward compatibility with no features registered**

Trace `executeSingleTick()`:
- Step 6 (impact propagation): runs on `tickActions` directly — same behavior as old ImpactGateFeature
- Step 7 (`detectFeatureOverlays`): no features have `planNodeSchema` → no-op
- Step 8 (propagation loop): no features have `propagation` → no-op
- ✅ Identical runtime behavior

**Step 3: Verify output schema unchanged when no feature schemas exist**

`buildOutputSchemaPrompt({isPlayer: true})`:
- No features have `planNodeSchema` → Section 4 ("Feature Overlays") omitted
- Assembly instruction mentions feature overlays (benign)
- ✅ Same output as before

**Step 4: Verify hypothetical Fire feature integration**

If a FireFeature were registered with:
```typescript
{
  id: "fire",
  description: "Fire system: actions can ignite flammable objects or locations",
  planningPrompt: "## Fire\nFire can spread to adjacent scenes...",
  planNodeSchema: {
    requiredFields: [{ field: "fireIntensity", type: "number 1-5", description: "intensity of the fire" }],
    optionalFields: [{ field: "fuelSource", type: "string", description: "what is burning" }],
    exampleNode: {
      nodeId: "si2", action: "Set fire to the bookshelf", location: "library_main",
      type: "scene_interaction", impact: 3, status: "pending",
      fireIntensity: 3, fuelSource: "wooden_bookshelf"
    }
  },
  propagation: { tickInterval: 2, maxHops: 3 },
  stateDescription(dgsm) { /* return active fires */ },
  async propagate(sourceSceneId, currentHop, dgsm, runtime) {
    // Add fire condition to adjacent scenes, return { spreadTo, playerEvents }
  }
}
```

Expected flow:
1. LLM outputs node with `fireIntensity: 3` at `library_main`
2. Handler executes the node normally (ignores unknown fields)
3. Step 7: `detectFeatureOverlays()` finds `fireIntensity` → `addPropagationSource("fire", "library_main")`
4. Step 8 (every 2 ticks): calls `propagate("library_main", 0, ...)` → fire spreads
5. Next tick: `propagate("library_main", 1, ...)` + `propagate("reading_room", 0, ...)` → continues
6. After 3 hops: propagation stops (maxHops reached)
- ✅ Correct behavior

---

## Summary of Changes

| Change | Why |
|--------|-----|
| Remove `onTickEnd` from WorldFeature | Features are declarative, engine handles all runtime logic |
| Remove `tickInterval` / `impactScope` from WorldFeature | Only used by onTickEnd; replaced by `propagation.tickInterval` |
| Delete ImpactGateFeature | Logic inlined into tickProcessor step 6 — it's engine infrastructure, not a feature |
| Add `planNodeSchema` to WorldFeature | Rich schema: required/optional fields, typed, with full example node |
| Add `propagation` + `propagate()` to WorldFeature | Declarative spatial spread config; engine drives scheduling and hop tracking |
| Add `PropagationResult` type | `propagate()` returns spreadTo + optional playerEvents/newNodes |
| Add `detectFeatureOverlays()` to registry | Engine auto-detects feature fields on executed nodes → registers propagation sources |
| Add propagation state tracking to registry | Track source scenes and hop counts per feature |
| Inline impact propagation in tickProcessor | Step 6 = old ImpactGateFeature logic, now engine-owned |
| Add steps 7+8 in tickProcessor | Step 7 = detect overlays, Step 8 = drive propagation |
| Index signature on PlanNode | Feature overlay fields pass through parsing |
| Assembly instruction updated | Tells LLM about feature overlays concept |
