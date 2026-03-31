import type {
  CharacterAction,
  PlanNode,
} from "../../dynamicworldagent/dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../dynamicworldagent/state/DynamicGameState.js";
import { restCharacter } from "../features/staminaFeature.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import type { ExecutionContext, NodeHandler } from "../types.js";

export const actionHandler: NodeHandler = {
  type: "action",

  description:
    'A narrative action performed by a character at their current location. This handler is for actions that do NOT change object, character, or scene state. If skill is set, a skill roll determines success; otherwise the action auto-succeeds. Set routineSubtype to "rest" for sleeping, napping, or resting — this resets fatigue automatically.',

  requiredFields: ["action"],

  optionalFields: ["skill", "routineSubtype"],

  exampleNode: {
    nodeId: "a1",
    startTime: "22:00",
    endTime: "22:05",
    type: "action",
    routineSubtype: "rest",
    action: "Sleep for the night to recover from exhaustion",
    impact: 0,
  },

  execute(
    node: PlanNode,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): CharacterAction {
    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(node.characterId);
    if (pos) node.location = dgsm.resolveLocationId(pos);
    const npc = state.npcCharacters.find((n) => n.id === node.characterId);
    const npcSkills = npc?.skills ?? {};
    const difficulty = ctx.getNodeDifficulty(node, dgsm);

    // Scene + character penalties
    const scenePenalties = ctx.getScenePenalties(node.location, dgsm);
    const charPenalties = ctx.getCharacterPenalties(node.characterId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    let resolvedSuccessLevel:
      | import("../../dynamicworldagent/dynamicBasicAgent/npcPlanning/types.js").SuccessLevel
      | undefined;
    let lastRollDetail: string | undefined;

    const lang = ctx.language ?? "en";

    // skill present? -> skill roll
    if (node.skill) {
      const rollResult = ctx.resolveSkillRoll(node, adjustedSkills, dgsm);
      resolvedSuccessLevel = rollResult.successLevel;
      if (rollResult.failed) {
        lastRollDetail = rollResult.reason;
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { rollDetail: lastRollDetail }, lang),
          {
            difficulty,
            successLevel: resolvedSuccessLevel,
            failureReason: "skill_roll_failed",
          }
        );
      }
      lastRollDetail = rollResult.detail;
    }

    // Rest subtype → reset fatigue via stamina feature
    if (node.routineSubtype === "rest") {
      restCharacter(dgsm, node.characterId);
    }

    return makeAction(
      node,
      "completed",
      buildOutcome(node, "completed", { rollDetail: lastRollDetail }, lang),
      { difficulty, successLevel: resolvedSuccessLevel }
    );
  },
};
