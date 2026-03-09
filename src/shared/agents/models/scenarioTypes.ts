/**
 * Scenario Type Definitions
 * Data structures for scenario management
 */

/**
 * Clue available in a scenario
 */
export interface ScenarioClue {
  id: string;
  /** The clue text or description */
  clueText: string;
  /** Category of clue */
  category:
    | "physical"
    | "witness"
    | "document"
    | "environment"
    | "knowledge"
    | "observation";
  /** How obvious/difficult to find */
  difficulty: "automatic" | "regular" | "hard" | "extreme";
  /** Location where this clue can be found */
  location: string;
  /** Required skill or method to discover */
  discoveryMethod?: string;
  /** What this clue reveals or points to */
  reveals?: string[];
  /** Whether this clue has been discovered */
  discovered: boolean;
  /** Who discovered it and when */
  discoveryDetails?: {
    discoveredBy: string;
    discoveredAt: string;
    method: string;
  };
  /** Whether this clue has been permanently damaged/destroyed and can no longer be revealed */
  damaged?: boolean;
  /** Who damaged it and when */
  damageDetails?: {
    damagedBy: string;
    damagedAt: string;
    reason: string;
  };
}

/**
 * Environmental condition or atmospheric detail.
 * mechanicalEffect follows the tick-processor SceneCondition format:
 *   { skillPenalty?: Array<{ skill: string; delta: number }>; blocked?: boolean }
 */
export interface ScenarioCondition {
  /** Type of condition (weather, lighting, sound, smell, etc.) */
  type: "weather" | "lighting" | "sound" | "smell" | "temperature" | "other";
  /** Description of the condition */
  description: string;
  /** Structured mechanical effect consumed by the tick processor */
  mechanicalEffect?: {
    skillPenalty?: Array<{ skill: string; delta: number }>;
    blocked?: boolean;
  };
}

