import type { CharacterAction, PlanNode } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import type { ExecutionContext, NodeHandler } from "../types.js";

export const actionHandler: NodeHandler = {
  type: "action",

  description:
    "A current-location action performed in the actor's present scene. " +
    "Use this for self-directed behavior and environment-facing actions that do not primarily target a specific item or character. " +
    "Examples: resting, waiting, searching the room, listening at the door, drawing curtains, barring an exit, hiding in place. " +
    "If skill is set, a skill roll determines success; otherwise the action auto-succeeds. " +
    "An LLM resolver determines scene changes, partial outcomes, and fatigue effects after execution.",

  requiredFields: ["action"],

  optionalFields: ["skill"],

  exampleNode: {
    nodeId: "a1",
    startTime: "22:00",
    endTime: "22:05",
    type: "action",
    action: "Search the study carefully for signs that someone opened the desk",
    impact: 0,
  },

  execute(
    node: PlanNode,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): CharacterAction {
    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(node.characterId);
    const locationId = pos ? dgsm.resolveLocationId(pos) : "";
    const npc = state.npcCharacters.find((n) => n.id === node.characterId);
    const npcSkills = npc?.skills ?? {};
    const difficulty = ctx.getNodeDifficulty(node, dgsm);

    // Scene + character penalties
    const scenePenalties = ctx.getScenePenalties(locationId, dgsm);
    const charPenalties = ctx.getCharacterPenalties(node.characterId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    let resolvedSuccessLevel:
      | import("../../planning/types.js").SuccessLevel
      | undefined;
    let lastRollDetail: string | undefined;

    const lang = ctx.language ?? "en";

    // skill present? -> skill roll
    if (node.skill) {
      const rollResult = ctx.resolveSkillRoll(node, adjustedSkills, dgsm);
      resolvedSuccessLevel = rollResult.successLevel;
      if (rollResult.failed) {
        lastRollDetail = rollResult.reason;
        const failedAction = makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { rollDetail: lastRollDetail }, lang),
          {
            difficulty,
            location: locationId,
            successLevel: resolvedSuccessLevel,
            failureReason: "skill_roll_failed",
          }
        );
        failedAction.rollDetail = lastRollDetail;
        return failedAction;
      }
      lastRollDetail = rollResult.detail;
    }

    const action = makeAction(
      node,
      "completed",
      buildOutcome(node, "completed", { rollDetail: lastRollDetail }, lang),
      { difficulty, location: locationId, successLevel: resolvedSuccessLevel }
    );
    action.rollDetail = lastRollDetail;
    return action;
  },
};
