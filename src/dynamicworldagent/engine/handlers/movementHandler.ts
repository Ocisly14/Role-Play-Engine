import type {
  CharacterAction,
  PlanNode,
} from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type {
  CharacterPosition,
  TownTopology,
} from "../../state/topologyTypes.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import {
  calculateTravelTime,
  findPath,
  findTopologyPath,
} from "../shared/pathfinding.js";
import type { ExecutionContext, NodeHandler } from "../types.js";

export const movementHandler: NodeHandler = {
  type: "movement",

  description:
    "Move a character to a different location. " +
    "If actionType is set, a creative single-hop movement with skill check is attempted. " +
    "Otherwise, BFS pathfinding is used to find a route through the scene graph.",

  requiredFields: ["action", "location"],

  optionalFields: ["actionType"],

  exampleNode: {
    nodeId: "m1",
    type: "movement",
    action: "Walk to the harbor docks",
    location: "harbor_docks",
    impact: 0,
    timeAdvanceMinutes: 5,
  },

  execute(
    node: PlanNode,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): CharacterAction {
    const state = dgsm.getState();
    const npcLocation = dgsm.getNpcLocation(node.characterId);
    const npc = state.npcCharacters.find((n) => n.id === node.characterId);
    const npcSkills = npc?.skills ?? {};
    const difficulty = ctx.getNodeDifficulty(node, dgsm);

    // Scene + character penalties
    const scenePenalties = ctx.getScenePenalties(node.location, dgsm);
    const charPenalties = ctx.getCharacterPenalties(node.characterId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    let resolvedSuccessLevel:
      | import("../../dynamicBasicAgent/npcPlanning/types.js").SuccessLevel
      | undefined;
    let lastRollDetail: string | undefined;

    const fromLocation = npcLocation ?? node.location;

    // Creative movement: single hop with skill check, no pathfinding
    if (node.actionType) {
      const rollResult = ctx.resolveSkillRoll(node, adjustedSkills, dgsm);
      resolvedSuccessLevel = rollResult.successLevel;
      if (rollResult.failed) {
        lastRollDetail = rollResult.reason;
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { rollDetail: lastRollDetail }),
          {
            difficulty,
            successLevel: resolvedSuccessLevel,
            failureReason: "skill_roll_failed",
          }
        );
      }
      lastRollDetail = rollResult.detail;
      dgsm.setNpcLocation(node.characterId, node.location);
      return makeAction(
        node,
        "completed",
        buildOutcome(node, "completed", {
          reason: "Creative movement succeeded",
        }),
        { difficulty, successLevel: resolvedSuccessLevel }
      );
    }

    // Topology-based movement (preferred when topology is loaded)
    const topology = dgsm.getTopology();
    if (topology) {
      const currentPos = dgsm.getCharacterPosition(node.characterId);
      if (currentPos) {
        const targetPos = resolveTargetPosition(node.location, topology);
        if (targetPos) {
          const topologyPath = findTopologyPath(
            currentPos,
            targetPos,
            topology,
            state.blockedConnections
          );

          if (!topologyPath) {
            return makeAction(
              node,
              "failed",
              buildOutcome(node, "failed", {
                reason: "no path available in topology",
              }),
              { difficulty, failureReason: "location_blocked" }
            );
          }

          dgsm.setCharacterPosition(node.characterId, targetPos);
          // Also update legacy npcLocation for backward compatibility
          dgsm.setNpcLocation(node.characterId, node.location);

          // Emit npc_moved event for simulation viewers
          if (ctx.simulationEmitter) {
            const state = dgsm.getState();
            ctx.simulationEmitter.emitSimulationEvent(
              "npc_moved",
              node.characterId,
              node.location,
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
            buildOutcome(node, "completed", {
              reason: `Traveled via topology in ~${topologyPath.totalMinutes} min`,
            }),
            { difficulty, successLevel: resolvedSuccessLevel }
          );
        }
      }
    }

    // Normal movement: BFS pathfinding
    const allLocations = dgsm.getAllLocations();
    if (allLocations.size > 0) {
      const path = findPath(
        fromLocation,
        node.location,
        allLocations,
        state.blockedConnections
      );
      if (!path) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { reason: "no path available" }),
          { difficulty, failureReason: "location_blocked" }
        );
      }
      const travelTime = calculateTravelTime(
        path,
        allLocations,
        state.transportEdges
      );
      dgsm.setNpcLocation(node.characterId, node.location);
      const hopCount = path.length - 1;
      return makeAction(
        node,
        "completed",
        buildOutcome(node, "completed", {
          reason: `Traveled ${hopCount} hops in ~${travelTime} min`,
        }),
        { difficulty, successLevel: resolvedSuccessLevel }
      );
    }

    // Fallback: no scene graph loaded, use legacy direct movement
    if (dgsm.isConnectionBlocked(fromLocation, node.location)) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "path blocked" }),
        { difficulty, failureReason: "location_blocked" }
      );
    }
    const targetConditions = dgsm.getSceneConditions(node.location);
    const isBlocked = targetConditions.some((c) => c.mechanicalEffect?.blocked);
    if (isBlocked) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "destination blocked" }),
        { difficulty, failureReason: "location_blocked" }
      );
    }
    dgsm.setNpcLocation(node.characterId, node.location);
    return makeAction(node, "completed", buildOutcome(node, "completed"), {
      difficulty,
      successLevel: resolvedSuccessLevel,
    });
  },
};

function resolveTargetPosition(
  locationId: string,
  topology: TownTopology
): CharacterPosition | null {
  // Check junctions
  if (topology.junctions.has(locationId)) {
    return { type: "junction", junctionId: locationId };
  }
  // Check scenes (including buildings along roads and at junctions)
  if (topology.sceneToParent.has(locationId)) {
    return { type: "scene", sceneId: locationId };
  }
  // Roads are not valid direct targets — resolve to the far endpoint junction
  const road = topology.roads.get(locationId);
  if (road) {
    return { type: "junction", junctionId: road.endpointB };
  }
  return null;
}
