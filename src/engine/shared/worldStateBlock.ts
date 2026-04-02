/**
 * Shared helper to build a world-state description block
 * (weather, fire, stamina, sanity) for injection into LLM prompts.
 *
 * Used by both the NPC planner and the interaction state resolvers
 * so that every LLM call has consistent environmental awareness.
 */

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { GameEngineRegistry } from "../registry.js";
import { getTopologyNeighbors } from "./topologyHelpers.js";

// ─── Fire perception ─────────────────────────────────────────────────

const INTENSITY_LABELS = [
  "",
  "Smoldering",
  "Small Fire",
  "Burning",
  "Blazing",
  "Inferno",
];

function buildPerceivedFireState(
  dgsm: DynamicGameStateManager,
  location: string
): string {
  const fireStates = dgsm.getFeatureState("fire");
  if (!fireStates || Object.keys(fireStates).length === 0) return "";

  const topology = dgsm.getTopology();

  const perceivedFires: Array<{
    sceneId: string;
    intensity: number;
    label: string;
  }> = [];

  for (const [fireSceneId, state] of Object.entries(fireStates)) {
    const fs = state as { intensity: number; phase?: string } | undefined;
    if (!fs || fs.intensity <= 0) continue;

    if (fireSceneId === location) {
      perceivedFires.push({
        sceneId: fireSceneId,
        intensity: fs.intensity,
        label: INTENSITY_LABELS[fs.intensity] ?? INTENSITY_LABELS[5],
      });
      continue;
    }

    if (fs.intensity >= 3) {
      let isAdjacent = false;
      if (topology) {
        const neighbors = getTopologyNeighbors(fireSceneId, topology);
        isAdjacent = neighbors.includes(location);
      } else {
        const fireScene = dgsm.getScene(fireSceneId);
        isAdjacent =
          fireScene?.connections.some((c) => c.targetId === location) ?? false;
      }
      if (isAdjacent) {
        perceivedFires.push({
          sceneId: fireSceneId,
          intensity: fs.intensity,
          label: INTENSITY_LABELS[fs.intensity] ?? INTENSITY_LABELS[5],
        });
      }
    }
  }

  if (perceivedFires.length === 0) return "";
  const lines = perceivedFires.map((f) =>
    f.sceneId === location
      ? `- ${f.sceneId}: intensity ${f.intensity}/5 (${f.label}) — HERE`
      : `- ${f.sceneId}: intensity ${f.intensity}/5 (${f.label}) — visible from current location`
  );
  return "Nearby fires:\n" + lines.join("\n");
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Build a world-state prompt block scoped to a specific character + location.
 *
 * Includes: weather (global), fire (perception-based), stamina & sanity
 * (character-specific). Returns empty string when registry is absent or
 * no features have meaningful state.
 */
export function buildWorldStateBlock(
  dgsm: DynamicGameStateManager,
  characterId: string,
  location: string,
  registry?: GameEngineRegistry
): string {
  if (!registry) return "";
  const sections: string[] = [];

  // Weather — global, always include
  const weatherFeature = registry.getFeature("weather");
  if (weatherFeature) {
    const weatherState = weatherFeature.stateDescription(dgsm);
    if (weatherState) sections.push(weatherState);
  }

  // Fire — only fires the character can perceive
  if (location) {
    const fireDesc = buildPerceivedFireState(dgsm, location);
    if (fireDesc) sections.push(fireDesc);
  }

  // Stamina — only this character's fatigue
  const staminaStates = dgsm.getFeatureState("stamina") as
    | Record<
        string,
        { fatigue?: number; fatigueLevel?: number; minutesSinceLastRest?: number }
      >
    | undefined;
  if (staminaStates?.[characterId]) {
    const stamina = staminaStates[characterId];
    if (stamina.fatigueLevel && stamina.fatigueLevel > 0) {
      const fatigue = Math.max(
        0,
        stamina.fatigue ?? stamina.minutesSinceLastRest ?? 0
      );
      const score = Math.max(
        0,
        Math.min(100, Math.round((fatigue / 960) * 100))
      );
      const label = stamina.fatigueLevel === 1 ? "Tired" : "Exhausted";
      sections.push(`Fatigue: ${label} (${score}/100)`);
    }
  }

  // Sanity — only this character's active insanity
  const sanityStates = dgsm.getFeatureState("sanity") as
    | Record<
        string,
        {
          activeInsanity?: {
            isActive?: boolean;
            insanityType?: string;
            boutType?: string;
            description?: string;
            actionRestriction?: string;
          };
        }
      >
    | undefined;
  if (sanityStates?.[characterId]) {
    const sanity = sanityStates[characterId];
    if (sanity.activeInsanity?.isActive) {
      const ai = sanity.activeInsanity;
      sections.push(
        `Active insanity: ${ai.insanityType} (${ai.boutType}) — ${ai.description} | restriction: ${ai.actionRestriction}`
      );
    }
  }

  if (sections.length === 0) return "";
  return "## World Conditions\n\n" + sections.join("\n") + "\n";
}
