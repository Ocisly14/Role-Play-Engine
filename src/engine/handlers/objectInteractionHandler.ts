import type { CharacterAction, PlanNode } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import type { ExecutionContext, NodeHandler } from "../types.js";

export const objectInteractionHandler: NodeHandler = {
  type: "object_interaction",

  description:
    "Interact with an object in the current scene. " +
    "An LLM resolver determines all item state changes (move, modify, destroy, disassemble, combine) " +
    "based on the action description and skill roll result.\n\n" +
    "Set `objectInteractionPayload.itemId` to the primary item being interacted with.\n\n" +
    "SKILL GUIDANCE: Do NOT set `skill` for routine actions — picking up items, opening unlocked containers, " +
    "inspecting objects, searching your own belongings, or using items normally. These always succeed without a roll. " +
    "Only set `skill` when the action is genuinely difficult: picking a lock without a key (Locksmith), " +
    "disarming a trap (Mechanical Repair), forcing open a stuck/barricaded container (STR), " +
    "or using an item in a non-standard way that requires expertise.",

  requiredFields: ["action"],

  optionalFields: ["skill", "objectInteractionPayload"],

  exampleNode: {
    nodeId: "oi1",
    startTime: "14:00",
    endTime: "14:10",
    type: "object_interaction",
    action: "Move the petty cash box from the desk drawer into my briefcase",
    impact: 1,
    objectInteractionPayload: {
      itemId: "petty_cash_box",
    },
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

    // Skill roll (for non-normal use with skill)
    let resolvedSuccessLevel:
      | import("../../planning/types.js").SuccessLevel
      | undefined;
    let lastRollDetail: string | undefined;

    // Skill roll if skill present; otherwise auto-success
    if (node.skill) {
      const rollResult = ctx.resolveSkillRoll(node, adjustedSkills, dgsm);
      resolvedSuccessLevel = rollResult.successLevel;
      if (rollResult.failed) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { rollDetail: rollResult.reason }),
          {
            difficulty,
            location: locationId,
            successLevel: resolvedSuccessLevel,
            failureReason: "skill_roll_failed",
          }
        );
      }
      lastRollDetail = rollResult.detail;
    }

    // Item existence pre-check (fast-fail before LLM call)
    const payload = node.objectInteractionPayload;
    if (payload?.itemId) {
      const scene = dgsm.getScene(locationId);
      const inInventory = dgsm.findNpcItem(node.characterId, payload.itemId);
      const inScene = scene?.items.find((i) => i.id === payload.itemId);
      // Also check inside containers (scene + inventory)
      let inContainer = false;
      if (!inInventory && !inScene) {
        if (scene?.items) {
          for (const si of scene.items) {
            if (
              si.containerStats?.storedItems?.some(
                (s) => s.id === payload.itemId
              )
            ) {
              inContainer = true;
              break;
            }
          }
        }
        if (!inContainer) {
          const inv = dgsm.getNpcInventory(node.characterId);
          for (const ii of inv) {
            if (
              ii.containerStats?.storedItems?.some(
                (s) => s.id === payload.itemId
              )
            ) {
              inContainer = true;
              break;
            }
          }
        }
      }
      if (!inInventory && !inScene && !inContainer) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", {
            reason: `${payload.itemId} not found`,
          }),
          {
            difficulty,
            location: locationId,
            failureReason: "object_not_found",
          }
        );
      }
    }

    // Return success — tickProcessor calls LLM resolver for state changes
    const action = makeAction(node, "completed", node.action, {
      difficulty,
      location: locationId,
      successLevel: resolvedSuccessLevel,
    });
    action.rollDetail = lastRollDetail;
    return action;
  },
};
