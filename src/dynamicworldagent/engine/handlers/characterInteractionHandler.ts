import type {
  CharacterAction,
  PlanNode,
} from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import type { ExecutionContext, NodeHandler } from "../types.js";

export const characterInteractionHandler: NodeHandler = {
  type: "character_interaction",

  description:
    "Interact with another character (NPC or player). " +
    "Supports item transfer, knowledge transfer, and information exchange. " +
    "Difficulty is derived from the relationship score between characters. " +
    "NPC luck_only difficulty skips skill rolls and uses luck-based checks instead.",

  requiredFields: ["action", "location", "targetCharacterId"],

  optionalFields: ["skill", "characterInteractionPayload"],

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
    const pos = dgsm.getCharacterPosition(node.characterId);
    const npcLocation = pos ? dgsm.resolveLocationId(pos) : undefined;
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
      const targetPos = dgsm.getCharacterPosition(node.targetCharacterId);
      const targetLocation = targetPos ? dgsm.resolveLocationId(targetPos) : undefined;
      // Player character doesn't have characterPosition entry -- skip check for player
      if (targetLocation && targetLocation !== node.location) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { reason: "target not present" }),
          { difficulty, failureReason: "target_absent" }
        );
      }
    }

    // Skill roll if skill present; otherwise auto-success
    if (node.skill && difficulty !== "luck_only") {
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

    // Apply side effects
    if (node.characterInteractionPayload && node.targetCharacterId) {
      const payload = node.characterInteractionPayload;
      if (payload.transferType === "item" && payload.itemId) {
        const item = dgsm.removeItemFromNpc(node.characterId, payload.itemId);
        if (!item) {
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", {
              reason: `item ${payload.itemId} not in inventory`,
            }),
            { difficulty, failureReason: "object_not_found" }
          );
        }
        dgsm.addItemToNpc(node.targetCharacterId, item);
      }
      // Information transfer memory writes handled by tickProcessor post-execution
    }

    return makeAction(
      node,
      "completed",
      buildOutcome(node, "completed", { rollDetail: lastRollDetail }),
      { difficulty, successLevel: resolvedSuccessLevel }
    );
  },
};
