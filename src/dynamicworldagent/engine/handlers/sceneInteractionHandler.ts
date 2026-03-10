import type { NodeHandler, ExecutionContext } from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { PlanNode, CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";

export const sceneInteractionHandler: NodeHandler = {
  type: "scene_interaction",

  description:
    "Interact with the scene itself, modifying scene conditions or connections. " +
    "Can block or unblock connections between scenes. " +
    "Outcomes are appended as scene conditions.",

  requiredFields: ["action", "location"],

  optionalFields: ["actionType", "sceneConnectionEffect"],

  exampleNode: {
    nodeId: "si1",
    type: "scene_interaction",
    action: "Barricade the door to the basement",
    location: "ground_floor_hallway",
    impact: 3,
    timeAdvanceMinutes: 10,
    sceneConnectionEffect: {
      targetScenarioId: "basement_entrance",
      action: "block",
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

    // Append outcome as scene condition
    const outcome = buildOutcome(node, "completed", { rollDetail: lastRollDetail });
    dgsm.appendSceneCondition(node.location, { description: outcome });
    if (node.sceneConnectionEffect) {
      const effect = node.sceneConnectionEffect;
      const blocked = effect.action === "block";
      dgsm.setConnectionBlocked(node.location, effect.targetScenarioId, blocked, outcome);
    }

    return makeAction(
      node,
      "completed",
      outcome,
      { difficulty, successLevel: resolvedSuccessLevel }
    );
  },
};
