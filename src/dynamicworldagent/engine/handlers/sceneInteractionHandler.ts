import type {
  CharacterAction,
  PlanNode,
} from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { isCharacterAtLocation } from "../shared/locationPresence.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import { getTopologyNeighbors } from "../shared/topologyHelpers.js";
import type { ExecutionContext, NodeHandler } from "../types.js";

export const sceneInteractionHandler: NodeHandler = {
  type: "scene_interaction",

  description:
    "Interact with the scene itself, modifying scene conditions or connections. " +
    "Outcomes are appended as scene conditions.\n\n" +
    "Optional: `sceneConnectionEffect` to block/unblock a connection between scenes.\n" +
    'Format: `{ "targetScenarioId": "existing_connected_location_id", "action": "block|unblock" }`\n' +
    "`targetScenarioId` must reference a real adjacent map location ID from the current location's known connections. " +
    "Never invent room fragments, doors, partitions, or descriptive sub-areas. If unsure, omit this field.\n\n" +
    "SKILL GUIDANCE: Do NOT set `skill` for ordinary scene actions — closing/opening doors, " +
    "drawing curtains, turning on lights, or looking around a room. These always succeed. " +
    "Only set `skill` when the action requires special effort: barricading a door (STR), " +
    "searching for hidden passages (Spot Hidden), or disabling a security system (Electrical Repair).",

  requiredFields: ["action", "location"],

  optionalFields: ["skill", "sceneConnectionEffect"],

  exampleNode: {
    nodeId: "si1",
    startTime: "11:00",
    endTime: "11:10",
    type: "scene_interaction",
    action: "Barricade the door to the basement",
    location: "ground_floor_hallway",
    impact: 3,
    sceneConnectionEffect: {
      targetScenarioId: "service_hallway",
      action: "block",
    },
  },

  execute(
    node: PlanNode,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): CharacterAction {
    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(node.characterId);
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

    // Location check
    if (!isCharacterAtLocation(pos, node.location)) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "not at expected location" }),
        { difficulty, failureReason: "location_mismatch" }
      );
    }

    // Skill roll if skill present; otherwise auto-success
    if (node.skill) {
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
    }

    // Append outcome as scene condition
    const outcome = buildOutcome(node, "completed", {
      rollDetail: lastRollDetail,
    });
    dgsm.appendSceneCondition(node.location, { description: outcome });
    if (node.sceneConnectionEffect) {
      const effect = node.sceneConnectionEffect;
      const topology = dgsm.getTopology();
      const neighbors = topology
        ? getTopologyNeighbors(node.location, topology)
        : [];
      const scene = dgsm.getScene(node.location);
      const directConnectionIds = (scene?.connections ?? []).map(
        (c) => c.targetId
      );
      const connectedTargets = new Set([...directConnectionIds, ...neighbors]);
      const targetExists =
        dgsm.getScene(effect.targetScenarioId) !== null ||
        dgsm.getJunction(effect.targetScenarioId) !== null ||
        dgsm.getRoad(effect.targetScenarioId) !== null;

      if (targetExists && connectedTargets.has(effect.targetScenarioId)) {
        const blocked = effect.action === "block";
        dgsm.setConnectionBlocked(
          node.location,
          effect.targetScenarioId,
          blocked,
          outcome
        );
      } else {
        console.warn(
          `[sceneInteractionHandler] Ignoring invalid sceneConnectionEffect from ${node.location} to ${effect.targetScenarioId}`
        );
      }
    }

    return makeAction(node, "completed", outcome, {
      difficulty,
      successLevel: resolvedSuccessLevel,
    });
  },
};
