import {
  DECAY_HALF_LIFE,
  IMPORTANCE_WEIGHT,
  RECENCY_WEIGHT,
  REINFORCEMENT_WEIGHT,
  SEMANTIC_WEIGHT,
} from "./types.js";

interface DecayInput {
  baseImportance: number;
  accessCount: number;
  lastAccessedAt: Date;
  decayRateMultiplier: number;
}

interface ScoreInput extends DecayInput {
  similarity: number;
}

export class DecayEngine {
  computeEffectiveImportance(input: DecayInput, now: Date): number {
    const hoursSinceAccess =
      (now.getTime() - input.lastAccessedAt.getTime()) / (1000 * 3600);
    const decayFactor = Math.exp(
      -hoursSinceAccess / (DECAY_HALF_LIFE * input.decayRateMultiplier)
    );
    const reinforcementBonus =
      Math.log2(1 + input.accessCount) * REINFORCEMENT_WEIGHT;
    return input.baseImportance * decayFactor + reinforcementBonus;
  }

  computeFinalScore(input: ScoreInput, now: Date): number {
    const hoursSinceAccess =
      (now.getTime() - input.lastAccessedAt.getTime()) / (1000 * 3600);
    const decayFactor = Math.exp(
      -hoursSinceAccess / (DECAY_HALF_LIFE * input.decayRateMultiplier)
    );
    const reinforcementBonus =
      Math.log2(1 + input.accessCount) * REINFORCEMENT_WEIGHT;
    const importanceScore = this.normalize(
      input.baseImportance * decayFactor + reinforcementBonus
    );

    return (
      SEMANTIC_WEIGHT * input.similarity +
      IMPORTANCE_WEIGHT * importanceScore +
      RECENCY_WEIGHT * decayFactor
    );
  }

  computeFinalScoreWithoutSemantic(input: DecayInput, now: Date): number {
    const hoursSinceAccess =
      (now.getTime() - input.lastAccessedAt.getTime()) / (1000 * 3600);
    const decayFactor = Math.exp(
      -hoursSinceAccess / (DECAY_HALF_LIFE * input.decayRateMultiplier)
    );
    const reinforcementBonus =
      Math.log2(1 + input.accessCount) * REINFORCEMENT_WEIGHT;
    const importanceScore = this.normalize(
      input.baseImportance * decayFactor + reinforcementBonus
    );

    return 0.6 * importanceScore + 0.4 * decayFactor;
  }

  private normalize(value: number): number {
    return Math.min(1.0, value / 5.0);
  }
}
