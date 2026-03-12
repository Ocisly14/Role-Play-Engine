/**
 * Scenario Type Definitions
 * Data structures for scenario management
 */

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

