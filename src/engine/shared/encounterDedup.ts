import type { DynamicGameStateManager } from "../../dynamicworldagent/state/DynamicGameState.js";
import type { CharacterPosition } from "../../dynamicworldagent/state/topologyTypes.js";
import { arePositionsCoLocated } from "./locationPresence.js";

export type EncounterSignature = string;

function normalizeNpcIds(npcIds: Iterable<string>): string[] {
  return [...new Set(npcIds)].sort();
}

export function buildEncounterSignature(
  locationId: string,
  npcIds: Iterable<string>
): EncounterSignature {
  return JSON.stringify([locationId, normalizeNpcIds(npcIds)]);
}

export function shouldEmitEncounter(
  locationId: string,
  npcIds: Iterable<string>,
  previousEncounterSignatures: ReadonlySet<EncounterSignature>
): boolean {
  const normalizedNpcIds = normalizeNpcIds(npcIds);
  if (normalizedNpcIds.length < 2) return false;
  return !previousEncounterSignatures.has(
    buildEncounterSignature(locationId, normalizedNpcIds)
  );
}

export function buildEncounterSnapshot(
  dgsm: DynamicGameStateManager
): Set<EncounterSignature> {
  const state = dgsm.getState();

  // Scene/junction: exact co-location, group by locationId
  const sceneJunctionGroups = new Map<string, string[]>();
  // Road: collect positions for per-NPC perspective grouping
  const roadGroups = new Map<string, Array<{ id: string; position: number }>>();

  for (const npc of state.npcCharacters) {
    if (!dgsm.isNpcAlive(npc.id)) continue;
    if (dgsm.isCharacterHidden(npc.id)) continue;

    const position = dgsm.getCharacterPosition(npc.id);
    if (!position) continue;

    if (position.type === "road") {
      const group = roadGroups.get(position.roadId) ?? [];
      group.push({ id: npc.id, position: position.position });
      roadGroups.set(position.roadId, group);
    } else {
      const locationId = dgsm.resolveLocationId(position);
      const group = sceneJunctionGroups.get(locationId) ?? [];
      group.push(npc.id);
      sceneJunctionGroups.set(locationId, group);
    }
  }

  const snapshot = new Set<EncounterSignature>();

  for (const [locationId, npcIds] of sceneJunctionGroups) {
    if (npcIds.length >= 2) {
      snapshot.add(buildEncounterSignature(locationId, npcIds));
    }
  }

  // Road: per-NPC perspective — one signature per NPC representing its co-located
  // neighborhood. This mirrors scanUnplannedEncounters exactly: the encounter group
  // for a given locationId is the union of arrived observers' neighborhoods, which
  // equals one observer's neighborhood when only that observer moves. Storing each
  // NPC's own view ensures every possible sub-group is covered regardless of who
  // moves next tick. The Set deduplicates symmetric pairs (A sees B ≡ B sees A).
  for (const [roadId, npcs] of roadGroups) {
    for (const npc of npcs) {
      const npcPos: CharacterPosition = {
        type: "road",
        roadId,
        position: npc.position,
      };
      const coLocated = npcs
        .filter((other) => {
          if (other.id === npc.id) return false;
          const otherPos: CharacterPosition = {
            type: "road",
            roadId,
            position: other.position,
          };
          return arePositionsCoLocated(npcPos, otherPos, dgsm);
        })
        .map((other) => other.id);
      if (coLocated.length === 0) continue;
      snapshot.add(buildEncounterSignature(roadId, [npc.id, ...coLocated]));
    }
  }

  return snapshot;
}
