import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TickRuntimeContext } from "../../types.js";
import {
  BOUT_DESCRIPTIONS,
  BOUT_OF_MADNESS_TABLE,
  applySanityLoss,
  buildInsanityConditionString,
  checkIndefiniteInsanityTrigger,
  checkTemporaryInsanityTrigger,
  computeGameTimeMinutes,
  createEmptySanityState,
  generatePhobiaManiaSubject,
  getHourlyCumulativeLoss,
  getSanityState,
  injectInsanityCondition,
  recordSanLoss,
  removeInsanityCondition,
  rollBoutOfMadness,
  rollIndefiniteDuration,
  rollIndefiniteOnsetDelay,
  rollTemporaryDuration,
  sanityFeature,
  setSanityState,
} from "../sanityFeature.js";

// ===== Mock DGSM =====

function createMockDgsm() {
  const featureState: Record<string, Record<string, unknown>> = {};
  const characterPositions: Record<string, any> = {};
  const npcStats: Record<string, { hp: number; san: number }> = {};
  const npcCharacters: Array<{
    id: string;
    name: string;
    status: {
      hp: number;
      san: number;
      maxSan: number;
      conditions: string[];
    };
  }> = [];

  return {
    getFeatureSceneState(featureId: string, sceneId: string) {
      return featureState[featureId]?.[sceneId];
    },
    setFeatureSceneState(featureId: string, sceneId: string, data: unknown) {
      if (!featureState[featureId]) featureState[featureId] = {};
      featureState[featureId][sceneId] = data;
    },
    getFeatureState(featureId: string) {
      return featureState[featureId] ?? {};
    },
    getState() {
      return {
        characterPositions,
        npcStats,
        npcCharacters,
        timeOfDay: "08:00",
        gameDay: 1,
      };
    },
    updateNpcHp(npcId: string, delta: number) {
      if (!npcStats[npcId]) return;
      npcStats[npcId].hp = Math.max(0, npcStats[npcId].hp + delta);
    },
    updateNpcSan(npcId: string, delta: number) {
      if (!npcStats[npcId]) return;
      npcStats[npcId].san = Math.max(0, npcStats[npcId].san + delta);
    },
    getNpcStats(npcId: string) {
      return npcStats[npcId];
    },
    _addNpc(
      npcId: string,
      location: string,
      hp: number,
      san = 50,
      maxSan = 99
    ) {
      characterPositions[npcId] = { type: "scene", sceneId: location };
      npcStats[npcId] = { hp, san };
      npcCharacters.push({
        id: npcId,
        name: npcId,
        status: { hp, san, maxSan, conditions: [] },
      });
    },
    isNpcAlive(npcId: string) {
      const stats = npcStats[npcId];
      return stats ? stats.hp > 0 : false;
    },
    _featureState: featureState,
    _npcStats: npcStats,
  };
}

type MockDgsm = ReturnType<typeof createMockDgsm>;

// ===== Tests =====

