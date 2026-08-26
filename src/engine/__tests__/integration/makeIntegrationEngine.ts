import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { ModuleSetup } from "../../../state/types.js";
import { type TickEngine, createTickEngine } from "../../core/tickEngine.js";
import { createDefaultSubsystemRegistry } from "../../registerDefaults.js";
import type { SubsystemRegistry } from "../../subsystem/registry.js";

/**
 * Layer-2 integration harness — wires a real TickEngine with the default
 * subsystem registry (weather, sun, fire, stamina, itemDamage, movement,
 * condition expiry) and a stub World Action Engine that resolves nothing
 * (idle clock ticks: zero model calls, deterministic subsystems only).
 * Mirrors the pattern in
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
  /** Override the default subsystem registry (e.g. test fire+stamina only). */
  subsystemRegistry?: SubsystemRegistry;
  /** Pre-populate DGSM with module setup (weather presets etc.). */
  moduleSetup?: ModuleSetup;
  /** Initial game datetime. */
  initialTime?: string;
  /** Tick duration in minutes (default 1). */
  tickDurationMinutes?: number;
}

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
    subsystemRegistry:
      opts.subsystemRegistry ?? createDefaultSubsystemRegistry(),
    scriptedEvents: [],
    tickDurationMinutes: opts.tickDurationMinutes ?? 1,
    // Tests never hit the real LLM session: fail every triggered action
    // deterministically. Idle ticks never call this at all.
    resolveTickFn: async (context) => {
      const { finalizeResolution } = await import(
        "../../resolution/worldDeltaValidator.js"
      );
      const finalized = finalizeResolution({ actions: [] }, context, []);
      return {
        resolution: finalized.resolution,
        droppedViolations: finalized.droppedViolations,
        codeToolInvocations: [],
        judgements: {},
        movementInits: {},
      };
    },
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
