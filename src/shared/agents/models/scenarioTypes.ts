/**
 * Scenario Type Definitions
 * Data structures for scenario management (single snapshot per scenario, no timeline)
 */

/**
 * Character presence in a scenario
 */
export interface ScenarioCharacter {
  /** Character ID or name */
  id: string;
  name: string;
  /** Role in this scenario (protagonist, witness, victim, etc.) */
  role: string;
  /** Character's status at this time (alive, missing, unconscious, etc.) */
  status: string;
  /** Current location */
  location?: string;
  /** Notes about character in this scenario */
  notes?: string;
}

/**
 * Clue available in a scenario
 */
export interface ScenarioClue {
  id: string;
  /** The clue text or description */
  clueText: string;
  /** Category of clue */
  category: "physical" | "witness" | "document" | "environment" | "knowledge" | "observation";
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
}

/**
 * Environmental condition or atmospheric detail
 */
export interface ScenarioCondition {
  /** Type of condition (weather, lighting, sound, smell, etc.) */
  type: "weather" | "lighting" | "sound" | "smell" | "temperature" | "other";
  /** Description of the condition */
  description: string;
  /** Mechanical effect if any */
  mechanicalEffect?: string;
}

/**
 * Scenario snapshot - represents the current state of a scenario
 */
export interface ScenarioSnapshot {
  id: string;
  /** Scenario name */
  name: string;
  /** Narrative game time for this snapshot (e.g., "Day 1, 08:00") */
  gameTime?: string;
  /** Primary location */
  location: string;
  /** Detailed description */
  description: string;
  /** Whether the map should be shown for this scene */
  showMap?: boolean;
  /** Module-relative path to map image (inherited from parent ScenarioProfile) */
  mapImagePath?: string;
  /** Characters present */
  characters: ScenarioCharacter[];
  /** Available clues */
  clues: ScenarioClue[];
  /** Environmental conditions */
  conditions: ScenarioCondition[];
  /** Notable events */
  events: string[];
  /** Exits and connections to other locations */
  exits?: {
    direction: string;
    destination: string;
    description?: string;
    condition?: string; // e.g., "locked", "hidden"
  }[];
  /** Keeper notes */
  keeperNotes?: string;
  /** Estimated short actions the scene can accommodate (runtime-only, set by Director) */
  estimatedShortActions?: number;
  /** Time restriction for this snapshot (e.g., "day1 evening", "day2 (after)") - optional */
  timeRestriction?: string;
  /** Whether this is the initial snapshot for the starting scene */
  initialSnapshot?: boolean;
  /** Permanent changes applied to this scenario (persisted across scene switches) */
  permanentChanges?: string[];
}

/**
 * Complete scenario profile (single snapshot, no timeline)
 */
export interface ScenarioProfile {
  id: string;
  /** Overall scenario name */
  name: string;
  /** Overall description */
  description: string;
  /** Current scenario snapshot */
  snapshot: ScenarioSnapshot;
  /** Module-relative path to map image (e.g., "Cassandra's_Scenarios/map/Adolph's House.jpg") */
  mapImagePath?: string;
  /** Scenario tags for organization */
  tags: string[];
  /** Related scenarios */
  connections?: {
    scenarioId: string;
    relationshipType: "leads_to" | "concurrent" | "prerequisite" | "alternate";
    description?: string;
  }[];
  /** Scenario metadata */
  metadata: {
    createdAt: string;
    updatedAt: string;
    source?: string; // document filename
    author?: string;
    gameSystem: string; // "CoC 7e"
  };
}

/**
 * Raw parsed scenario snapshot data from documents
 */
export interface ParsedScenarioSnapshot {
  name?: string;
  gameTime?: string;
  location: string;
  description: string;
  timeRestriction?: string;
  showMap?: boolean;
  characters?: {
    name: string;
    role?: string;
    status?: string;
    location?: string;
    notes?: string;
  }[];
  clues?: {
    clueText: string;
    category?: string;
    difficulty?: string;
    location?: string;
    discoveryMethod?: string;
    reveals?: string[];
  }[];
  conditions?: {
    type?: string;
    description: string;
    mechanicalEffect?: string;
  }[];
  events?: string[];
  exits?: {
    direction: string;
    destination: string;
    description?: string;
    condition?: string;
  }[];
  keeperNotes?: string;
  /** Permanent changes applied to this scenario */
  permanentChanges?: string[];
}

/**
 * Raw parsed scenario data from documents
 * Supports both single snapshot and multiple snapshots
 */
export interface ParsedScenarioData {
  name: string;
  description: string;
  /** Module-relative path to map image (optional, discovered during loading) */
  mapImagePath?: string;
  /** Single snapshot (legacy format) */
  snapshot?: ParsedScenarioSnapshot;
  /** Multiple snapshots (new format) */
  snapshots?: ParsedScenarioSnapshot[];
  tags?: string[];
  connections?: {
    scenarioName: string;
    relationshipType: string;
    description?: string;
  }[];
}

/**
 * Scenario search query
 */
export interface ScenarioQuery {
  name?: string;
  location?: string;
  charactersInvolved?: string[];
  tags?: string[];
  hasClues?: boolean;
}

/**
 * Scenario search result
 */
export interface ScenarioSearchResult {
  scenarios: ScenarioProfile[];
  totalCount: number;
  relevanceScores?: number[];
}
