// src/roleSim/renderer/buildBundle.ts
//
// Per-NPC PerceivedBundle assembler (plan Phase 9). Picks the NPC's current
// scene from DGSM, derives `ownAction` from the EngineAction lifecycle (this
// tick's transitions first, live action otherwise), and packages the
// occurrence slice the controller routed to this perceiver.

import type { EngineAction, Occurrence } from "../../engine/actions/types.js";
import type { TickEngine } from "../../engine/core/tickEngine.js";
import type { TickReport } from "../../engine/core/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  charactersAtSameLocation,
  resolvePerceivedLocation,
} from "../../state/perceivedLocation.js";
import type {
  OwnActionState,
  PerceivedBundle,
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
      const activeAction = engine
        .getActorActions(id)
        .find((a) => a.status === "active");
      const spot = dgsm.getCharacterSpot(id);
      return {
        id,
        name: profile.name,
        appearance: profile.appearance,
        ...(spot ? { spot } : {}),
        conditions: profile.status?.conditions ?? [],
        currentActionText: activeAction?.command.description,
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
  const location = resolvePerceivedLocation(
    dgsm.getCharacterPosition(npcId),
    dgsm
  );
  if (location) {
    return {
      id: location.id,
      name: location.name,
      description: location.description,
      activeConditions: location.conditions,
    };
  }

  return {
    id: "",
    name: "an indistinct place",
    description: "",
    activeConditions: [],
  };
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
      const judgement = readJudgement(action);
      return {
        kind: "ended",
        description: action?.command.description ?? "",
        status: ended.to as EndedStatus,
        ...(judgement || ended.reason
          ? {
              outcome: {
                outcome: judgement?.outcome ?? ended.to,
                ...((judgement?.reason ?? ended.reason)
                  ? { reason: judgement?.reason ?? ended.reason }
                  : {}),
              },
            }
          : {}),
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
    };
  }

  return { kind: "idle" };
}

function readJudgement(
  action: EngineAction | undefined
): { outcome: string; reason?: string } | undefined {
  const j = action?.runtime?.judgement as
    | { outcome?: string; reason?: string }
    | undefined;
  if (!j || typeof j.outcome !== "string") return undefined;
  return {
    outcome: j.outcome,
    ...(typeof j.reason === "string" ? { reason: j.reason } : {}),
  };
}
