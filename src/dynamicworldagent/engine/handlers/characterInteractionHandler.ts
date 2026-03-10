import type { NodeHandler, ExecutionContext } from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { PlanNode, CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";

export const characterInteractionHandler: NodeHandler = {
  type: "character_interaction",

  description:
    "Interact with another character (NPC or player). " +
    "Supports item transfer, clue transfer, and information exchange. " +
    "Difficulty is derived from the relationship score between characters. " +
    "NPC luck_only difficulty skips skill rolls and uses luck-based checks instead.",

  requiredFields: ["action", "location", "targetCharacterId"],

  optionalFields: ["actionType", "characterInteractionPayload"],

  exampleNode: {
    nodeId: "ci1",
    type: "character_interaction",
    action: "Hand over the mysterious letter to Dr. Morgan",
    location: "hospital_lobby",
    targetCharacterId: "npc_dr_morgan",
    impact: 2,
    timeAdvanceMinutes: 5,
    characterInteractionPayload: {
      transferType: "item",
      itemId: "mysterious_letter",
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

    // Target presence check
    if (node.targetCharacterId) {
      const targetLocation = dgsm.getNpcLocation(node.targetCharacterId);
      // Player character doesn't have npcLocation entry -- skip check for player
      if (targetLocation && targetLocation !== node.location) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { reason: "target not present" }),
          { difficulty, failureReason: "target_absent" }
        );
      }
    }

    // For NPC nodes with luck_only difficulty: skip actionType skill roll, only do luck-based roll
    if (!node.isPlayer && difficulty === "luck_only") {
      if (Math.random() < ctx.luckFailureRate(luck)) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { reason: `bad luck (luck=${luck})` }),
          { difficulty, failureReason: "bad_luck" }
        );
      }
    } else if (node.isPlayer) {
      // Player nodes: skip luck-based failure check entirely
      // Only do skill roll if actionType present
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
    } else {
      // NPC nodes (non-luck_only): existing logic
      // Luck-based failure (only when no actionType)
      if (!node.actionType && Math.random() < ctx.luckFailureRate(luck)) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { reason: `bad luck (luck=${luck})` }),
          { difficulty, failureReason: "bad_luck" }
        );
      }
      // Skill roll if actionType present
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
    if (node.characterInteractionPayload && node.targetCharacterId) {
      const payload = node.characterInteractionPayload;
      if (payload.transferType === "item" && payload.itemId) {
        dgsm.removeItemFromNpc(node.characterId, payload.itemId);
        dgsm.addItemToNpc(node.targetCharacterId, payload.itemId);
      } else if (payload.transferType === "clue" && payload.clueId) {
        dgsm.transferClue(node.characterId, node.targetCharacterId, payload.clueId);
      }
      // "information" transfer: no mechanical side effect here; impact gate handles plan revision
    }

    return makeAction(
      node,
      "completed",
      buildOutcome(node, "completed", { rollDetail: lastRollDetail }),
      { difficulty, successLevel: resolvedSuccessLevel }
    );
  },
};
