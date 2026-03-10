import type {
  WorldFeature,
  TickRuntimeContext,
} from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { applySanityLoss } from "./sanityFeature.js";

// ===== Internal types =====

export interface StaminaCharacterState {
  minutesSinceLastRest: number;
  fatigueLevel: 0 | 1 | 2; // 0=rested, 1=tired, 2=exhausted
  exhaustedDrainTicks: number;
}

interface WeatherRegionState {
  weatherType: string;
  intensity: number;
  affectedSceneIds: string[];
}

interface FireSceneState {
  intensity: number;
}

// ===== Constants =====

const FEATURE_ID = "stamina";
const TIRED_THRESHOLD = 480;       // minutes → fatigue level 1
const EXHAUSTED_THRESHOLD = 960;   // minutes → fatigue level 2
const DRAIN_TICK_INTERVAL = 6;     // check every 6 ticks at exhausted
const BASE_FAIL_CHANCE = 0.3;
const MAX_FAIL_CHANCE = 0.6;
const FIRE_ACCEL_THRESHOLD = 2;    // fire intensity >= 2 → +1x
const WEATHER_ACCEL_THRESHOLD = 3; // extreme weather intensity >= 3 → +1x

// ===== Fatigue level labels =====

const FATIGUE_LABELS: Record<number, string> = {
  0: "rested",
  1: "tired",
  2: "exhausted",
};

const FATIGUE_CONDITION_PREFIX = "[Fatigue]";

const FATIGUE_CONDITIONS: Record<number, string> = {
  1: `${FATIGUE_CONDITION_PREFIX} Tired — eyes heavy, movements sluggish, concentration wavering. Needs rest soon.`,
  2: `${FATIGUE_CONDITION_PREFIX} Exhausted — on the verge of collapse. Hands trembling, vision blurring, barely able to stay on feet.`,
};

// ===== Helper functions =====

function getStaminaState(dgsm: DynamicGameStateManager, characterId: string): StaminaCharacterState | undefined {
  return dgsm.getFeatureSceneState(FEATURE_ID, characterId) as StaminaCharacterState | undefined;
}

function setStaminaState(dgsm: DynamicGameStateManager, characterId: string, state: StaminaCharacterState): void {
  dgsm.setFeatureSceneState(FEATURE_ID, characterId, state);
}

function computeFatigueLevel(minutesSinceLastRest: number): 0 | 1 | 2 {
  if (minutesSinceLastRest >= EXHAUSTED_THRESHOLD) return 2;
  if (minutesSinceLastRest >= TIRED_THRESHOLD) return 1;
  return 0;
}

/**
 * Compute environmental acceleration multiplier for a character at a given scene.
 * Base is 1x. +1x if fire intensity >= 2 at scene. +1x if extreme weather (intensity >= 3)
 * affects the scene. Both stack → max 3x.
 */
function getAccelerationMultiplier(dgsm: DynamicGameStateManager, sceneId: string): number {
  let multiplier = 1;

  // Check fire at this scene
  const fireState = dgsm.getFeatureSceneState("fire", sceneId) as FireSceneState | undefined;
  if (fireState && fireState.intensity >= FIRE_ACCEL_THRESHOLD) {
    multiplier += 1;
  }

  // Check weather — iterate all weather regions looking for extreme types affecting this scene
  const weatherStates = dgsm.getFeatureState("weather") as Record<string, WeatherRegionState>;
  for (const regionId of Object.keys(weatherStates)) {
    const ws = weatherStates[regionId];
    if (!ws) continue;
    if (
      (ws.weatherType === "extreme_heat" || ws.weatherType === "extreme_cold") &&
      ws.intensity >= WEATHER_ACCEL_THRESHOLD &&
      ws.affectedSceneIds?.includes(sceneId)
    ) {
      multiplier += 1;
      break; // Only count weather once
    }
  }

  return multiplier;
}

/**
 * Roll 1d3 — returns 1, 2, or 3
 */
function roll1d3(): number {
  return Math.floor(Math.random() * 3) + 1;
}

/**
 * Compute the CON fail chance for an exhausted character.
 * failChance = min(0.6, 0.3 + (minutesSinceLastRest - 960) / 960 * 0.3)
 */
function computeFailChance(minutesSinceLastRest: number): number {
  const extra = ((minutesSinceLastRest - EXHAUSTED_THRESHOLD) / EXHAUSTED_THRESHOLD) * 0.3;
  return Math.min(MAX_FAIL_CHANCE, BASE_FAIL_CHANCE + extra);
}

/**
 * Process exhaustion drain for a single character.
 * Every DRAIN_TICK_INTERVAL ticks at exhausted, do a CON check.
 * On fail: -1 HP, -1d3 SAN.
 */
function processExhaustionDrain(
  dgsm: DynamicGameStateManager,
  characterId: string,
  stamina: StaminaCharacterState,
  isPlayer: boolean,
): void {
  stamina.exhaustedDrainTicks++;

  if (stamina.exhaustedDrainTicks >= DRAIN_TICK_INTERVAL) {
    stamina.exhaustedDrainTicks = 0;

    const failChance = computeFailChance(stamina.minutesSinceLastRest);
    if (Math.random() < failChance) {
      // CON check failed — drain HP and SAN
      const sanDrain = roll1d3();

      if (isPlayer) {
        const state = dgsm.getState();
        const player = state.playerCharacter;
        (player.status as any).hp = Math.max(0, player.status.hp - 1);
      } else {
        dgsm.updateNpcHp(characterId, -1);
      }
      // Route SAN drain through sanity feature for insanity trigger checks
      applySanityLoss(dgsm, characterId, -sanDrain, isPlayer, undefined, undefined, "exhaustion");
    }
  }
}

