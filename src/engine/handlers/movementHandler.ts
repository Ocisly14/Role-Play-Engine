import type { CharacterAction, PlanNode } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type {
  CharacterPosition,
  TownTopology,
} from "../../state/topologyTypes.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import { findTopologyPath } from "../shared/pathfinding.js";
import type { ExecutionContext, NodeHandler } from "../types.js";

export const movementHandler: NodeHandler = {
  type: "movement",

  description:
    "Move a character to a different location. " +
    "If skill is set, a creative single-hop movement with skill check is attempted. " +
    "Otherwise, topology pathfinding is used to find a route through the scene graph.",

  requiredFields: ["action", "destination"],

  optionalFields: ["skill"],

  exampleNode: {
    nodeId: "m1",
    startTime: "09:00",
    endTime: "09:05",
    type: "movement",
    action: "Walk to the harbor docks",
    destination: "harbor_docks",
    impact: 0,
  },

  execute(
    node: PlanNode,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): CharacterAction {
    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(node.characterId);
    const npcLocation = pos ? dgsm.resolveLocationId(pos) : undefined;
    const targetLocation = node.destination;
    const npc = state.npcCharacters.find((n) => n.id === node.characterId);
    const npcSkills = npc?.skills ?? {};
    const difficulty = ctx.getNodeDifficulty(node, dgsm);

    if (!targetLocation) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "no destination specified" }),
        {
          difficulty,
          location: npcLocation ?? "",
          failureReason: "location_blocked",
        }
      );
    }

    // Scene + character penalties
    const scenePenalties = ctx.getScenePenalties(targetLocation, dgsm);
    const charPenalties = ctx.getCharacterPenalties(node.characterId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    let resolvedSuccessLevel:
      | import("../../planning/types.js").SuccessLevel
      | undefined;
    let lastRollDetail: string | undefined;

    const fromLocation = npcLocation ?? "";

    const lang = ctx.language ?? "en";

    // Creative movement: single hop with skill check, no pathfinding
    if (node.skill) {
      const rollResult = ctx.resolveSkillRoll(node, adjustedSkills, dgsm);
      resolvedSuccessLevel = rollResult.successLevel;
      if (rollResult.failed) {
        lastRollDetail = rollResult.reason;
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { rollDetail: lastRollDetail }, lang),
          {
            difficulty,
            location: fromLocation,
            successLevel: resolvedSuccessLevel,
            failureReason: "skill_roll_failed",
          }
        );
      }
      lastRollDetail = rollResult.detail;
      const topology = dgsm.getTopology();
      const targetPos = resolveTargetPosition(targetLocation, topology, dgsm);
      if (targetPos) {
        dgsm.setCharacterPosition(node.characterId, targetPos);
      }
      return makeAction(
        node,
        "completed",
        buildOutcome(node, "completed", { rollDetail: lastRollDetail }, lang),
        {
          difficulty,
          location: targetLocation,
          successLevel: resolvedSuccessLevel,
        }
      );
    }

    // Topology-based movement
    const topology = dgsm.getTopology();
    const currentPos = dgsm.getCharacterPosition(node.characterId);
    const targetPos = resolveTargetPosition(targetLocation, topology, dgsm);
    if (currentPos && targetPos) {
      const topologyPath = findTopologyPath(
        currentPos,
        targetPos,
        topology,
        state.blockedConnections,
        dgsm
      );

      if (!topologyPath) {
        return makeAction(
          node,
          "failed",
          buildOutcome(
            node,
            "failed",
            {
              reason: "no path available in topology",
            },
            lang
          ),
          {
            difficulty,
            location: fromLocation,
            failureReason: "location_blocked",
          }
        );
      }

      dgsm.setCharacterPosition(node.characterId, targetPos);

      // Emit npc_moved event for simulation viewers
      if (ctx.simulationEmitter) {
        const state = dgsm.getState();
        ctx.simulationEmitter.emitSimulationEvent(
          "npc_moved",
          node.characterId,
          targetLocation,
          state.gameDay,
          state.timeOfDay,
          {
            fromPosition: currentPos,
            toPosition: targetPos,
          }
        );
      }

      return makeAction(
        node,
        "completed",
        buildOutcome(
          node,
          "completed",
          {
            reason: `Traveled via topology in ~${topologyPath.totalMinutes} min`,
          },
          lang
        ),
        {
          difficulty,
          location: targetLocation,
          successLevel: resolvedSuccessLevel,
        }
      );
    }

    // No position or target — cannot move
    return makeAction(
      node,
      "failed",
      buildOutcome(
        node,
        "failed",
        { reason: "no path available in topology" },
        lang
      ),
      {
        difficulty,
        location: fromLocation,
        failureReason: "location_blocked",
      }
    );
  },
};

export function resolveTargetPosition(
  locationId: string,
  topology: TownTopology,
  dgsm?: DynamicGameStateManager
): CharacterPosition | null {
  // Check junctions
  if (topology.junctions.has(locationId)) {
    return { type: "junction", junctionId: locationId };
  }
  // Check scenes (including buildings along roads and at junctions)
  if (topology.sceneToParent.has(locationId)) {
    return { type: "scene", sceneId: locationId };
  }
  // Roads: support "ROAD_ID" (midpoint) and "ROAD_ID@0.3" (explicit position)
  const atIdx = locationId.indexOf("@");
  const roadKey = atIdx >= 0 ? locationId.slice(0, atIdx) : locationId;
  const road = topology.roads.get(roadKey);
  if (road) {
    const parsed =
      atIdx >= 0 ? Number.parseFloat(locationId.slice(atIdx + 1)) : 0.5;
    const position = Number.isFinite(parsed)
      ? Math.max(0, Math.min(1, parsed))
      : 0.5;
    return { type: "road", roadId: road.id, position };
  }
  // Fallback: interior sub-scene or outline ID — resolve via entry scene
  if (dgsm) {
    const state = dgsm.getState();
    // Check if it's an outline ID (e.g., "SCN_1") — resolve to entrySceneId
    const outline = (state.scenarioOutlines ?? []).find(
      (o) => o.id === locationId
    );
    if (
      outline?.entrySceneId &&
      topology.sceneToParent.has(outline.entrySceneId)
    ) {
      return { type: "scene", sceneId: outline.entrySceneId };
    }
    // Check if it's an interior sub-scene — resolve to building's entry scene
    const scene = state.scenes.get(locationId);
    if (scene) {
      const parentOutline = (state.scenarioOutlines ?? []).find(
        (o) => o.id === scene.parentLocationId
      );
      if (
        parentOutline?.entrySceneId &&
        topology.sceneToParent.has(parentOutline.entrySceneId)
      ) {
        return { type: "scene", sceneId: parentOutline.entrySceneId };
      }
    }
  }
  return null;
}
