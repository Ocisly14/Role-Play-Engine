# Weather Feature Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a regional weather WorldFeature with 7 weather types, Markov chain evolution, and mechanical effects (skill penalties, connection blocking, HP drain).

**Architecture:** Weather is a tick-driven WorldFeature plugin with no LLM interaction. Each region (= parentLocationId) has an independent weather state that evolves via Markov chain transitions. Only outdoor scenes are affected.

---

## Core Model

### Weather Types

7 types, 6 with intensity 1-5 (clear has no intensity levels):

| Type | Description |
|------|-------------|
| clear | No weather effects |
| rain | Rain, from drizzle to downpour |
| fog | Fog, from light mist to zero visibility |
| storm | Wind and rain, from breeze to hurricane |
| snow | Snow, from flurries to blizzard |
| extreme_heat | High temperature, from warm to lethal |
| extreme_cold | Low temperature, from chilly to lethal |

### Region Model

- `regionId` = `DynamicScene.parentLocationId`
- All outdoor scenes under the same parentLocationId share one weather state
- `DynamicScene` gets new field: `indoor?: boolean` (default false)

### Internal State

```typescript
type WeatherType = "clear" | "rain" | "fog" | "storm" | "snow" | "extreme_heat" | "extreme_cold";

interface WeatherRegionState {
  weatherType: WeatherType;
  intensity: number;           // 0-5, 0 = clear
  ticksInState: number;
  affectedSceneIds: string[];  // outdoor scenes in this region
  exposureTicks?: Record<string, number>; // characterId -> accumulated exposure ticks (extreme temps)
}
```

Stored via: `dgsm.setFeatureSceneState("weather", regionId, state)`

### Initialization

Module preset format (in module_digest or scenario data):

```json
{
  "weatherPresets": [
    { "regionId": "innsmouth_town", "weatherType": "fog", "intensity": 2 },
    { "regionId": "arkham_campus", "weatherType": "clear", "intensity": 0 }
  ]
}
```

On first `tick()`, if no weather state exists, read presets from module data. Regions without presets default to `clear`.

---

## Markov Chain Evolution

### Transition Check

Every 6 ticks (30 minutes), check for weather type transition.

### Type Transition Matrix

```
           clear  rain   fog   storm  snow   heat   cold
clear      0.65   0.10   0.10  0.02   0.03   0.05   0.05
rain       0.10   0.45   0.10  0.20   0.05   0.00   0.10
fog        0.25   0.15   0.55  0.00   0.03   0.02   0.00
storm      0.05   0.35   0.00  0.50   0.05   0.00   0.05
snow       0.05   0.05   0.05  0.05   0.55   0.00   0.25
heat       0.25   0.00   0.05  0.03   0.00   0.67   0.00
cold       0.10   0.00   0.05  0.05   0.20   0.00   0.60
```

Design rationale:
- Diagonal values highest (weather tends to persist)
- Natural chains: clear <-> rain <-> storm, clear <-> fog, cold <-> snow
- Impossible transitions = 0 (fog -> storm, heat -> cold, rain -> heat)
- Rain -> cold (cold front), fog -> rain (common co-occurrence), storm -> rain (storm weakening)

### Intensity Evolution

- **Type changes**: new weather starts at intensity 1
- **Same type persists**: each check period intensity changes by:
  - 60% chance: no change
  - 20% chance: +1 (capped at 5)
  - 20% chance: -1
- **Intensity drops to 0**: weather reverts to clear

---

## Mechanical Effects

### Skill Penalties

Penalties scale with intensity. Only apply to outdoor scenes (`indoor !== true`).

**Rain:**

| Skill | Trigger | Penalty per level |
|-------|---------|-------------------|
| Perception | >= 1 | -5 |
| Track | >= 1 | -5 |
| Drive Auto | >= 2 | -5 |
| Listen | >= 2 | -5 |
| Climb | >= 2 | -5 |
| Pistol | >= 3 | -5 |
| Rifle | >= 3 | -5 |
| Submachine Gun | >= 3 | -5 |
| Bow | >= 3 | -5 |
| Electrical Repair | >= 3 | -5 |

