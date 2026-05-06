import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { ModuleSetup } from "../../../state/types.js";
import { type TickEngine, createTickEngine } from "../../core/tickEngine.js";
import type { WorldFeature } from "../../core/worldFeature.js";
import { fireFeature } from "../../features/fireFeature.js";
import { itemDamageFeature } from "../../features/itemDamageFeature.js";
import { staminaFeature } from "../../features/staminaFeature.js";
import { sunFeature } from "../../features/sunFeature.js";
import { weatherFeature } from "../../features/weatherFeature.js";

/**
 * Layer-2 integration harness — wires a real TickEngine with the default Phase
 * D feature set (weather, sun, fire, stamina, itemDamage), a stub
 * interpretAction that forwards `__definitionId` + the rest of `overlayFields`
 * onto the ActionStep, and a no-op resolver. Mirrors the pattern in
 * `core/__tests__/scriptedEventRunner.integration.test.ts` but adds DGSM
 * convenience seeders so individual chain tests stay focused on the assertion
 * logic rather than world-construction boilerplate.
 */

export interface IntegrationEngineSetup {
  dgsm: DynamicGameStateManager;
  engine: TickEngine;
  /** Run N ticks back-to-back. */
  tickN: (n: number) => Promise<void>;
}

export interface IntegrationEngineOptions {
  /** Override the default feature set (e.g. test fire+stamina only). */
  features?: WorldFeature[];
  /** Pre-populate DGSM with module setup (weather presets etc.). */
  moduleSetup?: ModuleSetup;
  /** Initial game datetime. */
  initialTime?: string;
  /** Tick duration in minutes (default 1). */
  tickDurationMinutes?: number;
}

const DEFAULT_FEATURES: WorldFeature[] = [
  weatherFeature,
  sunFeature,
  fireFeature,
  staminaFeature,
  itemDamageFeature,
];

export function makeIntegrationEngine(
  opts: IntegrationEngineOptions = {}
): IntegrationEngineSetup {
  const dgsm = new DynamicGameStateManager();
  if (opts.moduleSetup) {
    dgsm.loadWorldData({ moduleSetup: opts.moduleSetup });
  }
  const initial = opts.initialTime ?? "1923-10-17T08:00:00";
  dgsm.setGameDateTime(initial);

  const engine = createTickEngine({
    dgsm,
    features: opts.features ?? DEFAULT_FEATURES,
    scriptedEvents: [],
    emergentScanners: [],
    interpretAction: async (input) => ({
      steps: [
        {
          definitionId:
            (input.overlayFields?.__definitionId as string) ?? "noop",
          actionText: input.actionText,
          impact: 0,
        } as never,
      ],
    }),
    resolve: async () => ({
      outcome: { stateChanges: [], elapsedMinutes: 0 } as never,
      plannedDuration: 0,
    }),
    getActorDex: () => 50,
    tickDurationMinutes: opts.tickDurationMinutes ?? 1,
    lang: "en",
  });

  return {
    dgsm,
    engine,
    async tickN(n: number) {
      for (let i = 0; i < n; i++) {
        await engine.tick();
      }
    },
  };
}

/** Seed an NPC profile with full HP/SAN/CON. */
export function seedNpc(
  dgsm: DynamicGameStateManager,
  id: string,
  sceneId: string
): void {
  dgsm.registerNpcProfile({
    id,
    name: id,
    attributes: {
      STR: 50,
      CON: 50,
      DEX: 50,
      APP: 50,
      POW: 50,
      SIZ: 50,
      INT: 50,
      EDU: 50,
    },
    status: {
      hp: 10,
      maxHp: 10,
      san: 50,
      maxSan: 50,
      fatigue: 0,
      maxFatigue: 100,
      luck: 50,
      conditions: [],
    },
    inventory: [],
    skills: {},
    longTermIntent: "",
    relationships: [],
  });
  dgsm.setCharacterPosition(id, { type: "scene", sceneId });
}

/**
 * Insert a scene with the given fields. Mirrors the shape produced by
 * dgsm.ensureScene() but lets callers populate items / parentLocationId /
 * indoor without round-tripping through later setters.
 */
export function seedScene(
  dgsm: DynamicGameStateManager,
  sceneId: string,
  opts: {
    parentLocationId?: string;
    indoor?: boolean;
    items?: Array<{ id: string; name: string }>;
  } = {}
): void {
  dgsm.updateScene(sceneId, {
    id: sceneId,
    name: sceneId,
    description: "",
    parentLocationId: opts.parentLocationId ?? "",
    items: opts.items ?? [],
    conditions: [],
    connections: [],
    indoor: opts.indoor,
  });
}

/**
 * Inject fire state directly into DGSM without going through the ActionIntake
 * → Queue → Resolver → onActionCommit pipeline. Cleaner for tests that just
 * want to verify the env layer's downstream effects (stamina accel, item
 * damage, decay rate). Skipping the action path also avoids the extra tick of
 * lag before fire's onTick first sees the freshly-set state.
 */
export function injectFire(
  dgsm: DynamicGameStateManager,
  sceneId: string,
  intensity: number,
  overrides: Partial<{
    phase: "growing" | "decaying";
    minutesInPhase: number;
    totalBurnMinutes: number;
    growthRate: number;
    decayRate: number;
  }> = {}
): void {
  dgsm.setScopedFeatureState("fire", "scene", sceneId, {
    intensity,
    maxIntensity: 5,
    growthRate: overrides.growthRate ?? 1,
    decayRate: overrides.decayRate ?? 1,
    spreadThreshold: 3,
    phase: overrides.phase ?? "growing",
    minutesInPhase: overrides.minutesInPhase ?? 0,
    totalBurnMinutes: overrides.totalBurnMinutes ?? 0,
  });
}
