import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { DynamicScene, DynamicNPCProfile } from "../../state/types.js";
import type { FeatureStateScope } from "./types.js";

// No projection: features consume raw DGSM types directly. Keeps the engine
// boundary simpler (one source of truth for scene/character shape) at the cost
// of features seeing fields they won't use (personality, backstory, inventory
// detail, etc.). Acceptable trade-off per the 2026-04-21 decision.

export interface FeatureReadContext {
  readonly gameDay: number;
  readonly tickTime: string;
  readonly tickDurationMinutes: number;

  getSceneIds(): string[];
  getScene(sceneId: string): DynamicScene | undefined;
  getCharacter(characterId: string): DynamicNPCProfile | undefined;
  getCharactersInScene(sceneId: string): DynamicNPCProfile[];
  getRegionId(sceneId: string): string | undefined;

  getFeatureState<T>(key: string): T | undefined;
  getAllFeatureStates<T>(): Array<{ key: string; state: T }>;
  getOtherFeatureState<T>(featureId: string, key: string): T | undefined;
}

export interface ReadContextOptions {
  callerFeatureId: string;
  callerScope?: FeatureStateScope;
}

export function makeDGSMFeatureReadContext(
  dgsm: DynamicGameStateManager,
  opts: ReadContextOptions,
): FeatureReadContext {
  const scope = opts.callerScope ?? "scene";
  return {
    get gameDay() {
      return dgsm.getGameDay();
    },
    get tickTime() {
      return dgsm.getTickTime();
    },
    tickDurationMinutes: 1,

    getSceneIds: () => dgsm.getAllSceneIds(),
    getScene: (id) => dgsm.getScene(id) ?? undefined,
    getCharacter: (id) => dgsm.getNpcProfile(id),
    getCharactersInScene: (sceneId) =>
      dgsm
        .getCharactersInScene(sceneId)
        .map((npcId) => dgsm.getNpcProfile(npcId))
        .filter((p): p is DynamicNPCProfile => p !== undefined),
    getRegionId: (sceneId) => dgsm.getRegionIdForScene(sceneId),

    getFeatureState<T>(key: string) {
      return dgsm.getScopedFeatureState<T>(opts.callerFeatureId, scope, key);
    },
    getAllFeatureStates<T>() {
      return dgsm.getAllScopedFeatureStates<T>(opts.callerFeatureId, scope);
    },
    getOtherFeatureState<T>(featureId: string, key: string) {
      // Caller is responsible for knowing the other feature's scope; if
      // unknown, try all scopes in priority order and return first hit.
      const scopes: FeatureStateScope[] = [
        "scene",
        "region",
        "character",
        "global",
      ];
      for (const s of scopes) {
        const v = dgsm.getScopedFeatureState<T>(featureId, s, key);
        if (v !== undefined) return v;
      }
      return undefined;
    },
  };
}
