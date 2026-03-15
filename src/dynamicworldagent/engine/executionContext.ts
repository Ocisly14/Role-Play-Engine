import type { GameEngineRegistry } from "./registry.js";
import {
  applyPenalties,
  getNodeDifficulty,
  getScenePenalties,
  resolveSkillRoll,
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
    getCharacterPenalties(characterId, dgsm) {
      if (!registry) return new Map();
      return registry.collectCharacterPenalties(characterId, dgsm);
    },
  };
}
