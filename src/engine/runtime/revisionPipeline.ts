import type { GameEngineRegistry } from "../registry.js";
import type { TickRuntimeContext } from "../types.js";
import type { PendingRevisionRequest } from "./actionPostProcessing.js";
import type { NPCPlanningAgent } from "../../planning/NPCPlanningAgent.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterAction } from "../../planning/types.js";

export async function recordRevisionInterruption(params: {
  action: CharacterAction | undefined;
  tickActions: CharacterAction[];
  sessionId: string;
  moduleId: string;
  gameDay: number;
  memoryManager?: NpcMemoryManager;
}): Promise<void> {
  const { action, tickActions, sessionId, moduleId, gameDay, memoryManager } =
    params;
  if (!action) return;

  tickActions.push(action);
  if (!memoryManager) return;

  await memoryManager.add({
    npcId: action.characterId,
    sessionId,
    moduleId,
    type: "event",
    content: action.outcome,
    gameDay,
    gameTime: action.gameTime,
    location: action.location,
    metadata: {
      outcome: action.outcome,
      interruptionReason: action.interruptionReason ?? "",
    },
  });
}

export async function processPendingRevisionRequests(params: {
  pendingRevisionRequests: PendingRevisionRequest[];
  dgsm: DynamicGameStateManager;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  language: string;
  registry: GameEngineRegistry;
  tickRuntime: TickRuntimeContext;
  recordRevisionInterruption: (
    action: CharacterAction | undefined
  ) => Promise<void>;
  memoryManager?: NpcMemoryManager;
}): Promise<void> {
  const {
    pendingRevisionRequests,
    dgsm,
    npcPlanningAgent,
    sessionId,
    moduleId,
    gameDay,
    language,
    registry,
    tickRuntime,
    recordRevisionInterruption,
    memoryManager,
  } = params;
  if (pendingRevisionRequests.length === 0) return;

  if (memoryManager) {
    const revisionNpcIds = [
      ...new Set(pendingRevisionRequests.map((request) => request.npcId)),
    ];
    await Promise.all(
      revisionNpcIds.map(async (npcId) => {
        const position = dgsm.getCharacterPosition(npcId);
        const location = position
          ? dgsm.resolveLocationId(position)
          : undefined;
        await memoryManager.refreshMapSnapshot({
          npcId,
          sessionId,
          moduleId,
          gameDay,
          gameTime: tickRuntime.tickTime,
          location,
          dgsm,
        });
      })
    );
  }

  const revisionResults = await Promise.all(
    pendingRevisionRequests.map(async (request) => {
      let failureContext: string | undefined;
      if (memoryManager) {
        failureContext = await memoryManager.getContext({
          npcId: request.npcId,
          sessionId,
          purpose: "reaction",
          query: request.reactionQuery,
          currentGameDay: gameDay,
        });
      }

      const longTermIntent = await npcPlanningAgent.getLongTermIntent(
        sessionId,
        request.npcId
      );
      const memoryLog = failureContext ? [failureContext] : [];
      const reviseResult = await npcPlanningAgent.revisePlans(
        dgsm,
        sessionId,
        request.npcId,
        {
          longTermIntent,
          memoryLog,
          pendingNodes: [],
          trigger: request.trigger,
        },
        language,
        registry
      );

      return reviseResult.interruptedAction;
    })
  );

  for (const interruptedAction of revisionResults) {
    await recordRevisionInterruption(interruptedAction);
  }
}
