import type { NodeHandler, ExecutionContext } from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { PlanNode, CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";

export const routineHandler: NodeHandler = {
  type: "routine",

  description:
    "A routine action performed by a character at their current location. " +
    "If actionType is set, a skill roll determines success; otherwise the action auto-succeeds.",

  requiredFields: ["action", "location"],

  optionalFields: ["actionType"],

  exampleNode: {
    nodeId: "r1",
    type: "routine",
    action: "Search the bookshelves for occult references",
    location: "library_main",
    actionType: "exploration",
    impact: 1,
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

    // Location check
    if (npcLocation && npcLocation !== node.location) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "not at expected location" }),
        { difficulty, failureReason: "location_mismatch" }
      );
    }

    // actionType present? -> skill roll
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

    return makeAction(
      node,
      "completed",
      buildOutcome(node, "completed", { rollDetail: lastRollDetail }),
      { difficulty, successLevel: resolvedSuccessLevel }
    );
  },
};
