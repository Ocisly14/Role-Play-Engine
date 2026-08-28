// src/engine/resolution/contextBuilder.ts
//
// Builds the single full-world EngineResolutionContext (plan D7). Called only
// when an action resolution trigger exists. Everything comes from the same
// tick-start DGSM state; nothing is filtered for "relevance" — the Engine
// judges causal reach itself. Forbidden inputs (renderer text, RoleSim
// thoughts, interpreter output, unflushed deltas) simply have no path in.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { ActionCommand, EngineAction } from "../actions/types.js";
import { ACTION_SCHEMA_VERSION } from "../actions/types.js";
import type { GameTime } from "../core/types.js";
import type {
  CharacterSnapshot,
  DeterministicResult,
  EngineResolutionContext,
  ItemSnapshot,
  ObjectiveWorldEvent,
  ResolutionTrigger,
  SceneSnapshot,
  WorldInvariant,
} from "./types.js";

/** Code-side invariants restated to the Engine and enforced by the validator
 *  regardless of what the model outputs. */
export const WORLD_INVARIANTS: WorldInvariant[] = [
  {
    id: "unique-item-ownership",
    description:
      "An item exists in exactly one place (one scene or one character inventory).",
  },
  {
    id: "real-references",
    description:
      "Every characterId/sceneId/itemId in a delta or occurrence must exist in the snapshot.",
  },
  {
    id: "dead-actors-act-no-more",
    description:
      "A dead character's actions terminate; no new effects originate from them.",
  },
  {
    id: "sourced-changes",
    description:
      "Every delta names its source action/event and a causal basis explaining it.",
  },
  {
    id: "single-transition",
    description: "Each action gets at most one transition per resolution.",
  },
  {
    id: "engine-owned-timing",
    description:
      "resolvedDurationTicks/nextWakeAt come only from the Engine with a timing reason; the actor's proposal is advisory.",
  },
];

export interface BuildContextParams {
  dgsm: DynamicGameStateManager;
  tickId: string;
  tickStartTime: GameTime;
  durationMinutes: number;
  triggers: ResolutionTrigger[];
  newCommands: ActionCommand[];
  activeActions: EngineAction[];
  objectiveWorldEvents?: ObjectiveWorldEvent[];
  deterministicResults?: DeterministicResult[];
}

export function buildEngineResolutionContext(
  params: BuildContextParams
): EngineResolutionContext {
  const { dgsm } = params;
  const state = dgsm.getState();

  // ── Items: flat list across scenes + inventories, with holder refs. ──
  const items: ItemSnapshot[] = [];
  for (const scene of state.scenes.values()) {
    for (const item of scene.items ?? []) {
      items.push(snapshotItem(item, `scene:${scene.id}`));
    }
  }
  for (const [npcId, inventory] of Object.entries(state.npcInventories)) {
    for (const item of inventory ?? []) {
      items.push(snapshotItem(item, npcId));
    }
  }

  // ── Scenes: ALL scenes, objective state only. ──
  const scenes: SceneSnapshot[] = [...state.scenes.values()].map((scene) => {
    const env = dgsm.getEnvironmentReading(scene.id);
    return {
      id: scene.id,
      name: scene.name,
      description: scene.description,
      parentLocationId: scene.parentLocationId,
      ...(scene.indoor !== undefined ? { indoor: scene.indoor } : {}),
      conditions: dgsm.getSceneConditions(scene.id),
      itemIds: (scene.items ?? []).map((i) => i.id),
      connections: (scene.connections ?? []).map((c) => {
        const blockedReason = dgsm.getConnectionBlockReason(
          scene.id,
          c.targetId
        );
        return {
          targetId: c.targetId,
          ...(c.description !== undefined
            ? { description: c.description }
            : {}),
          ...(c.hidden !== undefined ? { hidden: c.hidden } : {}),
          ...(blockedReason !== undefined ? { blockedReason } : {}),
        };
      }),
      environment: {
        temperature: env.temperature,
        illumination: env.illumination,
        oxygen: env.oxygen,
        noise: env.noise,
        airborneHazards: [...env.airborneHazards],
      },
      presentCharacterIds: dgsm.getCharactersInScene(scene.id),
    };
  });

  // ── Characters: ALL characters, real values (skills, stats, knowledge). ──
  const characters: CharacterSnapshot[] = state.npcCharacters.map((npc) => {
    const position = dgsm.getCharacterPosition(npc.id);
    const spot = dgsm.getCharacterSpot(npc.id);
    return {
      id: npc.id,
      name: npc.name,
      ...(npc.occupation !== undefined ? { occupation: npc.occupation } : {}),
      ...(npc.appearance !== undefined ? { appearance: npc.appearance } : {}),
      alive: dgsm.isNpcAlive(npc.id),
      attributes: { ...npc.attributes } as unknown as Record<string, number>,
      skills: { ...npc.skills },
      hp: npc.status.hp,
      maxHp: npc.status.maxHp,
      san: npc.status.san,
      maxSan: npc.status.maxSan,
      fatigue: npc.status.fatigue,
      maxFatigue: npc.status.maxFatigue,
      position,
      locationId: position ? dgsm.resolveLocationId(position) : "",
      ...(spot ? { spot } : {}),
      conditions: npc.status.conditions ?? [],
      inventoryItemIds: dgsm.getNpcInventory(npc.id).map((i) => i.id),
      // Relationships are deliberately absent. They are subjective reading,
      // not world state: the Renderer uses them to decide whether a viewer
      // knows a face, and the character keeps their own `relationship`
      // memories. Putting affinity in front of the adjudicator invites
      // outcomes that turn on who likes whom rather than on objective
      // constraints.
    };
  });

  return {
    trigger: {
      triggers: params.triggers,
      actionIds: [...new Set(params.triggers.flatMap((t) => t.actionIds))],
    },
    tick: {
      tickId: params.tickId,
      tickStartTime: params.tickStartTime,
      durationMinutes: params.durationMinutes,
    },
    rules: {
      resolutionGuide: "src/engine/rules/world-action-resolution.md",
      outputSchemaVersion: ACTION_SCHEMA_VERSION,
      worldInvariants: WORLD_INVARIANTS,
    },
    state: { scenes, items, characters },
    actions: {
      newCommands: params.newCommands,
      activeActions: params.activeActions,
    },
    events: {
      objectiveWorldEvents: params.objectiveWorldEvents ?? [],
      deterministicResults: params.deterministicResults ?? [],
    },
  };
}

function snapshotItem(
  item: {
    id: string;
    name: string;
    description?: string;
    type?: string;
    damaged?: boolean;
  },
  holder: string
): ItemSnapshot {
  return {
    id: item.id,
    name: item.name,
    ...(item.description !== undefined
      ? { description: item.description }
      : {}),
    ...(item.type !== undefined ? { type: item.type } : {}),
    holder,
    ...(item.damaged !== undefined ? { damaged: item.damaged } : {}),
  };
}
