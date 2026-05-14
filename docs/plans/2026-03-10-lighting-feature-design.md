# Lighting Feature Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a unified lighting WorldFeature that aggregates multiple light sources (sun, moon, fire, items) into per-scene light levels with skill penalties.

**Architecture:** Lighting is a tick-driven WorldFeature that reads from other features (fire, weather) and scene items each tick. It computes max light level per scene from all contributing sources, then writes skill penalties via sceneConditions.

---

## Light Level Scale

| Level | Name | Description |
|-------|------|-------------|
| 1 | pitch_black | Complete darkness |
| 2 | dark | Faint light |
| 3 | normal | Normal illumination |
| 4 | bright | Ample light |
| 5 | blinding | Overpowering light, impairs vision |

Level 3 is the baseline (no penalties). Both extremes (1-2 too dark, 5 too bright) cause penalties.

---

## Light Sources

### Sun (global outdoor)

Smooth curve based on `TickRuntimeContext.tickTime`, affects all outdoor scenes (`indoor !== true`).

**Base curve:**

```
00:00-04:00  → 1 (pitch black)
04:00-06:00  → 1→3 (dawn, linear interpolation)
06:00-07:00  → 3→4 (sunrise)
07:00-12:00  → 4→5 (morning to noon peak)
12:00-13:00  → 5 (noon)
13:00-17:00  → 5→4 (afternoon)
17:00-18:00  → 4→3 (sunset)
18:00-20:00  → 3→1 (dusk)
20:00-24:00  → 1 (night)
```

**Weather modifier** (reads weather featureState, reduces sun level):

| Weather | Condition | Modifier |
|---------|-----------|----------|
| fog | intensity 3-4 | -1 |
| fog | intensity 5 | -2 |
| storm | intensity 2-3 | -1 |
| storm | intensity 4+ | -2 |
| rain | intensity 4+ | -1 |

Final sun level = max(1, base - weather_modifier).

### Moon (global outdoor, nighttime)

Fixed level 2 (dark/faint light) applied to all outdoor scenes when sun level = 1 (nighttime). Provides a floor so outdoor scenes are never pitch black unless weather overrides.

### Fire (reads fire featureState)

Intensity-to-light mapping:

| Fire Intensity | Light Level | Range |
|---------------|-------------|-------|
| 1 | 2 | Current scene only |
| 2 | 3 | Current scene only |
| 3 | 4 | Current scene + adjacent scenes (adjacent = level 3) |
| 4 | 5 | Current scene + adjacent scenes (adjacent = level 4) |
| 5 | 5 | Current scene + adjacent scenes (adjacent = level 4) |

Adjacent scene light = fire light level - 1 (decay). Only applies when fire intensity >= 3.

### Item Light Sources (per-scene)

Scene items with `isLightSource: true` and `lightLevel: number` contribute their level to the scene. Damaged items (`damaged: true`) do not contribute.

Examples:
- Electric light: `lightLevel: 4`
- Oil lamp: `lightLevel: 3`
- Candle: `lightLevel: 2`
- Flashlight: `lightLevel: 3`

---

## Final Light Level Computation

For each scene, every tick:

```
finalLevel = max(
  sunLevel,           // 0 if indoor
  moonLevel,          // 0 if indoor or daytime
  fireLevel,          // from fire featureState + adjacent fire
  ...itemLightLevels  // from undamaged isLightSource items
)
```

If no sources contribute (indoor, no items, no fire): level = 1 (pitch black).

---

## Skill Penalties

| Level | Perception | Navigate | Track | Pistol/Rifle/SMG/Bow | Climb | Drive Auto | Research |
|-------|-----------|----------|-------|---------------------|-------|-----------|----------|
| 1 | -40 | -30 | -40 | -40 | -20 | -30 | -50 |
| 2 | -20 | -15 | -20 | -20 | -10 | -15 | -20 |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 5 | -15 | 0 | -10 | -15 | 0 | 0 | 0 |

---

## SceneItem Changes

```typescript
export interface SceneItem {
  id: string;
  name: string;
  description?: string;
  damaged?: boolean;
  damageDetails?: { damagedBy: string; damagedAt: string; reason: string };
  isLightSource?: boolean;  // NEW
  lightLevel?: number;      // NEW: light level this item provides (1-5)
}
```

---

## Internal State

```typescript
interface LightingSceneState {
  lightLevel: number;   // final computed light level (1-5)
  sources: string[];    // contributing source names (for debugging/display)
}
```

Stored via: `dgsm.setFeatureSceneState("lighting", sceneId, state)`

---

## WorldFeature Interface

| Hook | Used | Purpose |
|------|------|---------|
| `tick()` | Yes | Compute all light sources, calculate per-scene levels, write sceneConditions |
| `activate()` | No | Lighting is purely computed from other state |
| `propagate()` | No | No spatial spread (fire adjacency handled in tick computation) |
| `planNodeSchema` | undefined | LLM does not output lighting fields |
| `planningPrompt` | Read-only | Describes current lighting for LLM context |
| `stateDescription()` | Yes | Lists scenes with non-normal light levels |

---

## Feature Ordering

Lighting must tick **after** fire and weather features, since it reads their state. The tick order in tickProcessor is determined by registration order in `registerDefaults.ts`:

```
1. fireFeature.tick()      → updates fire intensity
2. weatherFeature.tick()   → updates weather state
3. lightingFeature.tick()  → reads fire + weather, computes lighting
```

---

## File Structure

```
src/dynamicworldagent/engine/features/
  lightingFeature.ts    — LightingSceneState type + WorldFeature implementation
  __tests__/lightingFeature.test.ts
```

Registration: `registry.registerFeature(lightingFeature)` in `registerDefaults.ts` — must be registered after fire and weather.
