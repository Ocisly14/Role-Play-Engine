import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { TownTopology } from "../../state/topologyTypes.js";
import type { DynamicScene, DynamicNPCProfile } from "../../state/types.js";
import { resolveCharacterLocationId } from "../shared/topologyHelpers.js";
import type { EnvironmentReading, FeatureStateScope } from "./types.js";

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
  /**
   * Enumerate all road IDs from the topology. Used by features (e.g. sun)
   * that contribute to every outdoor location regardless of region.
   */
  getRoadIds(): string[];
  /**
   * Enumerate all junction IDs from the topology. Mirrors getRoadIds —
   * used by features that contribute to every outdoor location.
   */
  getJunctionIds(): string[];
  getCharacter(characterId: string): DynamicNPCProfile | undefined;
  getCharactersInScene(sceneId: string): DynamicNPCProfile[];
  /**
   * Enumerate all currently-alive NPC IDs. Used by per-character features
   * (e.g. stamina) to iterate every tracked character without having to walk
   * the scene graph.
   */
  getAllAliveCharacterIds(): string[];
  /**
   * Resolve a character's current location ID (scene / road / junction),
   * routing through the same `resolveCharacterLocationId` helper used by
   * pre-Phase-D feature code. Returns `undefined` when no position is set.
   */
  getCharacterLocationId(characterId: string): string | undefined;
  getRegionId(sceneId: string): string | undefined;

  getFeatureState<T>(key: string): T | undefined;
  getAllFeatureStates<T>(): Array<{ key: string; state: T }>;
  getOtherFeatureState<T>(featureId: string, key: string): T | undefined;

  getEnvironmentReading(locationId: string): EnvironmentReading;

  /**
   * Read per-feature initialization config planted by the module loader into
   * `moduleSetup.featureInit[featureId]`. Features consume this from their
   * optional `init()` hook during TickOrchestrator Phase 0. Returns
   * `undefined` when no config is present for the feature.
   */
  getFeatureInitConfig<T>(featureId: string): T | undefined;

  /**
   * Enumerate outdoor location IDs (scenes with !indoor, plus junctions and
   * roads) belonging to the given region. Used by the weather feature's init
   * hook to compute affectedSceneIds; kept as a bundled helper so features
   * don't need to peek at raw DGSM collections.
   */
  getOutdoorLocationIdsInRegion(regionId: string): string[];

  /**
   * Read the precomputed topology index (junctions/roads/sceneToParent maps).
   * Used by features whose propagation rules depend on outdoor topology, e.g.
   * fire spreading scene → road/junction → adjacent scenes. Returns undefined
   * when no topology has been loaded (legacy modules / pure-scene worlds).
   */
  getTopology(): TownTopology | undefined;
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
    getRoadIds: () => Array.from(dgsm.getState().roads.keys()),
    getJunctionIds: () => Array.from(dgsm.getState().junctions.keys()),
    getCharacter: (id) => dgsm.getNpcProfile(id),
    getCharactersInScene: (sceneId) =>
      dgsm
        .getCharactersInScene(sceneId)
        .map((npcId) => dgsm.getNpcProfile(npcId))
        .filter((p): p is DynamicNPCProfile => p !== undefined),
    getAllAliveCharacterIds: () =>
      dgsm
        .getState()
        .npcCharacters.filter((n) => dgsm.isNpcAlive(n.id))
        .map((n) => n.id),
    getCharacterLocationId: (characterId) =>
      resolveCharacterLocationId(characterId, dgsm),
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

    getEnvironmentReading: (locationId) =>
      dgsm.getEnvironmentReading(locationId),

    getFeatureInitConfig<T>(featureId: string): T | undefined {
      const setup = dgsm.getState().moduleSetup;
      const init = (setup as { featureInit?: unknown } | null)?.featureInit;
      if (!init || typeof init !== "object") return undefined;
      return (init as Record<string, unknown>)[featureId] as T | undefined;
    },

    getOutdoorLocationIdsInRegion(regionId: string): string[] {
      const state = dgsm.getState();
      const out: string[] = [];
      state.scenes.forEach((scene, id) => {
        if (scene.parentLocationId === regionId && !scene.indoor) {
          out.push(id);
        }
      });
      for (const [id, junc] of state.junctions) {
        if (junc.parentLocationId === regionId) out.push(id);
      }
      for (const [id, road] of state.roads) {
        if (road.parentLocationId === regionId) out.push(id);
      }
      return out;
    },

    getTopology(): TownTopology | undefined {
      return dgsm.getTopology() ?? undefined;
    },
  };
}
