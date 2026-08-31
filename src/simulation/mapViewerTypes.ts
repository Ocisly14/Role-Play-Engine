import type { SceneCondition } from "../engine/core/types.js";
import type { Item, SceneConnection } from "../state/types.js";

export interface MapLayout {
  junctions: Record<string, { x: number; y: number }>;
}

export interface NpcStatusInfo {
  npcId: string;
  name: string;
  hp: number;
  maxHp: number;
  san: number;
  maxSan: number;
  currentAction: string | null;
  location: string;
  inventory: Item[];
  isAlive: boolean;
  // Profile fields
  occupation?: string;
  age?: number;
  gender?: string;
  appearance?: string;
  personality?: string;
  background?: string;
  backstory?: string;
  residence?: string;
  longTermIntent?: string;
}

export interface TopologyResponse {
  /** Geography nodes (top-level scenes). Field name kept for viewer compat. */
  junctions: Array<{
    id: string;
    name: string;
    parentLocationId: string;
    connectedSceneIds: string[];
  }>;
  roads: Array<{
    id: string;
    name: string;
    parentLocationId?: string;
    endpointA: string;
    endpointB: string;
    travelTimeMinutes: number;
    alongConnections: Array<{ sceneId: string; position: number }>;
  }>;
  scenes: Array<{
    id: string;
    name: string;
    description: string;
    parentLocationId?: string;
    conditions: SceneCondition[];
    connections: SceneConnection[];
  }>;
  /** Viewer-only building groups, derived from parentLocationId labels. */
  scenarioOutlines: Array<{
    id: string;
    name: string;
    description: string;
    entrySceneId?: string;
    residents?: string[];
    subSceneCount: number;
  }>;
  transportEdges: Array<{
    fromLocationId: string;
    toLocationId: string;
    streetSceneId: string;
    travelTimeMinutes: number;
  }>;
}
