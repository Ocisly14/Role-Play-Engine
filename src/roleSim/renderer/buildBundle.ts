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
  charactersAtSameLocation,
  resolvePerceivedLocation,
  unnoticedCandidates,
} from "../../state/perceivedLocation.js";
import type {
  OwnActionState,
  PerceivedBundle,
  PerceivedConcealedWay,
  PerceivedOutOfViewItem,
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
}

export function buildPerceivedBundle(
  params: BuildBundleParams
): PerceivedBundle {
  const { npcId, report, occurrencesForNpc, dgsm, engine } = params;

  const scene = resolveScene(npcId, dgsm);
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
  dgsm: DynamicGameStateManager
): PerceivedBundle["scene"] {
  // Roads are places too — a traveller mid-route perceives the
  // street they are on, not "an indistinct place".
  // Same resolver as the trust boundary reads: what is in plain view is
  // rendered and citable alike. What is out of view rides separately
  // (`outOfView`) for the renderer to judge; it becomes citable only once a
  // paragraph has written its tag.
  const location = resolvePerceivedLocation(
    dgsm.getCharacterPosition(npcId),
    dgsm,
    npcId
  );
  if (location) {
    return {
      id: location.id,
      name: location.name,
      setting: location.setting,
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
        if (item.placement !== undefined) entry.placement = item.placement;
        if (item.quantity !== undefined) entry.quantity = item.quantity;
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
      ...outOfViewAt(npcId, dgsm),
    };
  }

  return {
    id: "",
    name: "an indistinct place",
    setting: "",
    activeConditions: [],
    items: [],
    adjacentPlaces: [],
  };
}

/** What is here but out of plain view, for the renderer to judge: things
 *  in, under or behind something (with that container's own description),
 *  and concealed ways through (by the place they lead to). */
function outOfViewAt(
  npcId: string,
  dgsm: DynamicGameStateManager
): Pick<PerceivedBundle["scene"], "outOfView"> {
  const position = dgsm.getCharacterPosition(npcId);
  const hidden = unnoticedCandidates(position, dgsm);
  if (hidden.items.length === 0 && hidden.connectionIds.length === 0) {
    return {};
  }
  const placeId = position ? dgsm.resolveLocationId(position) : "";
  const place = dgsm.getScene(placeId);
  const placeItems = place?.items ?? [];
  const items = hidden.items.map((item): PerceivedOutOfViewItem => {
    const box =
      item.container !== undefined
        ? placeItems.find((i) => i.id === item.container)
        : undefined;
    return {
      id: item.id,
      name: item.name,
      ...(item.description !== undefined
        ? { description: item.description }
        : {}),
      ...(item.placement !== undefined ? { placement: item.placement } : {}),
      ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
      ...(box
        ? {
            container: {
              id: box.id,
              name: box.name,
              ...(box.description !== undefined
                ? { description: box.description }
                : {}),
            },
          }
        : {}),
    };
  });
  const ways: PerceivedConcealedWay[] = [];
  for (const connection of place?.connections ?? []) {
    if (!hidden.connectionIds.includes(connection.id)) continue;
    ways.push({
      id: connection.targetId,
      name: placeName(connection.targetId, dgsm),
      ...(connection.description !== undefined
        ? { description: connection.description }
        : {}),
    });
  }
  return { outOfView: { items, ways } };
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
