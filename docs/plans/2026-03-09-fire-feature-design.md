# Fire Feature Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a fire WorldFeature as the first concrete demonstration of the feature framework (tick/activate/propagate + featureState).

**Architecture:** Fire is a fully self-contained WorldFeature plugin. It declares its own internal state type, LLM overlay schema, and lifecycle logic. The framework handles scheduling; the feature handles all fire-specific behavior.

---

## Core Model

Each scene's fire has an **independent lifecycle**: ignite → grow → peak → decay → extinguish. Spatial spread **ignites** adjacent scenes (new fire starts from intensity 1 with its own lifecycle). Scene conditions can modify the curve (flammable materials extend, water sources accelerate decay).

### Fixed Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| maxIntensity | 5 | Fixed, not LLM-controlled |
| spreadThreshold | 3 | `Math.ceil(5 / 2)` |
| growthRate | 1 per 2 ticks | Growing phase |
| decayRate | 1 per 2 ticks | Decaying phase |

### Intensity Timeline (default, no scene modifiers)

```
tick:      0  2  4  6  8  10 12 14 16 18
intensity: 1  2  3  4  5  4  3  2  1  0
phase:     growing-------→  decaying------→  extinguished
                  ↑ spread triggered (≥3)
```

Total burn ticks: 18 (at default rates).

## LLM Interaction

### Overlay Fields (planNodeSchema)

LLM outputs minimal fields — feature handles all internal parameters.

**Start fire:**
- `fireIntensity: number` (REQUIRED) — initial intensity, typically 1

**Extinguish fire:**
- `fireExtinguish: boolean` (optional) — set to true to reduce/clear fire at the scene

### Planning Prompt

Tells LLM:
- What fire does (penalties, blocked connections)
- When to use fireIntensity (starting fires)
- When to use fireExtinguish (putting out fires)
- Current fire state is visible via stateDescription

## Three Hooks

### `activate(node, dgsm)`

Called when LLM outputs fire overlay fields on an executed node.

**Start fire** (`fireIntensity` present):
- Create `FireSceneState` at `node.location` with initial intensity
- Write initial scenarioCondition (smoke/penalties)

**Extinguish** (`fireExtinguish: true`):
- Read current `FireSceneState`
- Reduce intensity (e.g. -2) or clear entirely
- If intensity reaches 0, trigger aftermath logic

### `tick(dgsm, runtime)`

Called every tick. Iterates all scenes with active fire state.

For each burning scene:
1. `totalBurnTicks++`
2. `ticksInPhase++`
3. Every 2 ticks in phase:
   - **growing**: `intensity += growthRate`. If `intensity >= maxIntensity` → switch to `"decaying"`, reset `ticksInPhase`
   - **decaying**: `intensity -= decayRate`. If `intensity <= 0` → extinguish
4. On intensity change:
   - Rewrite `scenarioConditions` for this scene (penalties scaled to intensity)
   - If `intensity >= spreadThreshold` → set `blockedConnections` for entries into this scene
   - If `intensity < spreadThreshold` → unblock connections
5. On extinguish (`intensity <= 0`):
   - Write permanent aftermath condition based on `totalBurnTicks`
   - Remove `featureState` for this scene
   - Clear fire-related `scenarioConditions`
   - Unblock all fire-blocked connections

### `propagate(sourceSceneId, currentHop, dgsm, runtime)`

Called on propagation schedule when source scene intensity ≥ spreadThreshold.

1. Read source scene's `FireSceneState`
2. If `intensity < spreadThreshold` → return empty (no spread)
3. Get adjacent scenes via connections
4. Filter: only spread through valid connection types (not already blocked by non-fire reasons, not already on fire)
5. For each valid adjacent scene → write new `FireSceneState` with `intensity: 1, phase: "growing"`
6. Return `{ spreadTo: [newSceneIds] }`

## Game Mechanical Effects

### Skill Penalties (via scenarioConditions)

Written by `tick()` on every intensity change:

| Intensity | Description | Spot Hidden | Listen |
|-----------|-------------|-------------|--------|
| 1 | Light smoke | -10 | — |
| 2 | Thickening smoke | -20 | -10 |
| 3 | Heavy smoke + flames | -30 | -20 |
| 4 | Intense fire | -40 | -30 |
| 5 | Raging inferno | -50 | -40 |

### Connection Blocking (via blockedConnections)

- Intensity ≥ 3 (spreadThreshold) → block all connections INTO this scene, reason: "Blocked by fire (intensity N)"
- Intensity < 3 → unblock fire-blocked connections

### Aftermath (permanent, on extinguish)

Written based on `totalBurnTicks`:

| Total Burn Ticks | Aftermath |
|------------------|-----------|
| 1-4 | Minor smoke stains, no mechanical effect |
| 5-10 | Partial item damage, Spot Hidden -5 (soot) |
| 11-20 | Severe burn damage, some connections may be damaged |
| 20+ | Scene nearly destroyed, most items/clues unavailable |

## Internal State Type

Defined inside the fire feature file, not in the framework types:

```typescript
interface FireSceneState {
  intensity: number;
  maxIntensity: number;       // fixed 5
  growthRate: number;         // default 1 (per 2 ticks)
  decayRate: number;          // default 1 (per 2 ticks)
  spreadThreshold: number;   // fixed 3
  phase: "growing" | "decaying";
  ticksInPhase: number;
  totalBurnTicks: number;
}
```

Stored via framework: `dgsm.setFeatureSceneState("fire", sceneId, state)`
Read via: `dgsm.getFeatureSceneState("fire", sceneId) as FireSceneState`

## Scene Condition Modifiers (future extension)

The `tick()` method can read existing scene conditions to modify fire behavior:
- Scene has "flammable_materials" condition → growthRate × 2
- Scene has "water_source" condition → decayRate × 2
- Scene is outdoor → fire spreads faster but decays faster (wind)

Not implemented in v1, but the architecture supports it — `tick()` reads `dgsm.getSceneConditions()` and adjusts rates.

## File Structure

```
src/dynamicworldagent/engine/features/
  fireFeature.ts    — FireSceneState type + WorldFeature implementation
```

Registration: `registry.registerFeature(fireFeature)` in `registerDefaults.ts` or module-specific init.

## Propagation Config

```typescript
propagation: {
  tickInterval: 2,   // check spread every 2 ticks
  maxHops: 3,        // fire can spread up to 3 scenes from origin
}
```
