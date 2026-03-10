import type { WorldFeature, WorldFeatureResult, TickRuntimeContext } from "../types.js";
import type { CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { findAffectedCharacters } from "../shared/impactPropagation.js";

/**
 * ImpactGateFeature — propagates high-impact actions to nearby characters.
 *
 * After each tick, scans for actions with impact > 0 and notifies
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
  description = "Impact propagation: high-impact actions alert nearby NPCs who may revise plans";
  tickInterval = 1;
  impactScope = "dynamic" as const;
  planningPrompt = "";  // Impact levels described by engine, not this feature

  stateDescription(_dgsm: DynamicGameStateManager): string {
    return "";
  }

  async onTickEnd(
    tickActions: CharacterAction[],
    dgsm: DynamicGameStateManager,
    runtime: TickRuntimeContext
  ): Promise<WorldFeatureResult> {
    const impactEvents = tickActions.filter((a) => a.impact > 0);
    if (impactEvents.length === 0) return {};

    const state = dgsm.getState();
    const { sessionId, gameDay, language, tickTime, npcPlanning } = runtime;
    const playerId = state.playerCharacter?.id;

    // Aggregate affected characters across all impact events
    const characterEventsMap = new Map<string, Array<{ event: CharacterAction; impact: number }>>();

    for (const event of impactEvents) {
      const affected = findAffectedCharacters(event, event.impact, dgsm);
      for (const [charId, level] of affected) {
        if (!characterEventsMap.has(charId)) characterEventsMap.set(charId, []);
        const existing = characterEventsMap.get(charId)!;
        const idx = existing.findIndex((e) => e.event === event);
        if (idx >= 0) {
          if (level > existing[idx].impact) existing[idx].impact = level;
        } else {
          existing.push({ event, impact: level });
        }
      }
    }

    // Separate player events
    const playerEvents = playerId ? characterEventsMap.get(playerId) : undefined;
    if (playerId) characterEventsMap.delete(playerId);

    // NPC processing — parallel LLM calls
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
            tickTime,
            language
          );

          const logEntry = `Day${gameDay} ${tickTime} [witness] - ${result.witnessEntry}`;
          const npcLoc = dgsm.getNpcLocation(npcId) ?? "unknown";
          await npcPlanning.appendMemoryLog(sessionId, npcId, logEntry, gameDay, tickTime, npcLoc);

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
}