describe("sanityFeature", () => {
  let dgsm: MockDgsm;

  beforeEach(() => {
    dgsm = createMockDgsm();
    dgsm._addNpc("npc-test", "tavern", 12, 60);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===== BOUT_OF_MADNESS_TABLE structure =====

  describe("BOUT_OF_MADNESS_TABLE", () => {
    it("should have exactly 10 entries", () => {
      expect(BOUT_OF_MADNESS_TABLE).toHaveLength(10);
    });

    it("should have rolls numbered 1-10", () => {
      const rolls = BOUT_OF_MADNESS_TABLE.map((e) => e.roll);
      expect(rolls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("should mark phobia (roll 9) as persistent", () => {
      const phobiaEntry = BOUT_OF_MADNESS_TABLE.find(
        (e) => e.boutType === "phobia"
      );
      expect(phobiaEntry).toBeDefined();
      expect(phobiaEntry!.persistent).toBe(true);
      expect(phobiaEntry!.roll).toBe(9);
    });

    it("should mark mania (roll 10) as persistent", () => {
      const maniaEntry = BOUT_OF_MADNESS_TABLE.find(
        (e) => e.boutType === "mania"
      );
      expect(maniaEntry).toBeDefined();
      expect(maniaEntry!.persistent).toBe(true);
      expect(maniaEntry!.roll).toBe(10);
    });

    it("should have only phobia and mania as persistent entries", () => {
      const persistentEntries = BOUT_OF_MADNESS_TABLE.filter(
        (e) => e.persistent
      );
      expect(persistentEntries).toHaveLength(2);
      expect(persistentEntries.map((e) => e.boutType).sort()).toEqual([
        "mania",
        "phobia",
      ]);
    });

    it("should have faint and hysterics with incapacitated restriction", () => {
      const incapacitated = BOUT_OF_MADNESS_TABLE.filter(
        (e) => e.actionRestriction === "incapacitated"
      );
      expect(incapacitated).toHaveLength(2);
      expect(incapacitated.map((e) => e.boutType).sort()).toEqual([
        "faint",
        "hysterics",
      ]);
    });

    it("should have violence with attack_only restriction", () => {
      const entry = BOUT_OF_MADNESS_TABLE.find(
        (e) => e.boutType === "violence"
      );
      expect(entry!.actionRestriction).toBe("attack_only");
    });

    it("should have flee with flee_only restriction", () => {
      const entry = BOUT_OF_MADNESS_TABLE.find((e) => e.boutType === "flee");
      expect(entry!.actionRestriction).toBe("flee_only");
    });

    it("should have each boutType as unique", () => {
      const boutTypes = BOUT_OF_MADNESS_TABLE.map((e) => e.boutType);
      expect(new Set(boutTypes).size).toBe(boutTypes.length);
    });
  });

  // ===== computeGameTimeMinutes =====

  describe("computeGameTimeMinutes", () => {
    it("should convert day 1, 00:00 to 0 minutes", () => {
      expect(computeGameTimeMinutes(1, "00:00")).toBe(0);
    });

    it("should convert day 1, 08:00 to 480 minutes", () => {
      expect(computeGameTimeMinutes(1, "08:00")).toBe(480);
    });

    it("should convert day 1, 23:59 to 1439 minutes", () => {
      expect(computeGameTimeMinutes(1, "23:59")).toBe(1439);
    });

    it("should convert day 2, 00:00 to 1440 minutes", () => {
      expect(computeGameTimeMinutes(2, "00:00")).toBe(1440);
    });

    it("should convert day 2, 12:30 to 2190 minutes", () => {
      // (2-1)*1440 + 12*60 + 30 = 1440 + 720 + 30 = 2190
      expect(computeGameTimeMinutes(2, "12:30")).toBe(2190);
    });

    it("should convert day 3, 06:15 to 3255 minutes", () => {
      // (3-1)*1440 + 6*60 + 15 = 2880 + 360 + 15 = 3255
      expect(computeGameTimeMinutes(3, "06:15")).toBe(3255);
    });
  });

  // ===== State helpers =====

  describe("state helpers", () => {
    it("should create an empty sanity state with correct defaults", () => {
      const state = createEmptySanityState();
      expect(state.sanLossLog).toEqual([]);
      expect(state.activeInsanity).toBeNull();
      expect(state.persistentConditions).toEqual([]);
    });

    it("should get/set sanity state roundtrip", () => {
      const state = createEmptySanityState();
      state.sanLossLog.push({ amount: 3, gameTimeMinutes: 100 });

      setSanityState(dgsm as any, "player-1", state);
      const retrieved = getSanityState(dgsm as any, "player-1");

      expect(retrieved).toBeDefined();
      expect(retrieved!.sanLossLog).toHaveLength(1);
      expect(retrieved!.sanLossLog[0].amount).toBe(3);
      expect(retrieved!.sanLossLog[0].gameTimeMinutes).toBe(100);
    });

    it("should return undefined for non-existent character state", () => {
      const retrieved = getSanityState(dgsm as any, "non-existent");
      expect(retrieved).toBeUndefined();
    });

    it("should record sanity loss to the log", () => {
      const state = createEmptySanityState();
      recordSanLoss(state, 5, 100);
      recordSanLoss(state, 3, 150);

      expect(state.sanLossLog).toHaveLength(2);
      expect(state.sanLossLog[0]).toEqual({ amount: 5, gameTimeMinutes: 100 });
      expect(state.sanLossLog[1]).toEqual({ amount: 3, gameTimeMinutes: 150 });
    });

    describe("getHourlyCumulativeLoss", () => {
      it("should sum losses within the 60-minute window", () => {
        const state = createEmptySanityState();
        recordSanLoss(state, 3, 50);
        recordSanLoss(state, 2, 80);
        recordSanLoss(state, 4, 100);

        // At time 100, window is (40, 100]
        // 50 > 40 → included (3)
        // 80 > 40 → included (2)
        // 100 > 40 and <= 100 → included (4)
        expect(getHourlyCumulativeLoss(state, 100)).toBe(9);
      });

      it("should exclude losses outside the 60-minute window", () => {
        const state = createEmptySanityState();
        recordSanLoss(state, 5, 10); // outside window
        recordSanLoss(state, 3, 50); // inside window

        // At time 100, window is (40, 100]
        // 10 <= 40 → excluded
        // 50 > 40 → included (3)
        expect(getHourlyCumulativeLoss(state, 100)).toBe(3);
      });

      it("should return 0 when no losses are in the window", () => {
        const state = createEmptySanityState();
        recordSanLoss(state, 5, 10);

        // At time 100, window is (40, 100]
        expect(getHourlyCumulativeLoss(state, 100)).toBe(0);
      });

      it("should return 0 for empty log", () => {
        const state = createEmptySanityState();
        expect(getHourlyCumulativeLoss(state, 100)).toBe(0);
      });

      it("should exclude losses at exactly the window boundary", () => {
        const state = createEmptySanityState();
        recordSanLoss(state, 5, 40); // exactly at windowStart (100 - 60 = 40)

        // window is (40, 100], strictly > 40
        expect(getHourlyCumulativeLoss(state, 100)).toBe(0);
      });

      it("should include losses at exactly the current time", () => {
        const state = createEmptySanityState();
        recordSanLoss(state, 5, 100); // exactly at currentTimeMinutes

        // window is (40, 100], 100 <= 100 → included
        expect(getHourlyCumulativeLoss(state, 100)).toBe(5);
      });
    });
  });

  // ===== Trigger detection =====

  describe("trigger detection", () => {
    describe("checkTemporaryInsanityTrigger", () => {
      it("should return true when loss >= 5", () => {
        expect(checkTemporaryInsanityTrigger(5)).toBe(true);
      });

      it("should return true when loss > 5", () => {
        expect(checkTemporaryInsanityTrigger(8)).toBe(true);
      });

      it("should return false when loss < 5", () => {
        expect(checkTemporaryInsanityTrigger(4)).toBe(false);
      });

      it("should return false when loss is 0", () => {
        expect(checkTemporaryInsanityTrigger(0)).toBe(false);
      });

      it("should return false when loss is 1", () => {
        expect(checkTemporaryInsanityTrigger(1)).toBe(false);
      });
    });

    describe("checkIndefiniteInsanityTrigger", () => {
      it("should return true when cumulative >= currentSan / 5", () => {
        // 60 / 5 = 12; cumulative = 12 → true
        expect(checkIndefiniteInsanityTrigger(12, 60)).toBe(true);
      });

      it("should return true when cumulative exceeds currentSan / 5", () => {
        // 60 / 5 = 12; cumulative = 15 → true
        expect(checkIndefiniteInsanityTrigger(15, 60)).toBe(true);
      });

      it("should return false when cumulative < currentSan / 5", () => {
        // 60 / 5 = 12; cumulative = 11 → false
        expect(checkIndefiniteInsanityTrigger(11, 60)).toBe(false);
      });

      it("should handle edge case with low sanity", () => {
        // 5 / 5 = 1; cumulative = 1 → true
        expect(checkIndefiniteInsanityTrigger(1, 5)).toBe(true);
      });

      it("should handle edge case with zero sanity", () => {
        // 0 / 5 = 0; cumulative = 0 → true (0 >= 0)
        expect(checkIndefiniteInsanityTrigger(0, 0)).toBe(true);
      });

      it("should handle non-integer threshold", () => {
        // 13 / 5 = 2.6; cumulative = 2 → false
        expect(checkIndefiniteInsanityTrigger(2, 13)).toBe(false);
        // cumulative = 3 → true (3 >= 2.6)
        expect(checkIndefiniteInsanityTrigger(3, 13)).toBe(true);
      });
    });
  });

  // ===== Dice rolls =====

  describe("dice rolls", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe("rollBoutOfMadness", () => {
      it("should always return a valid BoutTableEntry", () => {
        for (let i = 0; i < 100; i++) {
          const entry = rollBoutOfMadness();
          expect(entry).toBeDefined();
          expect(entry.roll).toBeGreaterThanOrEqual(1);
          expect(entry.roll).toBeLessThanOrEqual(10);
          expect(entry.boutType).toBeDefined();
          expect(entry.actionRestriction).toBeDefined();
          expect(entry.label).toBeDefined();
        }
      });

      it("should return specific entry for mocked random values", () => {
        const mockRandom = vi.spyOn(Math, "random");

        // random = 0.0 → Math.floor(0.0 * 10) + 1 = 1 → roll 1 (amnesia)
        mockRandom.mockReturnValueOnce(0.0);
        expect(rollBoutOfMadness().boutType).toBe("amnesia");

        // random = 0.9 → Math.floor(0.9 * 10) + 1 = 10 → roll 10 (mania)
        mockRandom.mockReturnValueOnce(0.9);
        expect(rollBoutOfMadness().boutType).toBe("mania");

        // random = 0.5 → Math.floor(0.5 * 10) + 1 = 6 → roll 6 (faint)
        mockRandom.mockReturnValueOnce(0.5);
        expect(rollBoutOfMadness().boutType).toBe("faint");
      });
    });

    describe("rollTemporaryDuration", () => {
      it("should always return a value between 60 and 600 (inclusive)", () => {
        for (let i = 0; i < 100; i++) {
          const duration = rollTemporaryDuration();
          expect(duration).toBeGreaterThanOrEqual(60);
          expect(duration).toBeLessThanOrEqual(600);
        }
      });

      it("should always return a multiple of 60", () => {
        for (let i = 0; i < 50; i++) {
          const duration = rollTemporaryDuration();
          expect(duration % 60).toBe(0);
        }
      });

      it("should return specific values for mocked random", () => {
        const mockRandom = vi.spyOn(Math, "random");

        // random = 0.0 → roll 1 → 60
        mockRandom.mockReturnValueOnce(0.0);
        expect(rollTemporaryDuration()).toBe(60);

        // random = 0.99 → Math.floor(0.99*10)+1 = 10 → 600
        mockRandom.mockReturnValueOnce(0.99);
        expect(rollTemporaryDuration()).toBe(600);
      });
    });

    describe("rollIndefiniteOnsetDelay", () => {
      it("should always return a value between 60 and 360 (inclusive)", () => {
        for (let i = 0; i < 100; i++) {
          const delay = rollIndefiniteOnsetDelay();
          expect(delay).toBeGreaterThanOrEqual(60);
          expect(delay).toBeLessThanOrEqual(360);
        }
      });

      it("should always return a multiple of 60", () => {
        for (let i = 0; i < 50; i++) {
          const delay = rollIndefiniteOnsetDelay();
          expect(delay % 60).toBe(0);
        }
      });

      it("should return specific values for mocked random", () => {
        const mockRandom = vi.spyOn(Math, "random");

        // random = 0.0 → roll 1 → 60
        mockRandom.mockReturnValueOnce(0.0);
        expect(rollIndefiniteOnsetDelay()).toBe(60);

        // random = 0.99 → Math.floor(0.99*6)+1 = 6 → 360
        mockRandom.mockReturnValueOnce(0.99);
        expect(rollIndefiniteOnsetDelay()).toBe(360);
      });
    });

    describe("rollIndefiniteDuration", () => {
      it("should always return a value between 1440 and 14400 (inclusive)", () => {
        for (let i = 0; i < 100; i++) {
          const duration = rollIndefiniteDuration();
          expect(duration).toBeGreaterThanOrEqual(1440);
          expect(duration).toBeLessThanOrEqual(14400);
        }
      });

      it("should always return a multiple of 1440", () => {
        for (let i = 0; i < 50; i++) {
          const duration = rollIndefiniteDuration();
          expect(duration % 1440).toBe(0);
        }
      });

      it("should return specific values for mocked random", () => {
        const mockRandom = vi.spyOn(Math, "random");

        // random = 0.0 → roll 1 → 1440
        mockRandom.mockReturnValueOnce(0.0);
        expect(rollIndefiniteDuration()).toBe(1440);

        // random = 0.99 → Math.floor(0.99*10)+1 = 10 → 14400
        mockRandom.mockReturnValueOnce(0.99);
        expect(rollIndefiniteDuration()).toBe(14400);
      });
    });
  });

  // ===== Condition string building =====

  describe("buildInsanityConditionString", () => {
    it("should build a temporary insanity condition string", () => {
      const result = buildInsanityConditionString(
        "temporary",
        "flee",
        "Flee in Panic",
        "flee_only"
      );
      expect(result).toBe(
        "[Insanity:temporary] Flee in Panic | restriction:flee_only"
      );
    });

    it("should build an indefinite insanity condition string", () => {
      const result = buildInsanityConditionString(
        "indefinite",
        "amnesia",
        "Amnesia",
        "impaired"
      );
      expect(result).toBe(
        "[Insanity:indefinite] Amnesia | restriction:impaired"
      );
    });

    it("should build a persistent phobia condition string with subject", () => {
      const result = buildInsanityConditionString(
        "phobia",
        "phobia",
        "Phobia",
        "impaired",
        "tentacles"
      );
      expect(result).toBe("[Insanity:phobia] Phobia (tentacles) | persistent");
    });

    it("should build a persistent mania condition string with subject", () => {
      const result = buildInsanityConditionString(
        "mania",
        "mania",
        "Mania",
        "impaired",
        "fire"
      );
      expect(result).toBe("[Insanity:mania] Mania (fire) | persistent");
    });

    it("should build a persistent condition string without subject", () => {
      const result = buildInsanityConditionString(
        "phobia",
        "phobia",
        "Phobia",
        "impaired"
      );
      expect(result).toBe("[Insanity:phobia] Phobia | persistent");
    });

    it("should start with [Insanity for all condition types", () => {
      const temp = buildInsanityConditionString(
        "temporary",
        "faint",
        "Faint",
        "incapacitated"
      );
      const indef = buildInsanityConditionString(
        "indefinite",
        "violence",
        "Violence",
        "attack_only"
      );
      const phobia = buildInsanityConditionString(
        "phobia",
        "phobia",
        "Phobia",
        "impaired",
        "spiders"
      );
      const mania = buildInsanityConditionString(
        "mania",
        "mania",
        "Mania",
        "impaired",
        "collecting"
      );

      expect(temp.startsWith("[Insanity")).toBe(true);
      expect(indef.startsWith("[Insanity")).toBe(true);
      expect(phobia.startsWith("[Insanity")).toBe(true);
      expect(mania.startsWith("[Insanity")).toBe(true);
    });
  });

  // ===== Condition injection =====

  describe("injectInsanityCondition", () => {
    it("should inject condition into NPC character", () => {
      const condition =
        "[Insanity:temporary] Flee in Panic | restriction:flee_only";
      injectInsanityCondition(dgsm as any, "npc-test", condition);

      const npc = dgsm
        .getState()
        .npcCharacters.find((n) => n.id === "npc-test");
      expect(npc!.status.conditions).toContain(condition);
    });

    it("should inject condition into NPC character", () => {
      dgsm._addNpc("npc-guard", "tavern", 10, 40);

      const condition =
        "[Insanity:temporary] Faint | restriction:incapacitated";
      injectInsanityCondition(dgsm as any, "npc-guard", condition);

      const npc = dgsm
        .getState()
        .npcCharacters.find((n) => n.id === "npc-guard");
      expect(npc!.status.conditions).toContain(condition);
    });

    it("should not throw for non-existent NPC", () => {
      const condition =
        "[Insanity:temporary] Faint | restriction:incapacitated";
      expect(() =>
        injectInsanityCondition(dgsm as any, "non-existent", condition)
      ).not.toThrow();
    });

    it("should allow multiple conditions on the same character", () => {
      const condition1 =
        "[Insanity:temporary] Violence | restriction:attack_only";
      const condition2 = "[Insanity:phobia] Phobia (darkness) | persistent";
      injectInsanityCondition(dgsm as any, "npc-test", condition1);
      injectInsanityCondition(dgsm as any, "npc-test", condition2);

      const npc = dgsm
        .getState()
        .npcCharacters.find((n) => n.id === "npc-test");
      expect(npc!.status.conditions).toHaveLength(2);
      expect(npc!.status.conditions).toContain(condition1);
      expect(npc!.status.conditions).toContain(condition2);
    });
  });

  // ===== Condition removal =====

  describe("removeInsanityCondition", () => {
    it("should remove all insanity conditions from NPC", () => {
      const npc = dgsm
        .getState()
        .npcCharacters.find((n) => n.id === "npc-test")!;
      npc.status.conditions = [
        "[Insanity:temporary] Flee in Panic | restriction:flee_only",
        "[Insanity:phobia] Phobia (spiders) | persistent",
        "Some other condition",
      ];

      removeInsanityCondition(dgsm as any, "npc-test");

      expect(npc.status.conditions).toEqual(["Some other condition"]);
    });

    it("should remove all insanity conditions from NPC", () => {
      dgsm._addNpc("npc-guard", "tavern", 10, 40);

      const npc = dgsm
        .getState()
        .npcCharacters.find((n) => n.id === "npc-guard")!;
      npc.status.conditions = [
        "[Insanity:temporary] Violence | restriction:attack_only",
        "Wounded",
      ];

      removeInsanityCondition(dgsm as any, "npc-guard");

      expect(npc.status.conditions).toEqual(["Wounded"]);
    });

    it("should keep persistent conditions when keepPersistent is true", () => {
      const npc = dgsm
        .getState()
        .npcCharacters.find((n) => n.id === "npc-test")!;
      npc.status.conditions = [
        "[Insanity:temporary] Flee in Panic | restriction:flee_only",
        "[Insanity:phobia] Phobia (spiders) | persistent",
        "[Insanity:mania] Mania (fire) | persistent",
        "Some other condition",
      ];

      removeInsanityCondition(dgsm as any, "npc-test", true);

      expect(npc.status.conditions).toEqual([
        "[Insanity:phobia] Phobia (spiders) | persistent",
        "[Insanity:mania] Mania (fire) | persistent",
        "Some other condition",
      ]);
    });

    it("should remove persistent conditions when keepPersistent is false/undefined", () => {
      const npc = dgsm
        .getState()
        .npcCharacters.find((n) => n.id === "npc-test")!;
      npc.status.conditions = [
        "[Insanity:temporary] Flee in Panic | restriction:flee_only",
        "[Insanity:phobia] Phobia (spiders) | persistent",
      ];

      removeInsanityCondition(dgsm as any, "npc-test", false);

      expect(npc.status.conditions).toEqual([]);
    });

    it("should not throw for non-existent NPC", () => {
      expect(() =>
        removeInsanityCondition(dgsm as any, "non-existent")
      ).not.toThrow();
    });

    it("should leave non-insanity conditions untouched", () => {
      const npc = dgsm
        .getState()
        .npcCharacters.find((n) => n.id === "npc-test")!;
      npc.status.conditions = [
        "[Fatigue] Tired",
        "Wounded",
        "[Insanity:temporary] Amnesia | restriction:impaired",
      ];

      removeInsanityCondition(dgsm as any, "npc-test");

      expect(npc.status.conditions).toEqual(["[Fatigue] Tired", "Wounded"]);
    });

    it("should handle empty conditions array", () => {
      const npc = dgsm
        .getState()
        .npcCharacters.find((n) => n.id === "npc-test")!;
      npc.status.conditions = [];
      removeInsanityCondition(dgsm as any, "npc-test");
      expect(npc.status.conditions).toEqual([]);
    });
  });

  // ===== applySanityLoss =====

  describe("sanityFeature — applySanityLoss", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("applies SAN delta to NPC", () => {
      // npc-test starts with san = 60
      applySanityLoss(dgsm as any, "npc-test", -5);
      expect(dgsm._npcStats["npc-test"].san).toBe(55);
    });

    it("applies SAN delta to NPC", () => {
      dgsm._addNpc("npc-guard", "tavern", 10, 40);
      applySanityLoss(dgsm as any, "npc-guard", -5);
      expect(dgsm._npcStats["npc-guard"].san).toBe(35);
    });

    it("clamps SAN to 0", () => {
      // npc-test has san = 60, lose 100
      applySanityLoss(dgsm as any, "npc-test", -100);
      expect(dgsm._npcStats["npc-test"].san).toBe(0);
    });

    it("records loss in sanLossLog", () => {
      // Use a small loss so temporary insanity is not triggered
      applySanityLoss(dgsm as any, "npc-test", -3, 1, "08:00", "saw a corpse");
      const charState = getSanityState(dgsm as any, "npc-test");
      expect(charState).toBeDefined();
      expect(charState!.sanLossLog).toHaveLength(1);
      expect(charState!.sanLossLog[0].amount).toBe(3);
      // gameDay=1, time=08:00 -> 480 minutes
      expect(charState!.sanLossLog[0].gameTimeMinutes).toBe(480);
    });

    it("does NOT trigger temporary insanity for loss < 5", () => {
      applySanityLoss(dgsm as any, "npc-test", -4, 1, "08:00");
      const charState = getSanityState(dgsm as any, "npc-test");
      expect(charState).toBeDefined();
      expect(charState!.activeInsanity).toBeNull();
    });

    it("triggers temporary insanity for loss >= 5", () => {
      // Mock rollBoutOfMadness to return amnesia (roll=1)
      const mockRandom = vi.spyOn(Math, "random");
      // rollBoutOfMadness: random=0.0 -> roll 1 -> amnesia
      mockRandom.mockReturnValueOnce(0.0);
      // rollTemporaryDuration: random=0.0 -> roll 1 -> 60 minutes
      mockRandom.mockReturnValueOnce(0.0);

      applySanityLoss(dgsm as any, "npc-test", -5, 1, "08:00");

      const charState = getSanityState(dgsm as any, "npc-test");
      expect(charState).toBeDefined();
      expect(charState!.activeInsanity).not.toBeNull();
      expect(charState!.activeInsanity!.insanityType).toBe("temporary");
      expect(charState!.activeInsanity!.boutType).toBe("amnesia");
      expect(charState!.activeInsanity!.isActive).toBe(true);
      expect(charState!.activeInsanity!.durationMinutes).toBe(60);
      expect(charState!.activeInsanity!.description).toBe(
        BOUT_DESCRIPTIONS.amnesia
      );

      // Should have injected a condition
      const npc = dgsm
        .getState()
        .npcCharacters.find((n) => n.id === "npc-test");
      expect(
        npc!.status.conditions.some((c: string) =>
          c.startsWith("[Insanity:temporary]")
        )
      ).toBe(true);
    });

    it("triggers indefinite insanity when hourly cumulative >= currentSan/5", () => {
      // npc-test has san=60. currentSan/5 = 60/5 = 12
      // We'll apply 3 losses of 4 within the same hour:
      // After 1st loss: cumulative=4, san=56
      // After 2nd loss: cumulative=8, san=52
      // After 3rd loss: cumulative=12, san=48 -> 12 >= (48+4)/5 = 10.4 -> should trigger

      // First two losses: no insanity (loss < 5, cumulative < threshold)
      applySanityLoss(dgsm as any, "npc-test", -4, 1, "08:00");
      applySanityLoss(dgsm as any, "npc-test", -4, 1, "08:10");

      // Verify no insanity yet
      let charState = getSanityState(dgsm as any, "npc-test");
      expect(charState!.activeInsanity).toBeNull();

      // Third loss: should trigger indefinite
      // Mock: rollBoutOfMadness, rollIndefiniteOnsetDelay, rollIndefiniteDuration
      const mockRandom = vi.spyOn(Math, "random");
      mockRandom.mockReturnValueOnce(0.1); // rollBoutOfMadness: floor(0.1*10)+1 = 2 -> psychosomatic_disability
      mockRandom.mockReturnValueOnce(0.0); // rollIndefiniteOnsetDelay: roll 1 -> 60
      mockRandom.mockReturnValueOnce(0.0); // rollIndefiniteDuration: roll 1 -> 1440

      applySanityLoss(dgsm as any, "npc-test", -4, 1, "08:20");

      charState = getSanityState(dgsm as any, "npc-test");
      expect(charState!.activeInsanity).not.toBeNull();
      expect(charState!.activeInsanity!.insanityType).toBe("indefinite");
      expect(charState!.activeInsanity!.isActive).toBe(false);
      expect(charState!.activeInsanity!.onsetDelayMinutes).toBe(60);
      expect(charState!.activeInsanity!.durationMinutes).toBe(1440);

      // Should NOT have injected a condition (onset delay not expired)
      const npc = dgsm
        .getState()
        .npcCharacters.find((n) => n.id === "npc-test");
      expect(
        npc!.status.conditions.some((c: string) =>
          c.startsWith("[Insanity:indefinite]")
        )
      ).toBe(false);
    });

    it("temporary insanity takes priority over indefinite when both trigger", () => {
      // Set npc-test SAN to 25
      dgsm._npcStats["npc-test"].san = 25;
      // Apply loss of 5: triggers temporary (5>=5), and check indefinite:
      // currentSan before loss = 25, cumulative = 5, 25/5=5, 5>=5 -> both trigger
      // But temporary takes priority

      const mockRandom = vi.spyOn(Math, "random");
      mockRandom.mockReturnValueOnce(0.6); // rollBoutOfMadness: floor(0.6*10)+1 = 7 -> flee
      mockRandom.mockReturnValueOnce(0.4); // rollTemporaryDuration: floor(0.4*10)+1 = 5 -> 300

      applySanityLoss(dgsm as any, "npc-test", -5, 1, "10:00");

      const charState = getSanityState(dgsm as any, "npc-test");
      expect(charState!.activeInsanity).not.toBeNull();
      expect(charState!.activeInsanity!.insanityType).toBe("temporary");
      expect(charState!.activeInsanity!.boutType).toBe("flee");
      expect(charState!.activeInsanity!.isActive).toBe(true);
    });

    it("does not overwrite existing active insanity", () => {
      // First big loss triggers temporary insanity
      const mockRandom = vi.spyOn(Math, "random");
      mockRandom.mockReturnValueOnce(0.2); // rollBoutOfMadness: floor(0.2*10)+1 = 3 -> violence
      mockRandom.mockReturnValueOnce(0.0); // rollTemporaryDuration: roll 1 -> 60

      applySanityLoss(dgsm as any, "npc-test", -5, 1, "08:00");

      const charState1 = getSanityState(dgsm as any, "npc-test");
      expect(charState1!.activeInsanity).not.toBeNull();
      expect(charState1!.activeInsanity!.boutType).toBe("violence");

      // Second big loss should NOT replace the existing insanity
      mockRandom.mockReturnValueOnce(0.5); // Would be faint, but should not be used
      mockRandom.mockReturnValueOnce(0.5);

      applySanityLoss(dgsm as any, "npc-test", -6, 1, "08:05");

      const charState2 = getSanityState(dgsm as any, "npc-test");
      expect(charState2!.activeInsanity!.boutType).toBe("violence"); // Still violence, not overwritten
      expect(charState2!.sanLossLog).toHaveLength(2); // Both losses recorded
    });

    it("positive delta (recovery) does not trigger or log", () => {
      // Apply a recovery
      applySanityLoss(dgsm as any, "npc-test", 5, 1, "08:00");

      // San should increase
      expect(dgsm._npcStats["npc-test"].san).toBe(65);

      // No sanity state should have been created (no loss logged)
      const charState = getSanityState(dgsm as any, "npc-test");
      expect(charState).toBeUndefined();
    });
  });
});

// ===== Mock runtime helper =====

function createMockRuntime(
  overrides?: Partial<TickRuntimeContext>
): TickRuntimeContext {
  return {
    sessionId: "test-session",
    gameDay: 1,
    language: "en",
    tickTime: "08:00",
    tickDurationMinutes: 5,
    npcPlanning: {
      getPendingNodes: async () => [],
      runImpactGateForNpc: async () => ({
        shouldUpdateIntent: false,
        shouldInterruptCurrentNode: false,
        shouldReviseSchedule: false,
      }),
      generateImpactObservationForNpc: async () => "",
    },
    ...overrides,
  };
}

// ===== WorldFeature interface tests =====

describe("sanityFeature — WorldFeature interface", () => {
  let dgsm: ReturnType<typeof createMockDgsm>;

  beforeEach(() => {
    dgsm = createMockDgsm();
    dgsm._addNpc("npc-test", "tavern", 12, 60);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct id and description", () => {
    expect(sanityFeature.id).toBe("sanity");
    expect(sanityFeature.description).toBeTruthy();
    expect(sanityFeature.description.length).toBeGreaterThan(10);
  });

  it("planningPrompt mentions temporary and indefinite insanity", () => {
    expect(sanityFeature.planningPrompt).toContain("temporary insanity");
    expect(sanityFeature.planningPrompt).toContain("indefinite insanity");
  });

  it("stateDescription returns empty string when no insanity active", () => {
    // No sanity states set at all
    const result = sanityFeature.stateDescription(dgsm as any);
    expect(result).toBe("");
  });

  it("stateDescription returns empty string when character has state but no active insanity", () => {
    const charState = createEmptySanityState();
    setSanityState(dgsm as any, "npc-test", charState);

    const result = sanityFeature.stateDescription(dgsm as any);
    expect(result).toBe("");
  });

  it("stateDescription reports active insanity", () => {
    const charState = createEmptySanityState();
    charState.activeInsanity = {
      insanityType: "temporary",
      boutType: "flee",
      description: "Primal terror takes over",
      actionRestriction: "flee_only",
      startMinutes: 480,
      durationMinutes: 120,
      isActive: true,
    };
    setSanityState(dgsm as any, "npc-test", charState);

    const result = sanityFeature.stateDescription(dgsm as any);
    expect(result).toContain("Mental state:");
    expect(result).toContain("npc-test");
    expect(result).toContain("temporary insanity (flee)");
    expect(result).toContain("restriction:flee_only");
  });

  it("stateDescription does not report inactive insanity (pending onset)", () => {
    const charState = createEmptySanityState();
    charState.activeInsanity = {
      insanityType: "indefinite",
      boutType: "paranoia",
      description: "Trust collapses",
      actionRestriction: "impaired",
      startMinutes: 480,
      durationMinutes: 1440,
      isActive: false,
      onsetDelayMinutes: 120,
    };
    setSanityState(dgsm as any, "npc-test", charState);

    const result = sanityFeature.stateDescription(dgsm as any);
    // Should not report the insanity line because isActive=false
    expect(result).not.toContain("indefinite insanity");
  });

  it("stateDescription reports persistent conditions", () => {
    const charState = createEmptySanityState();
    charState.persistentConditions.push({
      type: "phobia",
      subject: "spiders",
      description: "A deep irrational fear of spiders",
    });
    charState.persistentConditions.push({
      type: "mania",
      subject: "fire",
      description: "An obsessive compulsion with fire",
    });
    setSanityState(dgsm as any, "npc-test", charState);

    const result = sanityFeature.stateDescription(dgsm as any);
    expect(result).toContain("Mental state:");
    expect(result).toContain("npc-test: phobia — spiders");
    expect(result).toContain("npc-test: mania — fire");
  });

  it("tick cleans up expired temporary insanity", () => {
    // Set up temporary insanity starting at minute 0 (day 1, 00:00), duration 60
    const charState = createEmptySanityState();
    charState.activeInsanity = {
      insanityType: "temporary",
      boutType: "flee",
      description: "Primal terror takes over",
      actionRestriction: "flee_only",
      startMinutes: 0,
      durationMinutes: 60,
      isActive: true,
    };
    setSanityState(dgsm as any, "npc-test", charState);

    // Add the insanity condition to the NPC
    const npc = dgsm.getState().npcCharacters.find((n) => n.id === "npc-test")!;
    npc.status.conditions = [
      "[Insanity:temporary] Flee in Panic | restriction:flee_only",
    ];

    // Tick at 02:00 (= 120 minutes, well past expiry at 60)
    const runtime = createMockRuntime({ tickTime: "02:00", gameDay: 1 });
    sanityFeature.tick!(dgsm as any, runtime);

    // Verify activeInsanity is cleared
    const updated = getSanityState(dgsm as any, "npc-test");
    expect(updated!.activeInsanity).toBeNull();

    // Verify condition removed
    expect(npc.status.conditions).not.toContain(
      "[Insanity:temporary] Flee in Panic | restriction:flee_only"
    );
  });

  it("tick activates indefinite insanity after onset delay", () => {
    // Set up indefinite insanity: start at 480 (08:00 day 1), onset delay 120 min, isActive=false
    const charState = createEmptySanityState();
    charState.activeInsanity = {
      insanityType: "indefinite",
      boutType: "paranoia",
      description: "Trust collapses — everyone is a threat",
      actionRestriction: "impaired",
      startMinutes: 480,
      durationMinutes: 1440,
      isActive: false,
      onsetDelayMinutes: 120,
    };
    setSanityState(dgsm as any, "npc-test", charState);

    // Tick at 11:00 (= 660 minutes, past 480+120=600)
    const runtime = createMockRuntime({ tickTime: "11:00", gameDay: 1 });
    sanityFeature.tick!(dgsm as any, runtime);

    // Verify isActive is now true
    const updated = getSanityState(dgsm as any, "npc-test");
    expect(updated!.activeInsanity).not.toBeNull();
    expect(updated!.activeInsanity!.isActive).toBe(true);

    // Verify condition was injected
    const npc = dgsm.getState().npcCharacters.find((n) => n.id === "npc-test");
    expect(
      npc!.status.conditions.some((c: string) =>
        c.startsWith("[Insanity:indefinite]")
      )
    ).toBe(true);
  });

  it("tick cleans up old sanLossLog entries", () => {
    // Create state with entries at various times
    const charState = createEmptySanityState();
    charState.sanLossLog = [
      { amount: 2, gameTimeMinutes: 100 }, // old, should be removed (480 - 60 = 420 > 100)
      { amount: 3, gameTimeMinutes: 470 }, // recent enough, 470 >= 420
      { amount: 1, gameTimeMinutes: 479 }, // recent, 479 >= 420
    ];
    setSanityState(dgsm as any, "npc-test", charState);

    // Tick at 08:00 (= 480 minutes)
    const runtime = createMockRuntime({ tickTime: "08:00", gameDay: 1 });
    sanityFeature.tick!(dgsm as any, runtime);

    // Verify only entries >= 420 remain
    const updated = getSanityState(dgsm as any, "npc-test");
    expect(updated!.sanLossLog).toHaveLength(2);
    expect(updated!.sanLossLog.every((e) => e.gameTimeMinutes >= 420)).toBe(
      true
    );
  });

  it("tick does not remove persistent conditions when clearing active insanity", () => {
    // Set up temporary insanity starting at minute 0, duration 60
    const charState = createEmptySanityState();
    charState.activeInsanity = {
      insanityType: "temporary",
      boutType: "phobia",
      description: "A deep irrational fear takes root",
      actionRestriction: "impaired",
      startMinutes: 0,
      durationMinutes: 60,
      isActive: true,
    };
    charState.persistentConditions.push({
      type: "phobia",
      subject: "darkness",
      description: "A deep irrational fear of darkness",
    });
    setSanityState(dgsm as any, "npc-test", charState);

    // Set up conditions: both temporary and persistent
    const npc = dgsm.getState().npcCharacters.find((n) => n.id === "npc-test")!;
    npc.status.conditions = [
      "[Insanity:temporary] Phobia | restriction:impaired",
      "[Insanity:phobia] Phobia (darkness) | persistent",
    ];

    // Tick at 02:00 (= 120 min, past expiry at 60)
    const runtime = createMockRuntime({ tickTime: "02:00", gameDay: 1 });
    sanityFeature.tick!(dgsm as any, runtime);

    // Active insanity should be cleared
    const updated = getSanityState(dgsm as any, "npc-test");
    expect(updated!.activeInsanity).toBeNull();

    // Persistent condition should remain in conditions array
    expect(npc.status.conditions).toContain(
      "[Insanity:phobia] Phobia (darkness) | persistent"
    );

    // Temporary condition should be gone
    expect(npc.status.conditions).not.toContain(
      "[Insanity:temporary] Phobia | restriction:impaired"
    );

    // Persistent conditions in sanity state should remain
    expect(updated!.persistentConditions).toHaveLength(1);
    expect(updated!.persistentConditions[0].type).toBe("phobia");
    expect(updated!.persistentConditions[0].subject).toBe("darkness");
  });
});

// ===== generatePhobiaManiaSubject tests =====

describe("sanityFeature — generatePhobiaManiaSubject", () => {
  it("returns a non-empty string for phobia", async () => {
    const result = await generatePhobiaManiaSubject(
      "phobia",
      "a terrifying spider crawled across the wall",
      "tavern"
    );
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for mania", async () => {
    const result = await generatePhobiaManiaSubject(
      "mania",
      "obsessively lighting candles in the darkness",
      "chapel"
    );
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it("falls back to default when no keywords", async () => {
    // All words are 4 chars or fewer
    const phobiaResult = await generatePhobiaManiaSubject(
      "phobia",
      "the cat ran",
      "room"
    );
    expect(phobiaResult).toBe("the unknown");

    const maniaResult = await generatePhobiaManiaSubject(
      "mania",
      "he sat and ate",
      "room"
    );
    expect(maniaResult).toBe("repetitive behavior");
  });

  it("extracts keywords from trigger context", async () => {
    const result = await generatePhobiaManiaSubject(
      "phobia",
      "tentacles reaching through the portal",
      "dungeon"
    );
    // "tentacles" (9 chars) and "reaching" (8 chars) and "through" (7 chars) — first two
    expect(result).toContain("tentacles");
  });
});
