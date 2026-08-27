// src/simulation/characterInjection.ts

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { DynamicNPCProfile } from "../state/types.js";

/**
 * Build a DynamicNPCProfile for a player-injected character.
 * HP = floor((CON + SIZ) / 10), SAN = POW, luck from attributes.luck ?? 50.
 */
export function buildInjectedProfile(input: {
  name: string;
  attributes: DynamicNPCProfile["attributes"];
  skills: Record<string, number>;
  backstory: string;
  residence: string;
  personality?: string;
  occupation?: string;
  age?: number;
  gender?: string;
}): DynamicNPCProfile {
  const { attributes } = input;

  const hp = Math.floor((attributes.CON + attributes.SIZ) / 10);
  const san = attributes.POW;
  const luck = typeof attributes["luck"] === "number" ? attributes["luck"] : 50;

  return {
    id: randomUUID(),
    name: input.name,
    attributes,
    skills: input.skills,
    backstory: input.backstory,
    residence: input.residence,
    personality: input.personality,
    occupation: input.occupation,
    age: input.age,
    gender: input.gender,
    inventory: [],
    status: {
      hp,
      maxHp: hp,
      san,
      maxSan: 99,
      fatigue: 0,
      maxFatigue: 100,
      luck,
      conditions: [],
    },
    longTermIntent: input.backstory,
    relationships: [],
    isPlayerInjected: true,
  };
}

/**
 * Inject a player-created character profile into the game state.
 * Registers the NPC, sets its scene location and character position,
 * and initialises all per-NPC Record maps.
 */
export function injectCharacterIntoState(
  dgsm: DynamicGameStateManager,
  profile: DynamicNPCProfile,
  entrySceneId: string
): void {
  // Add NPC profile to npcCharacters
  dgsm.updateNpcs([profile]);

  // Set character position
  dgsm.setCharacterPosition(profile.id, {
    type: "scene",
    sceneId: entrySceneId,
  });

  // Cast readonly away for the shallow Record maps (Readonly is shallow in TypeScript)
  const state = dgsm.getState() as ReturnType<typeof dgsm.getState> & {
    npcStats: Record<string, { hp: number; san: number }>;
    npcResidences: Record<string, string>;
    npcInventories: Record<string, import("../state/types.js").Item[]>;
    npcRelationshipGraph: Record<
      string,
      Record<string, { score: number; note: string }>
    >;
  };

  // Initialise npcStats (uses `san` not `sanity`)
  state.npcStats[profile.id] = {
    hp: profile.status.hp,
    san: profile.status.san,
  };

  // Initialise residence
  if (profile.residence) {
    state.npcResidences[profile.id] = profile.residence;
  }

  // Initialise empty inventory record
  state.npcInventories[profile.id] = [];

  // Seed the relationship graph from the profile, exactly as moduleLoader
  // does for module-authored NPCs. The graph — not `profile.relationships` —
  // is what decides whether this character may call someone by name, so
  // dropping the seed here would leave an injected character unable to
  // recognise people they arrive already knowing.
  const rels: Record<string, { score: number; note: string }> = {};
  for (const rel of profile.relationships ?? []) {
    if (!rel.targetId || rel.targetId === profile.id) continue;
    const r = rel as { score?: number; attitude?: number; note?: string };
    rels[rel.targetId] = {
      score: r.score ?? r.attitude ?? 0,
      note: r.note ?? "",
    };
  }
  state.npcRelationshipGraph[profile.id] = rels;
}

/**
 * Remove a player-injected character from game state and clean up all
 * associated Prisma records (intent, daily plans, memories).
 */
export async function removeCharacterFromState(
  dgsm: DynamicGameStateManager,
  prisma: PrismaClient,
  sessionId: string,
  characterId: string
): Promise<void> {
  dgsm.setCharacterHidden(characterId, false);

  const state = dgsm.getState() as ReturnType<typeof dgsm.getState> & {
    npcCharacters: DynamicNPCProfile[];
    npcStats: Record<string, { hp: number; san: number }>;
    npcResidences: Record<string, string>;
    npcInventories: Record<string, import("../state/types.js").Item[]>;
    npcRelationshipGraph: Record<
      string,
      Record<string, { score: number; note: string }>
    >;
    characterPositions: Record<
      string,
      import("../state/topologyTypes.js").CharacterPosition
    >;
  };

  // Remove from npcCharacters array
  (state as { npcCharacters: DynamicNPCProfile[] }).npcCharacters =
    state.npcCharacters.filter((npc) => npc.id !== characterId);

  // Delete from all per-NPC Record maps
  delete state.npcStats[characterId];
  delete state.npcResidences[characterId];
  delete state.npcInventories[characterId];
  delete state.characterPositions[characterId];

  // Bidirectional relationship graph cleanup
  // 1. Delete the character's own relationship entry
  delete state.npcRelationshipGraph[characterId];
  // 2. Remove references to this character from all other entries
  for (const otherId of Object.keys(state.npcRelationshipGraph)) {
    delete state.npcRelationshipGraph[otherId][characterId];
  }

  // Prisma cleanup — delete this NPC's memory rows for the session.
  // Phase F dropped npc_long_term_intents + npc_daily_plans tables; long-term
  // intent now lives as a memory row, swept by the npcMemory deleteMany below.
  await prisma.npcMemory.deleteMany({
    where: { sessionId, npcId: characterId },
  });
}

/**
 * Given a macro location ID (ScenarioOutline.id), return the entrySceneId
 * of that outline, or null if not found or not set.
 */
export function resolveEntryScene(
  dgsm: DynamicGameStateManager,
  macroLocationId: string
): string | null {
  const state = dgsm.getState();
  const outline = state.scenarioOutlines.find((o) => o.id === macroLocationId);
  if (!outline) return null;
  return outline.entrySceneId ?? null;
}