// ===== Character condition injection =====

function updateFatigueCondition(
  dgsm: DynamicGameStateManager,
  characterId: string,
  fatigueLevel: 0 | 1 | 2,
  isPlayer: boolean,
): void {
  const state = dgsm.getState();

  let conditions: string[] | undefined;

  if (isPlayer) {
    conditions = state.playerCharacter?.status?.conditions;
  } else {
    const npc = state.npcCharacters?.find((n: any) => n.id === characterId);
    conditions = npc?.status?.conditions;
  }

  if (!conditions) return;

  // Remove any existing fatigue condition
  const filtered = conditions.filter((c: string) => !c.startsWith(FATIGUE_CONDITION_PREFIX));

  // Add new condition if fatigued
  const newCondition = FATIGUE_CONDITIONS[fatigueLevel];
  if (newCondition) {
    filtered.push(newCondition);
  }

  // Write back
  if (isPlayer) {
    (state.playerCharacter.status as any).conditions = filtered;
  } else {
    const npc = state.npcCharacters?.find((n: any) => n.id === characterId);
    if (npc?.status) {
      (npc.status as any).conditions = filtered;
    }
  }
}

/**
 * Build a list of all tracked characters and their scene locations.
 */
function getTrackedCharacters(dgsm: DynamicGameStateManager): Array<{
  characterId: string;
  sceneId: string;
  isPlayer: boolean;
}> {
  const state = dgsm.getState();
  const result: Array<{
    characterId: string;
    sceneId: string;
    isPlayer: boolean;
  }> = [];

  // Player
  if (state.playerCharacter?.id && state.currentSceneId) {
    result.push({
      characterId: state.playerCharacter.id,
      sceneId: state.currentSceneId,
      isPlayer: true,
    });
  }

  // NPCs
  for (const [npcId, sceneId] of Object.entries(state.npcLocations)) {
    result.push({
      characterId: npcId,
      sceneId,
      isPlayer: false,
    });
  }

  return result;
}

// ===== Exported feature =====

export const staminaFeature: WorldFeature = {
  id: FEATURE_ID,
  description: "Fatigue and stamina system — tracks per-character fatigue with environmental acceleration and exhaustion drain",

  planningPrompt: `## Fatigue / Stamina
- Characters accumulate fatigue over time. After ~8 hours (480 min) they become tired; after ~16 hours (960 min) they become exhausted.
- Exhausted characters risk HP and SAN loss from failed CON checks.
- Environmental hazards (intense fire, extreme weather) accelerate fatigue accumulation.
- NPCs should consider resting when tired and urgently seek shelter when exhausted.
- You do NOT control fatigue directly — it is tracked automatically by the stamina system.`,

  stateDescription(dgsm: DynamicGameStateManager): string {
    const allStates = dgsm.getFeatureState(FEATURE_ID) as Record<string, StaminaCharacterState>;
    const lines: string[] = [];

    for (const [characterId, stamina] of Object.entries(allStates)) {
      if (!stamina || stamina.fatigueLevel === 0) continue;
      const hours = (stamina.minutesSinceLastRest / 60).toFixed(1);
      const label = FATIGUE_LABELS[stamina.fatigueLevel] ?? "unknown";
      const name = characterId;
      lines.push(`- ${name}: ${label} (${hours}h active)`);
    }

    return lines.length > 0 ? "Character fatigue:\n" + lines.join("\n") : "";
  },

  getCharacterSkillModifiers(characterId: string, dgsm: DynamicGameStateManager): Array<{ skill: string; delta: number }> {
    const stamina = getStaminaState(dgsm, characterId);
    if (!stamina || stamina.fatigueLevel === 0) return [];

    // Tired: all skills -10, Exhausted: all skills -20
    const delta = stamina.fatigueLevel === 1 ? -10 : -20;
    return [{ skill: "*", delta }];
  },

  tick(dgsm: DynamicGameStateManager, runtime: TickRuntimeContext): void {
    const characters = getTrackedCharacters(dgsm);

    for (const { characterId, sceneId, isPlayer } of characters) {
      // Get or create stamina state
      let stamina = getStaminaState(dgsm, characterId);
      if (!stamina) {
        stamina = {
          minutesSinceLastRest: 0,
          fatigueLevel: 0,
          exhaustedDrainTicks: 0,
        };
      }

      // Compute environmental acceleration
      const multiplier = getAccelerationMultiplier(dgsm, sceneId);
      const effectiveMinutes = runtime.tickDurationMinutes * multiplier;

      // Accumulate fatigue
      stamina.minutesSinceLastRest += effectiveMinutes;
      const prevLevel = stamina.fatigueLevel;
      stamina.fatigueLevel = computeFatigueLevel(stamina.minutesSinceLastRest);

      // Inject/remove fatigue condition on level change
      if (stamina.fatigueLevel !== prevLevel) {
        updateFatigueCondition(dgsm, characterId, stamina.fatigueLevel, isPlayer);
      }

      // Process exhaustion drain if at level 2
      if (stamina.fatigueLevel === 2) {
        processExhaustionDrain(dgsm, characterId, stamina, isPlayer);
      } else {
        stamina.exhaustedDrainTicks = 0;
      }

      // Persist
      setStaminaState(dgsm, characterId, stamina);
    }
  },
};
