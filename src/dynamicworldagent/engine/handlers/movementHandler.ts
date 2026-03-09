import type { NodeHandler, ExecutionContext } from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { PlanNode, CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import { findPath, calculateTravelTime } from "../shared/pathfinding.js";

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

    // Scene penalties
    const penalties = ctx.getScenePenalties(node.location, dgsm);
    const adjustedSkills = ctx.applyPenalties(npcSkills, penalties);

    let resolvedSuccessLevel: import("../../dynamicBasicAgent/npcPlanning/types.js").SuccessLevel | undefined;
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
          { difficulty, successLevel: resolvedSuccessLevel, failureReason: "skill_roll_failed" }
        );
      }
      lastRollDetail = rollResult.detail;
      dgsm.setNpcLocation(node.characterId, node.location);
      return makeAction(
        node,
        "completed",
        buildOutcome(node, "completed", { reason: "Creative movement succeeded" }),
        { difficulty, successLevel: resolvedSuccessLevel }
      );
    }

    // Normal movement: BFS pathfinding
    if (state.scenes.size > 0) {
      const path = findPath(fromLocation, node.location, state.scenes, state.blockedConnections);
      if (!path) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { reason: "no path available" }),
          { difficulty, failureReason: "location_blocked" }
        );
      }
      const travelTime = calculateTravelTime(path, state.scenes, state.transportEdges);
      dgsm.setNpcLocation(node.characterId, node.location);
      const hopCount = path.length - 1;
      return makeAction(
        node,
        "completed",
        buildOutcome(node, "completed", { reason: `Traveled ${hopCount} hops in ~${travelTime} min` }),
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
    return makeAction(
      node,
      "completed",
      buildOutcome(node, "completed"),
      { difficulty, successLevel: resolvedSuccessLevel }
    );
  },
};
