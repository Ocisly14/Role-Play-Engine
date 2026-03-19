import type { GameEngineRegistry } from "./registry.js";
import {
  applyPenalties,
  getNodeDifficulty,
  getScenePenalties,
  resolveSkillRoll,
} from "./shared/index.js";
import type { ExecutionContext } from "./types.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";

export function createExecutionContext(
  registry?: GameEngineRegistry,
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
    getCharacterPenalties(characterId, dgsm) {
      if (!registry) return new Map();
      return registry.collectCharacterPenalties(characterId, dgsm);
    },
    runtime: opts?.runtime,
    language: opts?.language,
    memoryManager: opts?.memoryManager,
  };
}
