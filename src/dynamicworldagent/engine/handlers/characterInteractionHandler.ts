import type {
  CharacterAction,
  PlanNode,
  SuccessLevel,
} from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  arePositionsCoLocated,
  isCharacterAtLocation,
} from "../shared/locationPresence.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import type { ExecutionContext, NodeHandler } from "../types.js";

export const characterInteractionHandler: NodeHandler = {
  type: "character_interaction",

  description:
    "Interact with one or more characters (NPC or player). " +
    "Supports any form of interaction: conversation, item exchange, " +
    "persuasion, intimidation, physical contact, leading/escorting, " +
    "or forcing someone to leave.\n\n" +
    "Set `targetCharacterIds` to an array of character IDs (even for a single target). " +
    "Describe what you do entirely in `action`.\n\n" +
    "An LLM resolver determines all state changes (HP, SAN, items, " +
    "position, conditions, appearance) for both characters based on " +
    "the action description and skill roll result.",

  requiredFields: ["action", "location", "targetCharacterIds"],

  optionalFields: ["skill"],

  exampleNode: {
    nodeId: "ci1",
    startTime: "10:00",
    endTime: "10:05",
    type: "character_interaction",
    action: "Convince Dr. Morgan to follow me to the library",
    location: "hospital_lobby",
    targetCharacterIds: ["npc_dr_morgan"],
    impact: 2,
    skill: "Persuade",
  },

  async execute(
    node: PlanNode,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): Promise<CharacterAction> {
    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(node.characterId);
    const npc = state.npcCharacters.find((n) => n.id === node.characterId);
    const npcSkills = npc?.skills ?? {};
    const targetIds = node.targetCharacterIds ?? [];

    if (targetIds.length === 0) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "no target specified" }),
        { failureReason: "target_absent" }
      );
    }

    // Scene + character penalties
    const scenePenalties = ctx.getScenePenalties(node.location, dgsm);
    const charPenalties = ctx.getCharacterPenalties(node.characterId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    let resolvedSuccessLevel: SuccessLevel | undefined;
    let lastRollDetail: string | undefined;
    let resolvedPerTargetResults: CharacterAction["perTargetResults"];

    // 1. Location check
    if (!isCharacterAtLocation(pos, node.location)) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "not at expected location" }),
        { failureReason: "location_mismatch" }
      );
    }

    // 2. Target presence check — all targets must be co-located
    for (const targetId of targetIds) {
      const targetPos = dgsm.getCharacterPosition(targetId);
      const targetLocation = targetPos
        ? dgsm.resolveLocationId(targetPos)
        : undefined;
      if (
        targetLocation &&
        (!arePositionsCoLocated(pos, targetPos, dgsm) ||
          dgsm.isCharacterHidden(targetId))
      ) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", {
            reason: `target ${targetId} not present`,
          }),
          { failureReason: "target_absent" }
        );
      }
    }

    // 3. Skill roll — opposed rolls handle per-target mechanics
    if (node.skill) {
      const rollResult = ctx.resolveSkillRoll(
        node,
        adjustedSkills,
        dgsm,
        (targetId, rawSkills) => {
          const targetScenePenalties = ctx.getScenePenalties(
            node.location,
            dgsm
          );
          const targetCharPenalties = ctx.getCharacterPenalties(targetId, dgsm);
          return ctx.applyPenalties(
            ctx.applyPenalties(rawSkills, targetScenePenalties),
            targetCharPenalties
          );
        }
      );
      resolvedSuccessLevel = rollResult.successLevel;
      resolvedPerTargetResults = rollResult.perTargetResults;
      if (rollResult.failed) {
        lastRollDetail = rollResult.reason;
        const failedAction = makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { rollDetail: lastRollDetail }),
          {
            successLevel: resolvedSuccessLevel,
            failureReason: "skill_roll_failed",
          }
        );
        failedAction.perTargetResults = resolvedPerTargetResults;
        return failedAction;
      }
      lastRollDetail = rollResult.detail;
    }

    // 4. Return success — tickProcessor handles LLM resolution and state changes
    const action = makeAction(node, "completed", node.action, {
      successLevel: resolvedSuccessLevel,
    });
    action.rollDetail = lastRollDetail;
    action.perTargetResults = resolvedPerTargetResults;
    return action;
  },
};
