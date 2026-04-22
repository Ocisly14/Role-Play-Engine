import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { GameEngineRegistry } from "./registry.js";
import {
  applyPenalties,
  getCharacterConditionPenalties,
  getNodeDifficulty,
  getScenePenalties,
  resolveSkillRoll,
} from "./shared/index.js";
import type { ExecutionContext } from "./types.js";

export function createExecutionContext(
  _registry?: GameEngineRegistry,
  opts?: {
    runtime?: any;
    language?: string;
    memoryManager?: NpcMemoryManager;
  }
): ExecutionContext {
  return {
    resolveSkillRoll,
    getScenePenalties,
    applyPenalties,
    getNodeDifficulty,
    getCharacterPenalties: getCharacterConditionPenalties,
    runtime: opts?.runtime,
    language: opts?.language,
    memoryManager: opts?.memoryManager,
  };
}