**Fog:**

| Skill | Trigger | Penalty per level |
|-------|---------|-------------------|
| Perception | >= 1 | -10 |
| Navigate | >= 1 | -5 |
| Drive Auto | >= 2 | -5 |
| Track | >= 2 | -5 |
| Pistol | >= 2 | -5 |
| Rifle | >= 2 | -5 |
| Submachine Gun | >= 2 | -5 |
| Bow | >= 2 | -5 |

**Storm:**

| Skill | Trigger | Penalty per level |
|-------|---------|-------------------|
| Perception | >= 1 | -5 |
| Listen | >= 1 | -5 |
| Drive Auto | >= 1 | -5 |
| Navigate | >= 2 | -5 |
| Climb | >= 2 | -5 |
| Swim | >= 2 | -5 |
| Pilot (Boat) | >= 2 | -5 |
| Pistol | >= 2 | -5 |
| Rifle | >= 2 | -5 |
| Submachine Gun | >= 2 | -5 |
| Bow | >= 2 | -5 |

**Snow:**

| Skill | Trigger | Penalty per level |
|-------|---------|-------------------|
| Perception | >= 1 | -5 |
| Drive Auto | >= 1 | -5 |
| Climb | >= 2 | -5 |
| Track | >= 3 | -5 |
| Navigate | >= 3 | -5 |

**Extreme Heat:**

| Skill | Trigger | Penalty per level |
|-------|---------|-------------------|
| Climb | >= 2 | -5 |
| Stealth | >= 3 | -5 |

**Extreme Cold:**

| Skill | Trigger | Penalty per level |
|-------|---------|-------------------|
| Locksmith | >= 1 | -5 |
| Sleight of Hand | >= 1 | -5 |
| Climb | >= 2 | -5 |
| Mechanical Repair | >= 2 | -5 |
| Electrical Repair | >= 2 | -5 |
| Swim | >= 2 | -10 |
| Pistol | >= 2 | -5 |
| Rifle | >= 2 | -5 |
| Submachine Gun | >= 2 | -5 |
| Bow | >= 2 | -5 |
| First Aid | >= 3 | -5 |

### Connection Blocking

Only outdoor-to-outdoor connections:

| Weather | Threshold | Reason |
|---------|-----------|--------|
| storm | intensity >= 4 | "Blocked by storm (intensity N)" |
| snow | intensity >= 4 | "Blocked by snow (intensity N)" |

### HP Drain (Extreme Temperatures)

- **Trigger**: extreme_heat or extreme_cold, intensity >= 3
- **Frequency**: every 6 ticks
- **Effect**: CON check, failure = -1 HP
- **Scope**: characters in outdoor scenes of the affected region
- **Tracking**: `exposureTicks` in WeatherRegionState counts per-character exposure

---

## WorldFeature Interface

| Hook | Used | Purpose |
|------|------|---------|
| `tick()` | Yes | Markov transition, write sceneConditions, blocking, HP drain |
| `activate()` | No | Weather is pure tick-driven |
| `propagate()` | No | Weather doesn't spread spatially |
| `planNodeSchema` | undefined | LLM doesn't output weather fields |
| `planningPrompt` | Read-only | Describes current weather for LLM context |
| `stateDescription()` | Yes | Lists each region's current weather and intensity |

### Init Logic

On first `tick()`, check if weather featureState is empty. If so, read module weather presets and initialize each region's state. Regions without presets default to `clear`.

---

## DynamicScene Change

```typescript
export interface DynamicScene {
  // ... existing fields
  indoor?: boolean; // default false, weather effects skip indoor scenes
}
```

---

## File Structure

```
src/dynamicworldagent/engine/features/
  weatherFeature.ts    — WeatherRegionState type + WorldFeature implementation
  weatherFeature.test.ts — tests (in __tests__/)
```

Registration: `registry.registerFeature(weatherFeature)` in `registerDefaults.ts`.

---

## Related Fix

`fireFeature.ts`: rename `"Spot Hidden"` to `"Perception"` to match actual skill name in skill defaults.
