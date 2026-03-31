import { t } from "../../i18n/t.js";
import type { CharacterAction } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { shouldEmitEncounter } from "../shared/encounterDedup.js";
import { arePositionsCoLocated } from "../shared/locationPresence.js";
import { tryDetectHidden } from "./movementTick.js";

export function personalizeEncounterForNpc(
  event: CharacterAction,
  npcId: string,
  allTickActions: CharacterAction[],
  state: { npcCharacters: Array<{ id: string; name: string }> },
  dgsm: DynamicGameStateManager,
  lang: string
): CharacterAction | null {
  if (event.characterId !== "__encounter__") return event;
  if (!event.targetCharacterIds) return event;

  const alreadyInteracted = new Set<string>();
  for (const action of allTickActions) {
    if (
      action.type === "character_interaction" &&
      action.status === "completed"
    ) {
      if (action.characterId === npcId) {
        for (const targetId of action.targetCharacterIds ?? []) {
          alreadyInteracted.add(targetId);
        }
      }
      if (action.targetCharacterIds?.includes(npcId)) {
        alreadyInteracted.add(action.characterId);
      }
    }
  }

  const relevantIds = event.targetCharacterIds.filter(
    (id) => id !== npcId && !alreadyInteracted.has(id)
  );
  if (relevantIds.length === 0) return null;

  const relevantNames = relevantIds.map((id) => {
    const npc = state.npcCharacters.find((n) => n.id === id);
    const name = npc?.name ?? id;
    return dgsm.isNpcAlive(id) ? name : `${name} (dead)`;
  });
  const sceneName = dgsm.getScene(event.location)?.name ?? event.location;

  return {
    ...event,
    outcome: t("npcs_are_at", lang, {
      names: relevantNames.join(", "),
      scene: sceneName,
    }),
  };
}

export function scanUnplannedEncounters(params: {
  dgsm: DynamicGameStateManager;
  tickTime: string;
  tickActions: CharacterAction[];
  movedNpcIds: ReadonlySet<string>;
  previousEncounterSignatures: ReadonlySet<string>;
  lang: string;
}): CharacterAction[] {
  const {
    dgsm,
    tickTime,
    tickActions,
    movedNpcIds,
    previousEncounterSignatures,
    lang,
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
  for (const action of tickActions) {
    if (action.type === "movement" && action.status === "completed") {
      arrivedNpcIds.add(action.characterId);
    }
  }

  const interactedPairs = new Set<string>();
  for (const action of tickActions) {
    if (
      action.type === "character_interaction" &&
      action.targetCharacterIds?.length
    ) {
      for (const targetId of action.targetCharacterIds) {
        const pairKey = [action.characterId, targetId].sort().join("_");
        interactedPairs.add(pairKey);
      }
    }
  }

  const encounterEvents: CharacterAction[] = [];

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
    encounterEvents.push({
      characterId: "__encounter__",
      characterName: t("co_presence_name", lang),
      gameTime: tickTime,
      action: t("npcs_present_at", lang, { scene: sceneName }),
      location: locationId,
      type: "character_interaction",
      impact: 2 as const,
      status: "completed",
      outcome: t("npcs_are_at", lang, {
        names: allNpcNames.join(", "),
        scene: sceneName,
      }),
      targetCharacterIds: [...allNpcIds],
    });
  }

  return encounterEvents;
}
