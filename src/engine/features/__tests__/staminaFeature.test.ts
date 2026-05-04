import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { makeDGSMFeatureReadContext } from "../../core/featureReadContext.js";
import {
  DEFAULT_ENVIRONMENT_READING,
  type StateChange,
} from "../../core/types.js";
import {
  type StaminaCharacterState,
  staminaFeature,
} from "../staminaFeature.js";

// ===== Test plumbing =====

function makeStaminaCtx(
  dgsm: DynamicGameStateManager,
  overrides?: { tickDurationMinutes?: number }
) {
  const base = makeDGSMFeatureReadContext(dgsm, {
    callerFeatureId: "stamina",
    callerScope: "character",
  });
  if (!overrides?.tickDurationMinutes) return base;
  return { ...base, tickDurationMinutes: overrides.tickDurationMinutes };
}

/**
 * Apply ONLY the kinds stamina emits that mutate state we read across ticks
 * (feature.setState). Conditions/HP/SAN are inspected on the raw StateChange
 * list and don't need to be flushed back into DGSM for the loop to work.
 */
function applyStaminaMutations(
  dgsm: DynamicGameStateManager,
  changes: StateChange[]
): void {
  for (const c of changes) {
    if (c.kind === "feature.setState" && c.featureId === "stamina") {
      dgsm.setScopedFeatureState("stamina", "character", c.key, c.state);
    }
  }
}

function seedNpc(
  dgsm: DynamicGameStateManager,
  npcId: string,
  sceneId: string
) {
  dgsm.updateScene(sceneId, {
    id: sceneId,
    name: sceneId,
    description: "",
    parentLocationId: "town",
    items: [],
    conditions: [],
    connections: [],
  });
  dgsm.registerNpcProfile({
    id: npcId,
    name: npcId,
    attributes: {} as never,
    status: { hp: 12, san: 60, fatigue: 0, conditions: [] } as never,
    inventory: [],
    skills: {},
    longTermIntent: "",
    relationships: [],
  });
  dgsm.setCharacterPosition(npcId, { type: "scene", sceneId });
}

function runStaminaTicks(
  dgsm: DynamicGameStateManager,
  count: number,
  tickDurationMinutes = 5
): StateChange[] {
  const all: StateChange[] = [];
  for (let i = 0; i < count; i++) {
    const ctx = makeStaminaCtx(dgsm, { tickDurationMinutes });
    const changes = staminaFeature.onTick?.(ctx) ?? [];
    applyStaminaMutations(dgsm, changes);
    all.push(...changes);
  }
  return all;
}

// ===== Tests =====

describe("staminaFeature internal invariants", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("level transitions emit Tired then Exhausted character conditions with correct globalSkillPenalty", () => {
    const dgsm = new DynamicGameStateManager();
    seedNpc(dgsm, "npc-1", "tavern");
    // Pin baseline temperature so accel = 1x.
    dgsm.setEnvironmentReading("tavern", { ...DEFAULT_ENVIRONMENT_READING });

    // 96 * 5 = 480 min → tired threshold reached on tick 96.
    const tiredChanges = runStaminaTicks(dgsm, 96);
    const tiredAdds = tiredChanges.filter(
      (c): c is Extract<StateChange, { kind: "character.addCondition" }> =>
        c.kind === "character.addCondition" &&
        c.condition.id === "stamina:tired"
    );
    expect(tiredAdds).toHaveLength(1);
    expect(tiredAdds[0].condition.mechanicalEffect?.globalSkillPenalty).toBe(
      -10
    );
    expect(tiredAdds[0].condition.featureId).toBe("stamina");

    // Continue to tick 192 → 960 min → exhausted.
    const exhaustedChanges = runStaminaTicks(dgsm, 96);
    const removes = exhaustedChanges.filter(
      (c): c is Extract<StateChange, { kind: "character.removeCondition" }> =>
        c.kind === "character.removeCondition" &&
        c.conditionId === "stamina:tired"
    );
    expect(removes.length).toBeGreaterThan(0);
    const exhaustedAdds = exhaustedChanges.filter(
      (c): c is Extract<StateChange, { kind: "character.addCondition" }> =>
        c.kind === "character.addCondition" &&
        c.condition.id === "stamina:exhausted"
    );
    expect(exhaustedAdds).toHaveLength(1);
    expect(
      exhaustedAdds[0].condition.mechanicalEffect?.globalSkillPenalty
    ).toBe(-20);
  });

  it("cold env temperature doubles fatigue accumulation", () => {
    const dgsm = new DynamicGameStateManager();
    seedNpc(dgsm, "npc-2", "frozen_field");
    // 0 °C is below TEMP_HOSTILE_LOW_C (10), so accel = 2x.
    dgsm.setEnvironmentReading("frozen_field", {
      ...DEFAULT_ENVIRONMENT_READING,
      temperature: 0,
    });

    // 48 ticks * 5 min * 2x = 480 effective minutes → tired threshold.
    runStaminaTicks(dgsm, 48);
    const state = dgsm.getScopedFeatureState<StaminaCharacterState>(
      "stamina",
      "character",
      "npc-2"
    );
    expect(state).toBeDefined();
    expect(state?.fatigue).toBe(480);
    expect(state?.fatigueLevel).toBe(1);
  });

  it("CON failure at exhausted emits character.hp and character.san deltas", () => {
    const dgsm = new DynamicGameStateManager();
    seedNpc(dgsm, "npc-3", "alley");
    dgsm.setEnvironmentReading("alley", { ...DEFAULT_ENVIRONMENT_READING });
    // Seed at exhausted + 1 minute past threshold so first tick stays at level 2
    // (no level transition emit) and the drain counter is fresh.
    dgsm.setScopedFeatureState<StaminaCharacterState>(
      "stamina",
      "character",
      "npc-3",
      { fatigue: 961, fatigueLevel: 2, exhaustedDrainTicks: 0 }
    );

    // Force CON fail (random < 0.3) and a deterministic d3 = 1 (random ≈ 0.0).
    vi.spyOn(Math, "random").mockReturnValue(0.01);

    // 6 ticks → triggers the drain check on the 6th.
    const changes = runStaminaTicks(dgsm, 6, 1);

    const hpEmits = changes.filter(
      (c): c is Extract<StateChange, { kind: "character.hp" }> =>
        c.kind === "character.hp" && c.characterId === "npc-3"
    );
    const sanEmits = changes.filter(
      (c): c is Extract<StateChange, { kind: "character.san" }> =>
        c.kind === "character.san" && c.characterId === "npc-3"
    );
    expect(hpEmits).toHaveLength(1);
    expect(hpEmits[0].delta).toBe(-1);
    expect(hpEmits[0].sourceFeatureId).toBe("stamina");
    expect(hpEmits[0].reason).toBe("exhaustion");
    expect(sanEmits).toHaveLength(1);
    expect(sanEmits[0].delta).toBeLessThan(0);
    expect(sanEmits[0].sourceFeatureId).toBe("stamina");
  });
});
