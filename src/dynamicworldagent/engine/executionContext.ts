import type { ExecutionContext } from "./types.js";
import {
  resolveSkillRoll,
  getNodeDifficulty,
  selectBestSkill,
  luckFailureRate,
  getScenePenalties,
  applyPenalties,
} from "./shared/index.js";

export function createExecutionContext(): ExecutionContext {
  return {
    resolveSkillRoll,
    getScenePenalties,
    applyPenalties,
    getNodeDifficulty,
    luckFailureRate,
    selectBestSkill,
  };
}
