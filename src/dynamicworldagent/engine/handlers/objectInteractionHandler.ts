import type { NodeHandler, ExecutionContext } from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { PlanNode, CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";

export const objectInteractionHandler: NodeHandler = {
  type: "object_interaction",

  description:
    "Interact with an object in the current scene. " +
    "Supports pickup, place, use, inspect, and destroy actions. " +
    "Side effects modify inventory and scene item lists.",

  requiredFields: ["action", "location"],

  optionalFields: ["actionType", "objectInteractionPayload"],

  exampleNode: {
    nodeId: "oi1",
    type: "object_interaction",
    action: "Pick up the ancient tome from the desk",
    location: "study_room",
    impact: 1,
    timeAdvanceMinutes: 5,
    objectInteractionPayload: {
      action: "pickup",
      itemId: "ancient_tome",
    },
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
    const luck = npc?.status?.luck ?? 50;
    const difficulty = ctx.getNodeDifficulty(node, dgsm);

    // Scene + character penalties
    const scenePenalties = ctx.getScenePenalties(node.location, dgsm);
    const charPenalties = ctx.getCharacterPenalties(node.characterId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    let resolvedSuccessLevel: import("../../dynamicBasicAgent/npcPlanning/types.js").SuccessLevel | undefined;
    let lastRollDetail: string | undefined;

    // Location check
    if (npcLocation && npcLocation !== node.location) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "not at expected location" }),
        { difficulty, failureReason: "location_mismatch" }
      );
    }

    if (node.isPlayer) {
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
      }
    } else if (difficulty === "luck_only") {
      if (Math.random() < ctx.luckFailureRate(luck)) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { reason: `bad luck (luck=${luck})` }),
          { difficulty, failureReason: "bad_luck" }
        );
      }
    } else {
      if (!node.actionType && Math.random() < ctx.luckFailureRate(luck)) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { reason: `bad luck (luck=${luck})` }),
          { difficulty, failureReason: "bad_luck" }
        );
      }
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
      }
    }

    // Apply side effects
    if (node.objectInteractionPayload) {
      const payload = node.objectInteractionPayload;
      if (payload.action === "pickup" && payload.itemId) {
        dgsm.addItemToNpc(node.characterId, payload.itemId);
        const scene = dgsm.getCurrentScene();
        if (scene) {
          scene.items = scene.items.filter((i) => i.id !== payload.itemId);
        }
      } else if (payload.action === "place" && payload.itemId) {
        dgsm.removeItemFromNpc(node.characterId, payload.itemId);
        const scene = dgsm.getCurrentScene();
        if (scene) {
          scene.items.push({ id: payload.itemId, name: payload.itemId });
        }
      } else if (payload.action === "destroy" && payload.itemId) {
        dgsm.removeItemFromNpc(node.characterId, payload.itemId);
        const scene = dgsm.getScene(node.location);
        if (scene) {
          scene.events.push(`${node.characterName} destroyed ${payload.itemId}`);
        }
      }
    }

    return makeAction(
      node,
      "completed",
      buildOutcome(node, "completed", { rollDetail: lastRollDetail }),
      { difficulty, successLevel: resolvedSuccessLevel }
    );
  },
};
