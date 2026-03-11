import { describe, it, expect } from "vitest";
import { DecayEngine } from "../DecayEngine.js";

describe("DecayEngine", () => {
  const engine = new DecayEngine();

  describe("computeEffectiveImportance", () => {
    it("returns baseImportance when just created (0 hours elapsed)", () => {
      const now = new Date();
      const result = engine.computeEffectiveImportance({
        baseImportance: 2.0,
        accessCount: 0,
        lastAccessedAt: now,
        decayRateMultiplier: 1.0,
      }, now);
      expect(result).toBeCloseTo(2.0, 1);
    });

    it("decays over time", () => {
      const now = new Date();
      const hoursSinceAccess = 48;
      const lastAccessed = new Date(now.getTime() - hoursSinceAccess * 3600 * 1000);
      const result = engine.computeEffectiveImportance({
        baseImportance: 2.0,
        accessCount: 0,
        lastAccessedAt: lastAccessed,
        decayRateMultiplier: 1.0,
      }, now);
      expect(result).toBeLessThan(2.0);
      expect(result).toBeGreaterThan(0.5);
    });

    it("slow decay rate preserves importance longer", () => {
      const now = new Date();
      const hoursSinceAccess = 48;
      const lastAccessed = new Date(now.getTime() - hoursSinceAccess * 3600 * 1000);
      const standard = engine.computeEffectiveImportance({
        baseImportance: 2.0, accessCount: 0,
        lastAccessedAt: lastAccessed, decayRateMultiplier: 1.0,
      }, now);
      const slow = engine.computeEffectiveImportance({
        baseImportance: 2.0, accessCount: 0,
        lastAccessedAt: lastAccessed, decayRateMultiplier: 2.0,
      }, now);
      expect(slow).toBeGreaterThan(standard);
    });

    it("reinforcement bonus increases with access count", () => {
      const now = new Date();
      const noAccess = engine.computeEffectiveImportance({
        baseImportance: 1.0, accessCount: 0,
        lastAccessedAt: now, decayRateMultiplier: 1.0,
      }, now);
      const manyAccess = engine.computeEffectiveImportance({
        baseImportance: 1.0, accessCount: 10,
        lastAccessedAt: now, decayRateMultiplier: 1.0,
      }, now);
      expect(manyAccess).toBeGreaterThan(noAccess);
    });
  });

  describe("computeFinalScore", () => {
    it("combines semantic, importance, and recency scores", () => {
      const now = new Date();
      const score = engine.computeFinalScore({
        similarity: 0.8,
        baseImportance: 2.0,
        accessCount: 3,
        lastAccessedAt: now,
        decayRateMultiplier: 1.0,
      }, now);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it("higher similarity yields higher score", () => {
      const now = new Date();
      const params = {
        baseImportance: 1.0, accessCount: 0,
        lastAccessedAt: now, decayRateMultiplier: 1.0,
      };
      const low = engine.computeFinalScore({ ...params, similarity: 0.2 }, now);
      const high = engine.computeFinalScore({ ...params, similarity: 0.9 }, now);
      expect(high).toBeGreaterThan(low);
    });
  });

  describe("computeFinalScoreWithoutSemantic", () => {
    it("uses only importance and recency when no query", () => {
      const now = new Date();
      const score = engine.computeFinalScoreWithoutSemantic({
        baseImportance: 2.0,
        accessCount: 5,
        lastAccessedAt: now,
        decayRateMultiplier: 1.0,
      }, now);
      expect(score).toBeGreaterThan(0);
    });
  });
});
