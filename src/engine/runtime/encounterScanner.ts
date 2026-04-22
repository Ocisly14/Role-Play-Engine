import type { FeatureEvent } from "../../engine/core/types.js";
import { t } from "../../i18n/t.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  buildEncounterSignature,
  shouldEmitEncounter,
} from "../shared/encounterDedup.js";
import { arePositionsCoLocated } from "../shared/locationPresence.js";
import { tryDetectHidden } from "./movementTick.js";

export function scanUnplannedEncounters(params: {
  dgsm: DynamicGameStateManager;
  tickTime: string;
  movedNpcIds: ReadonlySet<string>;
  previousEncounterSignatures: ReadonlySet<string>;
  lang: string;
  interactedPairs?: ReadonlySet<string>;
}): Array<{ event: FeatureEvent; signature: string }> {
  const {
    dgsm,
    movedNpcIds,
    previousEncounterSignatures,
    lang,
    interactedPairs: interactedPairsParam,
  } = params;
  const state = dgsm.getState();
  const aliveNpcs = state.npcCharacters.filter((npc) =>
    dgsm.isNpcAlive(npc.id)
  );
  const presentNpcs = state.npcCharacters.filter((npc) =>
    Boolean(dgsm.getCharacterPosition(npc.id))
  );
  const formatPresenceLabel = (npcId: string): string => {
    const npc = state.npcCharacters.find((candidate) => candidate.id === npcId);
    const name = npc?.name ?? npcId;
    return dgsm.isNpcAlive(npcId) ? name : `${name} (dead)`;
  };
  const positionByNpc = new Map(
    presentNpcs.map((npc) => [npc.id, dgsm.getCharacterPosition(npc.id)])
  );

  const arrivedNpcIds = new Set<string>(movedNpcIds);
  const interactedPairs = interactedPairsParam ?? new Set<string>();

  const encounterEvents: Array<{ event: FeatureEvent; signature: string }> = [];

  for (const arrivedNpc of aliveNpcs) {
    if (!arrivedNpcIds.has(arrivedNpc.id)) continue;
    if (!dgsm.isCharacterHidden(arrivedNpc.id)) continue;

    const arrivedPos = positionByNpc.get(arrivedNpc.id) ?? null;
    for (const resident of aliveNpcs) {
      if (resident.id === arrivedNpc.id) continue;
      if (dgsm.isCharacterHidden(resident.id)) continue;
      const residentPos = positionByNpc.get(resident.id) ?? null;
      if (!arePositionsCoLocated(arrivedPos, residentPos, dgsm)) continue;

      if (tryDetectHidden(dgsm, resident.id, arrivedNpc.id)) {
        dgsm.setCharacterHidden(arrivedNpc.id, false);
        break;
      }
    }
  }

  const locationEncounterMaps = new Map<string, Map<string, string[]>>();
  for (const observer of aliveNpcs) {
    if (!arrivedNpcIds.has(observer.id)) continue;

    const observerPos = positionByNpc.get(observer.id) ?? null;
    const locationId = observerPos
      ? dgsm.resolveLocationId(observerPos)
      : undefined;
    if (!locationId) continue;

    for (const other of presentNpcs) {
      if (other.id === observer.id) continue;
      if (dgsm.isCharacterHidden(other.id)) {
        if (!tryDetectHidden(dgsm, observer.id, other.id)) continue;
        dgsm.setCharacterHidden(other.id, false);
      }

      const pairKey = [observer.id, other.id].sort().join("_");
      if (interactedPairs.has(pairKey)) continue;

      const otherPos = positionByNpc.get(other.id) ?? null;
      if (!arePositionsCoLocated(observerPos, otherPos, dgsm)) continue;

      let npcEncounterMap = locationEncounterMaps.get(locationId);
      if (!npcEncounterMap) {
        npcEncounterMap = new Map<string, string[]>();
        locationEncounterMaps.set(locationId, npcEncounterMap);
      }

      const encounteredNpcIds = npcEncounterMap.get(observer.id) ?? [];
      encounteredNpcIds.push(other.id);
      npcEncounterMap.set(observer.id, encounteredNpcIds);
    }
  }

  for (const [locationId, npcEncounterMap] of locationEncounterMaps) {
    if (npcEncounterMap.size === 0) continue;

    const sceneName = dgsm.getScene(locationId)?.name ?? locationId;
    const allNpcIds = new Set<string>();
    for (const [observerId, otherIds] of npcEncounterMap) {
      if (!dgsm.isCharacterHidden(observerId)) allNpcIds.add(observerId);
      for (const otherId of otherIds) {
        if (!dgsm.isCharacterHidden(otherId)) allNpcIds.add(otherId);
      }
    }
    if (
      !shouldEmitEncounter(locationId, allNpcIds, previousEncounterSignatures)
    ) {
      continue;
    }

    const allNpcNames = [...allNpcIds].map((id) => formatPresenceLabel(id));
    const signature = buildEncounterSignature(locationId, allNpcIds);
    encounterEvents.push({
      event: {
        type: "encounter.detected",
        sceneId: locationId,
        data: {
          observedNpcIds: [...allNpcIds],
          description: t("npcs_are_at", lang, {
            names: allNpcNames.join(", "),
            scene: sceneName,
          }),
        },
      },
      signature,
    });
  }

  return encounterEvents;
}
