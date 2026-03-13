import type { GameEngineRegistry } from "./registry.js";
import {
  applyPenalties,
  getNodeDifficulty,
  getScenePenalties,
  luckFailureRate,
  resolveSkillRoll,
  selectBestSkill,
} from "./shared/index.js";
import type { ExecutionContext } from "./types.js";

export function createExecutionContext(
  registry?: GameEngineRegistry
): ExecutionContext {
  return {
    resolveSkillRoll,
    getScenePenalties,
    applyPenalties,
    getNodeDifficulty,
    luckFailureRate,
    selectBestSkill,
    getCharacterPenalties(characterId, dgsm) {
      if (!registry) return new Map();
      return registry.collectCharacterPenalties(characterId, dgsm);
    },
  };
}
