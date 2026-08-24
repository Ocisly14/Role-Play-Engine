// src/roleSim/renderer/buildBundle.ts
//
// Per-NPC PerceivedBundle assembler (G10). Picks the NPC's current scene from
// DGSM, derives `ownAction` from the engine queue + this tick's TickReport,
// and packages the propagated event slice the controller already computed.

import type { TickEngine } from "../../engine/core/tickEngine.js";
import type {
  CharacterAction,
  FeatureEvent,
  TickReport,
} from "../../engine/core/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type {
  OwnActionState,
  PerceivedBundle,
  ScenePresentCharacter,
} from "./types.js";

export interface BuildBundleParams {
  npcId: string;
  /** Provide for in-tick rendering. Omit for bootstrap / pre-tick render
   *  passes — `ownAction` is then derived purely from the engine queue. */
  report?: TickReport;
  /** FeatureEvents that propagated to this NPC (controller-side filter). */
  eventsForNpc?: FeatureEvent[];
  /** Committed CharacterActions whose impact reached this NPC this tick.
   *  Always excludes the NPC's own action (already represented by ownAction). */
  actionsForNpc?: CharacterAction[];
  dgsm: DynamicGameStateManager;
  engine: TickEngine;
}

export function buildPerceivedBundle(
  params: BuildBundleParams
): PerceivedBundle {
  const { npcId, report, eventsForNpc, actionsForNpc, dgsm, engine } = params;

  const scene = resolveScene(npcId, dgsm);
  const ownConditions = dgsm.getNpcProfile(npcId)?.status?.conditions ?? [];
  const ownAction = resolveOwnAction(npcId, report, engine);
  const charactersInScene = resolveScenePresentCharacters(
    npcId,
    scene.id,
    dgsm,
    engine
  );

  return {
    scene,
    ownConditions,
    ownAction,
    events: eventsForNpc ?? [],
    perceivedActions: (actionsForNpc ?? []).filter(
      (a) => a.characterId !== npcId
    ),
    charactersInScene,
  };
}

function resolveScenePresentCharacters(
  viewpointId: string,
  sceneId: string,
  dgsm: DynamicGameStateManager,
  engine: TickEngine
): ScenePresentCharacter[] {
  if (!sceneId) return [];
  return dgsm
    .getCharactersInScene(sceneId)
    .filter((id) => id !== viewpointId && dgsm.isNpcAlive(id))
    .map((id): ScenePresentCharacter | null => {
      const profile = dgsm.getNpcProfile(id);
      if (!profile) return null;
      const activeStep = engine
        .getActorQueue(id)
        .find((s) => s.status === "active");
      return {
        id,
        name: profile.name,
        appearance: profile.appearance,
        conditions: profile.status?.conditions ?? [],
        currentActionText: activeStep?.actionText,
      };
    })
    .filter((c): c is ScenePresentCharacter => c !== null);
}

function resolveScene(
  npcId: string,
  dgsm: DynamicGameStateManager
): PerceivedBundle["scene"] {
  const position = dgsm.getCharacterPosition(npcId);
  const sceneId =
    position && position.type === "scene" ? position.sceneId : null;
  const scene = sceneId ? dgsm.getScene(sceneId) : null;

  if (scene) {
    return {
      id: scene.id,
      name: scene.name,
      description: scene.description,
      activeConditions: scene.conditions ?? [],
    };
  }

  return {
    id: sceneId ?? "",
    name: "an indistinct place",
    description: "",
    activeConditions: [],
  };
}

function resolveOwnAction(
  npcId: string,
  report: TickReport | undefined,
  engine: TickEngine
): OwnActionState {
  if (report) {
    const committed = report.commits.find((a) => a.characterId === npcId);
    if (committed) return endedFrom(committed, "committed");

    const cancelled = report.cancellations.find((a) => a.characterId === npcId);
    if (cancelled) return endedFrom(cancelled, "cancelled");
  }

  const queue = engine.getActorQueue(npcId);
  const active = queue.find((s) => s.status === "active");
  if (active) {
    return { kind: "ongoing", actionText: active.actionText };
  }

  return { kind: "idle" };
}

function endedFrom(
  action: CharacterAction,
  status: "committed" | "cancelled"
): OwnActionState {
  return {
    kind: "ended",
    actionText: action.actionText,
    status,
  };
}
