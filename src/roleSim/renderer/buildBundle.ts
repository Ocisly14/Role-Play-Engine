// src/roleSim/renderer/buildBundle.ts
//
// Per-NPC PerceivedBundle assembler (plan Phase 9). Picks the NPC's current
// scene from DGSM, derives `ownAction` from the EngineAction lifecycle (this
// tick's transitions first, live action otherwise), and packages the
// occurrence slice the controller routed to this perceiver.

import type { Occurrence } from "../../engine/actions/types.js";
import type { TickEngine } from "../../engine/core/tickEngine.js";
import type { TickReport } from "../../engine/core/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  type NoticedThisMinute,
  charactersAtSameLocation,
  resolvePerceivedLocation,
} from "../../state/perceivedLocation.js";
import type {
  OwnActionState,
  PerceivedBundle,
  PerceivedSceneItem,
  ScenePresentCharacter,
} from "./types.js";

export interface BuildBundleParams {
  npcId: string;
  /** Provide for in-tick rendering. Omit for bootstrap / pre-tick render
   *  passes — `ownAction` is then derived purely from the live action. */
  report?: TickReport;
  /** Occurrences this NPC was listed as perceiver of (controller routing). */
  occurrencesForNpc?: Occurrence[];
  dgsm: DynamicGameStateManager;
  engine: TickEngine;
  /** What the viewer noticed this minute beyond plain view (concealment
   *  design §5.3). Pass the same value to the citation scope. */
  noticed?: NoticedThisMinute;
}

export function buildPerceivedBundle(
  params: BuildBundleParams
): PerceivedBundle {
  const { npcId, report, occurrencesForNpc, dgsm, engine } = params;

  const scene = resolveScene(npcId, dgsm, params.noticed);
  const ownSpot = dgsm.getCharacterSpot(npcId);
  const ownConditions = dgsm.getNpcProfile(npcId)?.status?.conditions ?? [];
  const ownAction = resolveOwnAction(npcId, report, engine);
  const charactersInScene = resolveScenePresentCharacters(npcId, dgsm, engine);

  return {
    scene,
    ...(ownSpot ? { ownSpot } : {}),
    ownConditions,
    ownAction,
    occurrences: occurrencesForNpc ?? [],
    charactersInScene,
  };
}

function resolveScenePresentCharacters(
  viewpointId: string,
  dgsm: DynamicGameStateManager,
  engine: TickEngine
): ScenePresentCharacter[] {
  // Co-location, not scene membership: two NPCs walking the same road are
  // present to each other even though neither is "in a scene".
  return charactersAtSameLocation(viewpointId, dgsm)
    .map((id): ScenePresentCharacter | null => {
      const profile = dgsm.getNpcProfile(id);
      if (!profile) return null;
      const currentAction = resolveOwnAction(id, undefined, engine);
      const spot = dgsm.getCharacterSpot(id);
      return {
        id,
        name: profile.name,
        appearance: profile.appearance,
        ...(spot ? { spot } : {}),
        conditions: profile.status?.conditions ?? [],
        ...(currentAction.kind === "ongoing" ? { currentAction } : {}),
      };
    })
    .filter((c): c is ScenePresentCharacter => c !== null);
}

function resolveScene(
  npcId: string,
  dgsm: DynamicGameStateManager,
  noticed?: NoticedThisMinute
): PerceivedBundle["scene"] {
  // Roads are places too — a traveller mid-route perceives the
  // street they are on, not "an indistinct place".
  // Same resolver AND same `noticed` as the trust boundary reads: a thing
  // this character noticed is rendered for them and citable by them, and one
  // they have not is neither.
  const location = resolvePerceivedLocation(
    dgsm.getCharacterPosition(npcId),
    dgsm,
    npcId,
    noticed
  );
  if (location) {
    return {
      id: location.id,
      name: location.name,
      description: location.description,
      activeConditions: location.conditions,
      // Already free of concealed passages this viewer did not notice:
      // `adjacentIds` filters them, so an unseen door never reaches here.
      adjacentPlaces: location.adjacentIds.map((id) => ({
        id,
        name: placeName(id, dgsm),
      })),
      // The same items the trust boundary lets this actor cite — resolved
      // from the ACTUAL position, so a road item beyond reach is neither
      // rendered nor citable. Distance rides along for the renderer to
      // judge salience (fog, night, attention) in prose.
      items: location.items.map((item): PerceivedSceneItem => {
        const entry: PerceivedSceneItem = { id: item.id, name: item.name };
        if (item.description !== undefined) {
          entry.description = item.description;
        }
        if (
          item.position !== undefined &&
          location.selfPosition !== undefined &&
          location.travelTimeMinutes !== undefined
        ) {
          entry.distanceMinutes = Math.round(
            Math.abs(item.position - location.selfPosition) *
              location.travelTimeMinutes
          );
        }
        return entry;
      }),
    };
  }

  return {
    id: "",
    name: "an indistinct place",
    description: "",
    activeConditions: [],
    items: [],
    adjacentPlaces: [],
  };
}

/** A neighbouring place by the name a person standing here would use. */
function placeName(id: string, dgsm: DynamicGameStateManager): string {
  return (
    dgsm.getScene(id)?.name ?? dgsm.getTopology?.()?.roads.get(id)?.name ?? id
  );
}

const ENDED_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
] as const);
type EndedStatus = "completed" | "failed" | "interrupted" | "cancelled";

export function resolveOwnAction(
  npcId: string,
  report: TickReport | undefined,
  engine: TickEngine
): OwnActionState {
  if (report) {
    const ended = report.transitions.find(
      (t) => t.actorId === npcId && ENDED_STATUSES.has(t.to as EndedStatus)
    );
    if (ended) {
      const action = engine.getAction(ended.actionId);
      return {
        kind: "ended",
        description: action?.command.description ?? "",
        status: ended.to as EndedStatus,
        ...(ended.reason ? { reason: ended.reason } : {}),
      };
    }
  }

  const active = engine
    .getActorActions(npcId)
    .find((a) => a.status === "active");
  if (active) {
    return {
      kind: "ongoing",
      description: active.command.description,
      ...(active.startedAt !== undefined
        ? { startedAt: active.startedAt }
        : {}),
      progressMinutes: active.progressMinutes,
      ...(active.resolvedDurationTicks !== undefined
        ? { resolvedDurationTicks: active.resolvedDurationTicks }
        : {}),
      ...(active.command.utterance?.trim() ? { utterancePending: true } : {}),
    };
  }

  return { kind: "idle" };
}
