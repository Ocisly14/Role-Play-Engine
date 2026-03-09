import type { WorldFeature, WorldFeatureResult, TickRuntimeContext } from "../types.js";
import type { PlanNode, CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { TransportEdge } from "../../world_builder/types.js";

// ==================== Scene-graph helpers ====================

const NEIGHBORHOOD_TRAVEL_MINUTES = 15;

function findNeighborMacroLocations(
  fromLocationId: string,
  transportEdges: TransportEdge[],
  maxTravelMinutes: number
): string[] {
  const visited = new Map<string, number>();
  visited.set(fromLocationId, 0);
  const queue: Array<{ locationId: string; travelTime: number }> = [
    { locationId: fromLocationId, travelTime: 0 },
  ];
  while (queue.length > 0) {
    const { locationId, travelTime } = queue.shift()!;
    for (const edge of transportEdges) {
      let neighbor: string | null = null;
      if (edge.fromLocationId === locationId) neighbor = edge.toLocationId;
      else if (edge.toLocationId === locationId) neighbor = edge.fromLocationId;
      if (!neighbor) continue;
      const newTime = travelTime + edge.travelTimeMinutes;
      if (newTime > maxTravelMinutes) continue;
      if (visited.has(neighbor) && visited.get(neighbor)! <= newTime) continue;
      visited.set(neighbor, newTime);
      queue.push({ locationId: neighbor, travelTime: newTime });
    }
  }
  visited.delete(fromLocationId);
  return [...visited.keys()];
}

function getParentLocationId(
  sceneId: string,
  dgsm: DynamicGameStateManager
): string | null {
  const scene = dgsm.getScene(sceneId);
  return scene?.parentLocationId ?? null;
}

// ==================== ImpactGateFeature ====================

/**
 * ImpactGateFeature — propagates high-impact actions to nearby characters.
 *
 * After each 5-minute bucket, scans for actions with impact > 0 and notifies
 * characters within range based on impact level:
 *   1 = targeted character only
 *   2 = same sub-scene
 *   3 = same macro-location (building)
 *   4 = neighborhood (<=15 min travel)
 *   5 = global
 *
 * Notified NPCs may revise their plans. Player events are returned for
 * potential interrupt handling.
 */
export class ImpactGateFeature implements WorldFeature {
  id = "impact_gate";
  conditionTypes: string[] = [];
  description = "Impact propagation: high-impact actions alert nearby NPCs who may revise plans";

  planningPrompt = `## Impact Levels

The \`impact\` field on every PlanNode determines **who in the game world perceives and reacts to** the action. The tick engine propagates events outward based on this level:

- **0 — Private / unnoticed**: Only the acting character knows. No one else perceives or reacts.
  Examples: thinking, reading alone, checking belongings, observing from afar, writing notes, resting
- **1 — Targeted / one-on-one**: Only the specific target character perceives it. A private exchange.
  Examples: whispering, passing a note, pickpocketing someone, private conversation, discreet item handoff
- **2 — Sub-scene / room-wide**: Everyone in the current room or sub-scene perceives it. Visible/audible to bystanders.
  Examples: speaking loudly, firing a gun, breaking a door, starting a fight, searching a room openly, screaming
- **3 — Building / macro-location-wide**: Everyone in the same building or macro location perceives it (all rooms/floors).
  Examples: fire alarm, shouting down a stairwell, smoke filling the building, event audible throughout
- **4 — Neighborhood**: Perceived at the current building and nearby buildings within walking distance.
  Examples: explosion heard across the block, gunshot echoing, building collapse, large fire
- **5 — Global / far-reaching**: The entire game world is affected. Consequences ripple everywhere.
  Examples: triggering a town alarm, summoning ritual, radio broadcast, earthquake

**Required field:** \`"impact": 0|1|2|3|4|5\` on every PlanNode.`;

  onTickStart(_dgsm: DynamicGameStateManager, _runtime: TickRuntimeContext): void {}

  async onBucketEnd(
    bucketActions: CharacterAction[],
    dgsm: DynamicGameStateManager,
    bucketTime: string,
    runtime: TickRuntimeContext
  ): Promise<WorldFeatureResult> {
    const impactEvents = bucketActions.filter((a) => a.impact > 0);
    if (impactEvents.length === 0) return {};

    const state = dgsm.getState();
    const { sessionId, gameDay, language, npcPlanning } = runtime;

    const characterEventsMap = new Map<string, Array<{ event: CharacterAction; impact: number }>>();
    const playerScene = state.currentSceneId;
    const playerId = state.playerCharacter?.id;

    const addEventForCharacter = (charId: string, event: CharacterAction, impact: number) => {
      if (charId === event.characterId) return;
      if (!characterEventsMap.has(charId)) characterEventsMap.set(charId, []);
      const existing = characterEventsMap.get(charId)!;
      const idx = existing.findIndex((e) => e.event === event);
      if (idx >= 0) {
        if (impact > existing[idx].impact) existing[idx].impact = impact;
      } else {
        existing.push({ event, impact });
      }
    };

    const allCharacterIds = [
      ...state.npcCharacters.map((n) => n.id),
      ...(playerId ? [playerId] : []),
    ];

    const getCharLocation = (charId: string): string | undefined => {
      if (charId === playerId) return playerScene ?? undefined;
      return dgsm.getNpcLocation(charId);
    };

    for (const event of impactEvents) {
      // Level 1: targeted
      if (event.impact >= 1 && event.targetCharacterId) {
        addEventForCharacter(event.targetCharacterId, event, 1);
      }

      // Level 2: same sub-scene
      if (event.impact >= 2) {
        for (const charId of allCharacterIds) {
          if (getCharLocation(charId) === event.location) {
            addEventForCharacter(charId, event, 2);
          }
        }
      }

      // Level 3: same macro location (all sub-scenes in building)
      if (event.impact >= 3) {
        const eventParent = getParentLocationId(event.location, dgsm);
        if (eventParent) {
          for (const charId of allCharacterIds) {
            const charLoc = getCharLocation(charId);
            if (charLoc && getParentLocationId(charLoc, dgsm) === eventParent) {
              addEventForCharacter(charId, event, 3);
            }
          }
        }
      }

      // Level 4: neighborhood (<=15 min travel on transport network)
      if (event.impact >= 4) {
        const eventParent = getParentLocationId(event.location, dgsm);
        if (eventParent && state.transportEdges) {
          const neighbors = findNeighborMacroLocations(eventParent, state.transportEdges, NEIGHBORHOOD_TRAVEL_MINUTES);
          for (const charId of allCharacterIds) {
            const charLoc = getCharLocation(charId);
            if (charLoc) {
              const charParent = getParentLocationId(charLoc, dgsm);
              if (charParent && neighbors.includes(charParent)) {
                addEventForCharacter(charId, event, 4);
              }
            }
          }
        }
      }

      // Level 5: global
      if (event.impact >= 5) {
        for (const charId of allCharacterIds) {
          addEventForCharacter(charId, event, 5);
        }
      }
    }

    // Separate player from NPC candidates
    const playerEvents = playerId ? characterEventsMap.get(playerId) : undefined;
    if (playerId) characterEventsMap.delete(playerId);

    // NPC candidates -> one LLM call per NPC, all in parallel
    if (characterEventsMap.size > 0) {
      await Promise.all(
        [...characterEventsMap.entries()].map(async ([npcId, npcEvents]) => {
          const npc = state.npcCharacters.find((n) => n.id === npcId);
          const longTermIntent = await npcPlanning.getLongTermIntent(sessionId, npcId);
          const pendingNodes = await npcPlanning.getPendingNodes(sessionId, npcId, gameDay);
          const triggeringEvents = npcEvents
            .map((e) => `[impact ${e.impact}] ${e.event.characterName}: ${e.event.outcome}`)
            .join("\n");

          const result = await npcPlanning.runImpactGateForNpc(
            {
              npcId,
              npcName: npc?.name ?? npcId,
              currentLocation: dgsm.getNpcLocation(npcId) ?? "unknown",
              longTermIntent,
              pendingNodesSummary: pendingNodes.map((n) => `${n.gameTime} ${n.action}`).join("; "),
              triggeringEvents,
            },
            bucketTime,
            language
          );

          const logEntry = `Day${gameDay} ${bucketTime} [witness] - ${result.witnessEntry}`;
          const npcLoc = dgsm.getNpcLocation(npcId) ?? "unknown";
          await npcPlanning.appendMemoryLog(sessionId, npcId, logEntry, gameDay, bucketTime, npcLoc);

          if (result.shouldRevise) {
            const memoryLog = await npcPlanning.getMemoryLog(sessionId, npcId, gameDay);
            const sortedEvents = [...npcEvents].sort((a, b) => b.impact - a.impact);
            await npcPlanning.revisePlans(dgsm, sessionId, npcId, {
              longTermIntent,
              memoryLog,
              pendingNodes,
              trigger: {
                type: "impact",
                triggeringAction: sortedEvents[0].event,
              },
            }, language);
          }
        })
      );
    }

    return { playerEvents: playerEvents ?? undefined };
  }

  stateDescription(_dgsm: DynamicGameStateManager): string {
    return "";
  }
}
