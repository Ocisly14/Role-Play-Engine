import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  applyPenalties,
  getCharacterConditionPenalties,
  getScenePenalties,
  resolveSkillRoll,
} from "../shared/index.js";
import type { SkillRollNode } from "../shared/skillRoll.js";
import type { ActionDefinitionSkillCheck, ToolResult } from "../types.js";

export function executeSkillCheck(
  skillCheckDef: ActionDefinitionSkillCheck | undefined,
  characterId: string,
  skill: string | undefined,
  dgsm: DynamicGameStateManager,
  locationId: string,
  targetIds?: string[]
): ToolResult {
  // No skill check required — auto success
  if (!skillCheckDef && !skill) {
    return {
      done: true,
      status: "completed",
      outcomeDescription: "No skill check required",
      successLevel: "regular",
    };
  }

  const state = dgsm.getState();
  const npc = state.npcCharacters.find((n) => n.id === characterId);
  const npcSkills = npc?.skills ?? {};
  const resolvedSkill = skill ?? skillCheckDef?.skill;
  if (!resolvedSkill) {
    return {
      done: true,
      status: "completed",
      outcomeDescription: "No skill check required",
      successLevel: "regular",
    };
  }

  // Build penalty-adjusted skills
  const scenePenalties = getScenePenalties(locationId, dgsm);
  const charPenalties = getCharacterConditionPenalties(characterId, dgsm);
  const afterScene = applyPenalties(npcSkills, scenePenalties);
  const adjustedSkills = applyPenalties(afterScene, charPenalties);

  const syntheticNode: SkillRollNode = {
    characterId,
    skill: resolvedSkill,
    difficulty: skillCheckDef?.difficulty ?? "regular",
    targetCharacterIds: targetIds,
    type:
      skillCheckDef?.type === "opposed" ? "character_interaction" : "action",
  };

  const adjustTargetSkills =
    skillCheckDef?.type === "opposed"
      ? (targetId: string, rawSkills: Record<string, number>) => {
          const targetScenePenalties = getScenePenalties(locationId, dgsm);
          const targetCharPenalties = getCharacterConditionPenalties(
            targetId,
            dgsm
          );
          return applyPenalties(
            applyPenalties(rawSkills, targetScenePenalties),
            targetCharPenalties
          );
        }
      : undefined;

  const rollResult = resolveSkillRoll(
    syntheticNode,
    adjustedSkills,
    dgsm,
    adjustTargetSkills
  );

  if (rollResult.failed) {
    return {
      done: true,
      status: "failed",
      outcomeDescription: rollResult.reason ?? "Skill check failed",
      rollDetail: rollResult.reason,
      successLevel: rollResult.successLevel,
      perTargetResults: rollResult.perTargetResults,
    };
  }

  return {
    done: true,
    status: "completed",
    outcomeDescription: rollResult.detail ?? "Skill check passed",
    rollDetail: rollResult.detail,
    successLevel: rollResult.successLevel,
    perTargetResults: rollResult.perTargetResults,
  };
}
