import type { Item } from "../state/types.js";

export interface MapLayout {
  junctions: Record<string, { x: number; y: number }>;
}

export interface NpcStatusInfo {
  npcId: string;
  name: string;
  hp: number;
  maxHp: number;
  sanity: number;
  maxSanity: number;
  currentAction: string | null;
  location: string;
  inventory: Item[];
  isAlive: boolean;
}

export interface TopologyResponse {
  junctions: Array<{
    id: string;
    name: string;
    parentLocationId: string;
    connectedSceneIds: string[];
  }>;
  roads: Array<{
    id: string;
    name: string;
    parentLocationId: string;
    endpointA: string;
    endpointB: string;
    travelTimeMinutes: number;
    alongConnections: Array<{ sceneId: string; position: number }>;
  }>;
  scenes: Array<{
    id: string;
    name: string;
    parentLocationId: string;
    connections: string[];
  }>;
  scenarioOutlines: Array<{
    id: string;
    name: string;
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
