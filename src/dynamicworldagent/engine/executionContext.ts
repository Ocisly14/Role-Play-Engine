import type { ExecutionContext } from "./types.js";
import type { GameEngineRegistry } from "./registry.js";
import {
  resolveSkillRoll,
  getNodeDifficulty,
  selectBestSkill,
  luckFailureRate,
  getScenePenalties,
  applyPenalties,
} from "./shared/index.js";

export function createExecutionContext(registry?: GameEngineRegistry): ExecutionContext {
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
