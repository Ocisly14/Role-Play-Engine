/**
 * NPC AI decision module for impact reactions.
 *
 * Extracted from impactPipeline — this is the "re-decision" side:
 * deciding how an NPC should react to perceived events.
 * The "interruption" side stays in the engine.
 */

import type { GameEngineRegistry } from "../../engine/registry.js";
import type { NpcPlanningCapability } from "../../engine/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";

export interface ImpactReactionDecision {
  shouldUpdateIntent: boolean;
  updatedIntent?: string;
  shouldInterruptCurrentNode: boolean;
  shouldReviseSchedule: boolean;
  witnessEntry: string;
}

/**
 * Ask the NPC AI (via LLM) to decide how to react to perceived events.
 * This is the "intelligence" side — the NPC decides whether to update intent,
 * interrupt, or revise its schedule.
 */
export async function decideNpcReaction(params: {
  npcId: string;
  npcName: string;
  currentLocation: string;
  triggeringEvents: string;
  tickTime: string;
  language: string;
  moduleBackground: string;
  npcPlanningAgent: NpcPlanningCapability;
  sessionId: string;
  gameDay: number;
  memoryContext?: string;
}): Promise<ImpactReactionDecision> {
  const {
    npcId,
    npcName,
    currentLocation,
    triggeringEvents,
    tickTime,
    language,
    moduleBackground,
    npcPlanningAgent,
    sessionId,
    gameDay,
    memoryContext,
  } = params;

  const longTermIntent = await npcPlanningAgent.getLongTermIntent(
    sessionId,
    npcId
  );
  const shortTermIntent = await npcPlanningAgent.getShortTermIntent(
    sessionId,
    npcId
  );
  const pendingNodes = await npcPlanningAgent.getPendingNodes(
    sessionId,
    npcId,
    gameDay
  );
  const plan = await npcPlanningAgent.getDailyPlan(sessionId, npcId, gameDay);
  const schedule =
    (plan?.schedule as unknown as Array<{
      location: string;
      activity: string;
    }>) ?? [];

  const result = await npcPlanningAgent.runImpactGateForNpc(
    {
      npcId,
      npcName,
      currentLocation,
      longTermIntent,
      shortTermIntent: shortTermIntent ?? undefined,
      todayScheduleSummary: schedule
        .map((entry) => `${entry.location}: ${entry.activity}`)
        .join("; "),
      currentDetailedPlan: pendingNodes
        .map((node) => `${node.startTime}-${node.endTime} ${node.action}`)
        .join("; "),
      triggeringEvents,
      memoryContext,
    },
    tickTime,
    language,
    moduleBackground
  );

  return result;
}

/**
 * Apply the NPC's reaction decision: update intent and/or revise schedule.
 * This does NOT handle interruption — that's an engine mechanism.
 */
export async function applyNpcReactionDecision(params: {
  decision: ImpactReactionDecision;
  npcId: string;
  sessionId: string;
  triggerDescription: string;
  npcPlanningAgent: NpcPlanningCapability;
  dgsm?: DynamicGameStateManager;
  language: string;
  registry?: GameEngineRegistry;
}): Promise<void> {
  const {
    decision,
    npcId,
    sessionId,
    triggerDescription,
    npcPlanningAgent,
    dgsm,
    language,
    registry,
  } = params;

  if (decision.shouldUpdateIntent && decision.updatedIntent) {
    await npcPlanningAgent.setShortTermIntent(
      sessionId,
      npcId,
      decision.updatedIntent
    );
  }

  if (decision.shouldReviseSchedule && dgsm) {
    await npcPlanningAgent.reviseSchedule(
      dgsm,
      sessionId,
      npcId,
      triggerDescription,
      language,
      registry
    );
  }
}
