# Stamina Feature Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract the existing binary staminaState into a WorldFeature with 3-level fatigue system, unified environmental drain, and NPC support.

**Architecture:** Stamina is a tick-driven WorldFeature that tracks per-character fatigue via accumulated activity minutes. It reads fire and weather feature state each tick to accelerate drain in harsh environments. At exhausted level, it performs CON checks and drains HP + SAN.

---

## Fatigue Levels

| Level | Name | Accumulated Activity | Effect |
|-------|------|---------------------|--------|
| 0 | rested | 0-480 min (8h) | None |
| 1 | tired | 480-960 min (16h) | Skill difficulty +1 level |
| 2 | exhausted | 960+ min | Skill difficulty +2 levels, every 6 ticks CON check — fail: -1 HP, -1d3 SAN |

Difficulty escalation:
- +1 level: regular → hard, hard → extreme, extreme → extreme
- +2 levels: regular → extreme, hard → extreme, extreme → extreme

---

## Recovery

| Rest Duration | Effect |
|--------------|--------|
| < 240 min (4h) | No effect |
| 240-479 min (4-8h) | Drop one level (exhausted→tired or tired→rested) |
| ≥ 480 min (8h) | Reset to rested, restore HP 30% of max, restore SAN 10% of max |

---

## Environmental Acceleration

Stamina feature reads other features' state each tick to accelerate fatigue accumulation:

- **Extreme weather** (extreme_heat or extreme_cold, intensity ≥ 3): extra `tickDurationMinutes` per tick (2x fatigue rate)
- **Fire smoke** (fire intensity ≥ 2, character in that scene): extra `tickDurationMinutes` per tick (2x fatigue rate)

Both stack: extreme weather + fire smoke = 3x fatigue rate.

---

## Exhausted HP + SAN Drain

When fatigueLevel = 2:

1. Increment `exhaustedDrainTicks` each tick
2. Every 6 ticks, perform CON check:
   - Failure chance: `0.3 + (minutesSinceLastRest - 960) / 960 * 0.3` (capped at 0.6)
   - Baseline 30% at 960 min, scaling to 60% at 1920 min
3. On failure: -1 HP, -1d3 SAN

Applies to both player and NPCs.

---

## Internal State

```typescript
interface StaminaCharacterState {
  minutesSinceLastRest: number;
  fatigueLevel: 0 | 1 | 2;
  exhaustedDrainTicks: number;
}
```

Stored via: `dgsm.setFeatureSceneState("stamina", characterId, state)` — uses characterId as secondary key.

---

## WorldFeature Interface

| Hook | Used | Purpose |
|------|------|---------|
| `tick()` | Yes | Accumulate activity minutes for all characters, check environmental acceleration (fire/weather), exhausted HP+SAN drain |
| `activate()` | No | Fatigue is purely tick-driven |
| `propagate()` | No | No spatial spread |
| `planNodeSchema` | undefined | LLM does not output stamina fields |
| `planningPrompt` | Yes | Describes fatigue rules so NPC planning considers rest |
| `stateDescription()` | Yes | Lists all non-rested characters with fatigue level |

---

## Changes to Existing Code

### DynamicGameState.ts

- `staminaState` field kept for backward compatibility
- `addFatigueMinutes()` / `isFatigued()` / `applyRest()` kept, internals updated to read/write feature state
- Add `getFatigueLevel(characterId)` method returning 0/1/2

### weatherFeature.ts

- Remove `exposureTicks` from `WeatherRegionState`
- Remove `processExposureDrain()` function
- Remove `HP_DRAIN_INTERVAL` and `HP_DRAIN_INTENSITY_THRESHOLD` constants
- Weather becomes pure: evolution + skill penalties + connection blocking

### Combat templates / handlers

- Replace `isFatigued()` boolean check with `getFatigueLevel()` → level 1: difficulty +1, level 2: difficulty +2

---

## Feature Registration Order

```
1. fireFeature.tick()      → updates fire intensity
2. weatherFeature.tick()   → updates weather state
3. lightingFeature.tick()  → reads fire + weather, computes lighting
4. staminaFeature.tick()   → reads fire + weather, computes fatigue
```

---

## File Structure

```
src/dynamicworldagent/engine/features/
  staminaFeature.ts                    — StaminaCharacterState + WorldFeature implementation
  __tests__/staminaFeature.test.ts
```

Registration: `registry.registerFeature(staminaFeature)` in `registerDefaults.ts` — must be registered after fire and weather.
