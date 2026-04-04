import type { PlanNode } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { GameEngineRegistry } from "../registry.js";
import {
  applyPenalties,
  getScenePenalties,
  resolveSkillRoll,
} from "../shared/index.js";
import type { ActionDefinitionSkillCheck, ToolResult } from "../types.js";

export function executeSkillCheck(
  skillCheckDef: ActionDefinitionSkillCheck | undefined,
  characterId: string,
  skill: string | undefined,
  dgsm: DynamicGameStateManager,
  locationId: string,
  registry?: GameEngineRegistry,
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
  const resolvedSkill = skill ?? skillCheckDef?.skills[0];
  if (!resolvedSkill) {
    return {
      done: true,
      status: "completed",
      outcomeDescription: "No skill specified",
      successLevel: "regular",
    };
  }

  // Build penalty-adjusted skills
  const scenePenalties = getScenePenalties(locationId, dgsm);
  const charPenalties = registry
    ? registry.collectCharacterPenalties(characterId, dgsm)
    : new Map<string, number>();
  const afterScene = applyPenalties(npcSkills, scenePenalties);
  const adjustedSkills = applyPenalties(afterScene, charPenalties);

  // Build a synthetic PlanNode for resolveSkillRoll
  const syntheticNode: Partial<PlanNode> = {
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
          const targetCharPenalties = registry
            ? registry.collectCharacterPenalties(targetId, dgsm)
            : new Map<string, number>();
          return applyPenalties(
            applyPenalties(rawSkills, targetScenePenalties),
            targetCharPenalties
          );
        }
      : undefined;

  const rollResult = resolveSkillRoll(
    syntheticNode as PlanNode,
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
