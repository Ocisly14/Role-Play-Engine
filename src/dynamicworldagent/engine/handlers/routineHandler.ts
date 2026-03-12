import type { NodeHandler, ExecutionContext } from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { PlanNode, CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import { restCharacter } from "../features/staminaFeature.js";

export const routineHandler: NodeHandler = {
  type: "routine",

  description:
    "A routine action performed by a character at their current location. " +
    "If actionType is set, a skill roll determines success; otherwise the action auto-succeeds. " +
    'Set routineSubtype to "rest" for sleeping, napping, or resting — this resets fatigue automatically.',

  requiredFields: ["action", "location"],

  optionalFields: ["actionType", "routineSubtype"],

  exampleNode: {
    nodeId: "r1",
    type: "routine",
    routineSubtype: "rest",
    action: "Sleep for the night to recover from exhaustion",
    location: "home_bedroom",
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

    // Rest subtype → reset fatigue via stamina feature
    if (node.routineSubtype === "rest") {
      const isPlayer = !!node.isPlayer;
      restCharacter(dgsm, node.characterId, isPlayer);
    }

    return makeAction(
      node,
      "completed",
      buildOutcome(node, "completed", { rollDetail: lastRollDetail }),
      { difficulty, successLevel: resolvedSuccessLevel }
    );
  },
};
