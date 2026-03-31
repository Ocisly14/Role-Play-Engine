import type {
  CharacterAction,
  PlanNode,
} from "../../dynamicworldagent/dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../dynamicworldagent/state/DynamicGameState.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import type { ExecutionContext, NodeHandler } from "../types.js";

export const sceneInteractionHandler: NodeHandler = {
  type: "scene_interaction",

  description:
    "Interact with the scene itself — search, investigate, or modify the environment. " +
    "An LLM resolver determines all scene state changes (conditions, connection effects, item changes, memories) " +
    "based on the action description and skill roll result.\n\n" +
    "If using a tool/item for the interaction, set `objectInteractionPayload.itemId` to the item being used " +
    "(e.g. crowbar to pry open a window, key to unlock a door).\n\n" +
    "SKILL GUIDANCE: Do NOT set `skill` for ordinary scene actions — closing/opening doors, " +
    "drawing curtains, turning on lights, or looking around a room. These always succeed. " +
    "Only set `skill` when the action requires special effort: barricading a door (STR), " +
    "searching for hidden passages (Spot Hidden), or disabling a security system (Electrical Repair).",

  requiredFields: ["action"],

  optionalFields: ["skill", "objectInteractionPayload"],

  exampleNode: {
    nodeId: "si1",
    startTime: "11:00",
    endTime: "11:10",
    type: "scene_interaction",
    action: "Pry open the boarded window with the crowbar",
    skill: "STR",
    impact: 2,
    objectInteractionPayload: {
      itemId: "crowbar",
    },
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

    // Item existence pre-check
    const payload = node.objectInteractionPayload;
    if (payload?.itemId) {
      const scene = dgsm.getScene(node.location);
      const inInventory = dgsm.findNpcItem(node.characterId, payload.itemId);
      const inScene = scene?.items.find((i) => i.id === payload.itemId);
      if (!inInventory && !inScene) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", {
            reason: `${payload.itemId} not found`,
          }),
          { difficulty, failureReason: "object_not_found" }
        );
      }
    }

    // Return success — tickProcessor calls LLM resolver for state changes
    const action = makeAction(node, "completed", node.action, {
      difficulty,
      successLevel: resolvedSuccessLevel,
    });
    action.rollDetail = lastRollDetail;
    return action;
  },
};
