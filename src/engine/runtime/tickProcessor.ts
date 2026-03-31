import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { NPCPlanningAgent } from "../../planning/NPCPlanningAgent.js";
import type {
  CharacterAction,
  PlanNode,
  SimulationTickResult,
} from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { drainPendingEmotions } from "../features/sanityFeature.js";
import type { GameEngineRegistry } from "../registry.js";
import { buildEncounterSnapshot } from "../shared/encounterDedup.js";
import type { ExecutionContext, TickRuntimeContext } from "../types.js";
import {
  type PendingRevisionRequest,
  postProcessExecutedNodeAction,
} from "./actionPostProcessing.js";
import { recoverActionExecution } from "./autoActionRecovery.js";
import { scanUnplannedEncounters } from "./encounterScanner.js";
import { processImpactPipeline } from "./impactPipeline.js";
import { syncNpcMapMemories } from "./mapMemorySync.js";
import {
  TICK_DURATION_MINUTES,
  advanceMovementNodeOneMinute,
  initializeMovementNode,
  minutesToTimeLabel,
  rollStealthForMovement,
  startNode,
  timeToMinutes,
} from "./movementTick.js";
import {
  processPendingRevisionRequests,
  recordRevisionInterruption as recordRevisionInterruptionEntry,
} from "./revisionPipeline.js";

function formatActionStatusLabel(action: CharacterAction): string {
  switch (action.status) {
    case "completed":
      return "completed";
    case "failed":
      return `failed${action.failureReason ? ` (${action.failureReason})` : ""}`;
    case "interrupted":
      return `interrupted${action.interruptionReason ? ` (${action.interruptionReason})` : ""}`;
    default:
      return action.status;
  }
}

function logNodeExecutionResult(node: PlanNode, action: CharacterAction): void {
  const details: string[] = [
    `[NodeResult] ${formatActionStatusLabel(action)}`,
    `${node.characterName}`,
    `${node.type}`,
    `@ ${action.location}`,
    `[${action.gameTime}]`,
  ];

  if (action.successLevel) {
    details.push(`[roll ${action.successLevel}]`);
  }

  console.log(`${details.join(" ")} ${action.outcome}`);
}
// ==================== Single tick execution ====================

interface SingleTickParams {
  tickStartMinutes: number;
  tickDurationMinutes: number;
  /** Nodes injected by previous ticks' feature propagation, to be executed in this tick */
  carryOverNodes?: PlanNode[];
  previousEncounterSignatures?: ReadonlySet<string>;
  dgsm: DynamicGameStateManager;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  moduleId: string;
  language: string;
  registry: GameEngineRegistry;
  ctx: ExecutionContext;
  memoryManager?: NpcMemoryManager;
}

interface SingleTickResult {
  actions: CharacterAction[];
  injectedNodes: PlanNode[];
  worldEvents: import("../../planning/types.js").WorldEventDescriptor[];
  encounterSignatures: string[];
}

/**
 * Execute a single 1-minute simulation tick.
 *
 * 1. Fetch NPC nodes due in [tickStart, tickEnd)
 * 2. Merge with carry-over nodes, sort (gameTime ASC, DEX DESC), scan encounters
 * 3. Execute all nodes via registry handlers
 * 4. Post-execution: relationship update, NPC memory, discovery, NPC failure revisePlans
 * 5. Built-in impact propagation (scan impact>0 actions, notify affected NPCs, LLM gate, plan revision)
 * 6. Feature temporal tick — each feature updates its time/state-driven logic
 * 7. Detect feature overlay fields on executed nodes → register propagation sources
 * 8. Drive feature propagation on schedule
 * 9. Return tick result
 */
async function executeSingleTick(
  params: SingleTickParams
): Promise<SingleTickResult> {
  const {
    tickStartMinutes,
    tickDurationMinutes,
    carryOverNodes,
    dgsm,
    npcPlanningAgent,
    sessionId,
    moduleId,
    language,
    registry,
    ctx,
    memoryManager,
    previousEncounterSignatures,
  } = params;

  const state = dgsm.getState();
  const gameDay = state.gameDay;
  const tickEndMinutes = tickStartMinutes + tickDurationMinutes - 1; // inclusive end
  const tickStartTime = minutesToTimeLabel(tickStartMinutes);
  const tickEndTime = minutesToTimeLabel(tickEndMinutes);
  const isFullTick = tickDurationMinutes >= TICK_DURATION_MINUTES;
  ctx.currentTime = tickStartTime;

  // Build runtime context for WorldFeature hooks
  const tickRuntime: TickRuntimeContext = {
    sessionId,
    gameDay,
    language,
    tickTime: tickStartTime,
    tickDurationMinutes,
    npcPlanning: npcPlanningAgent,
  };

  // 0. Ensure NPCs have detailed nodes available (two-tier planning refill)
  const allNpcIds = dgsm.getSimulatedNpcs().map((n) => n.id);
  await Promise.all(
    allNpcIds.map((npcId) =>
      npcPlanningAgent.ensureNpcNodesAvailable(
        dgsm,
        sessionId,
        npcId,
        gameDay,
        tickStartTime,
        language,
        registry
      )
    )
  );

  // 1. Get active and due nodes for this minute
  const inProgressNodes = await npcPlanningAgent.getInProgressNodes(
    sessionId,
    gameDay,
    dgsm
  );
  const dueNpcNodes = await npcPlanningAgent.getDueNpcNodes(
    sessionId,
    gameDay,
    tickEndTime,
    dgsm
  );

  const nodeByNpc = new Map<string, PlanNode>();
  for (const node of inProgressNodes) {
    nodeByNpc.set(node.characterId, node);
  }
  for (const node of dueNpcNodes) {
    if (nodeByNpc.has(node.characterId)) continue;
    const existing = nodeByNpc.get(node.characterId);
    if (!existing) {
      nodeByNpc.set(node.characterId, node);
      continue;
    }
    const existingNpc = state.npcCharacters.find(
      (n) => n.id === existing.characterId
    );
    const nodeNpc = state.npcCharacters.find((n) => n.id === node.characterId);
    const existingDex = existingNpc?.attributes?.DEX ?? 50;
    const nodeDex = nodeNpc?.attributes?.DEX ?? 50;
    if (
      node.startTime < existing.startTime ||
      (node.startTime === existing.startTime && nodeDex > existingDex)
    ) {
      nodeByNpc.set(node.characterId, node);
    }
  }

  const allNodes: PlanNode[] = [
    ...nodeByNpc.values(),
    ...(carryOverNodes ?? []),
  ].filter((node) => dgsm.isNpcAlive(node.characterId));

  allNodes.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "in_progress" ? -1 : 1;
    }
    const timeDiff = a.startTime.localeCompare(b.startTime);
    if (timeDiff !== 0) return timeDiff;
    const npcA = state.npcCharacters.find((n) => n.id === a.characterId);
    const npcB = state.npcCharacters.find((n) => n.id === b.characterId);
    const dexA = npcA?.attributes?.DEX ?? 50;
    const dexB = npcB?.attributes?.DEX ?? 50;
    return dexB - dexA;
  });

  const tickActions: CharacterAction[] = [];
  const executedNodes: PlanNode[] = [];
  const nodesReadyToExecute: PlanNode[] = [];
  const movementFinalizations: Array<{
    node: PlanNode;
    action: CharacterAction;
  }> = [];
  const movedNpcIds = new Set<string>();
  const pendingRevisionRequests: PendingRevisionRequest[] = [];

  const recordRevisionInterruption = async (
    action: CharacterAction | undefined
  ): Promise<void> =>
    recordRevisionInterruptionEntry({
      action,
      tickActions,
      sessionId,
      moduleId,
      gameDay,
      memoryManager,
    });

  for (const rawNode of allNodes) {
    if (rawNode.type === "movement") {
      const initializedNode =
        rawNode.status === "pending"
          ? initializeMovementNode(rawNode, dgsm, tickStartTime, language)
          : rawNode;

      const advancedMovement = advanceMovementNodeOneMinute(
        initializedNode,
        dgsm,
        tickStartTime,
        language
      );
      await npcPlanningAgent.updateNode(
        sessionId,
        rawNode.characterId,
        gameDay,
        advancedMovement.node
      );
      if (advancedMovement.moved) {
        movedNpcIds.add(rawNode.characterId);
        // Hidden NPC moving: Stealth check to stay concealed
        if (dgsm.isCharacterHidden(rawNode.characterId)) {
          if (!rollStealthForMovement(dgsm, rawNode.characterId)) {
            dgsm.setCharacterHidden(rawNode.characterId, false);
          }
        }
      }
      if (advancedMovement.action) {
        movementFinalizations.push({
          node: advancedMovement.node,
          action: advancedMovement.action,
        });
        executedNodes.push(advancedMovement.node);
      }
      continue;
    }

    let node = rawNode;
    if (node.status === "pending") {
      node = startNode(node, tickStartTime);
      // Fire onNodeStart hooks for feature overlays (e.g., prerequisite location checks)
      const blocked = registry.startNodeFeatures(node, dgsm);
      if (blocked) {
        // Prerequisite failed at action start — abort this node
        const failedNode: PlanNode = {
          ...node,
          status: "failed",
          executionMeta: {
            ...node.executionMeta,
            failedAt: tickStartTime,
            remainingMinutes: 0,
            blockedReason: blocked.reason,
          },
        };
        await npcPlanningAgent.updateNode(
          sessionId,
          node.characterId,
          gameDay,
          failedNode
        );
        tickActions.push({
          characterId: node.characterId,
          characterName: node.characterName,
          gameTime: tickStartTime,
          action: node.action,
          location: node.location,
          type: node.type,
          impact: node.impact ?? 0,
          status: "failed",
          failureReason: "prerequisite_not_met",
          outcome: blocked.reason,
        });
        pendingRevisionRequests.push({
          npcId: node.characterId,
          trigger: {
            type: "failure",
            failureReason: "prerequisite_not_met",
            action: node.action,
            gameTime: tickStartTime,
            failureOutcome: blocked.reason,
          },
          reactionQuery: blocked.reason,
        });
        continue;
      }
    }

    // Non-movement nodes: execute when tick reaches endTime
    if (tickStartTime < node.endTime) {
      // Still in progress — persist status change if just started
      if (rawNode.status === "pending") {
        await npcPlanningAgent.updateNode(
          sessionId,
          node.characterId,
          gameDay,
          node
        );
      }
      continue;
    }

    nodesReadyToExecute.push(node);
  }

  // 2. Execute nodes that reach their final minute in this tick
  //    Group by location so different scenes run in parallel,
  //    while nodes within the same scene stay serial.
  const nodesByLocation = new Map<string, PlanNode[]>();
  for (const node of nodesReadyToExecute) {
    const group = nodesByLocation.get(node.location) ?? [];
    group.push(node);
    nodesByLocation.set(node.location, group);
  }

  await Promise.all(
    [...nodesByLocation.values()].map(async (sceneNodes) => {
      for (const rawNode of sceneNodes) {
        let node = rawNode;
        // Dispatch to registry handler
        const handler = registry.getHandler(node.type);
        if (!handler) {
          console.warn(
            `[TickProcessor] No handler for node type: ${node.type}, skipping`
          );
          continue;
        }
        executedNodes.push(node);
        let action = await handler.execute(node, dgsm, ctx);
        const recoveryResult = await recoverActionExecution({
          node,
          action,
          handler,
          dgsm,
          ctx,
          npcPlanningAgent,
          sessionId,
          moduleId,
          gameDay,
          tickStartTime,
          language,
          movedNpcIds,
          memoryManager,
        });
        node = recoveryResult.node;
        action = recoveryResult.action;

        tickActions.push(action);

        // Stealth: successful Stealth → hide; any other action → reveal
        if (action.status === "completed" && node.skill === "Stealth") {
          dgsm.setCharacterHidden(node.characterId, true);
        } else if (dgsm.isCharacterHidden(node.characterId)) {
          dgsm.setCharacterHidden(node.characterId, false);
        }

        // 3b. Activate feature overlays for this node (per-node, before resolver/memory)
        const featureResults = registry.activateNodeFeatures(node, dgsm);
        const featureNotes = featureResults
          .map((r) => r.outcomeNote)
          .filter(Boolean) as string[];
        const postProcessResult = await postProcessExecutedNodeAction({
          node,
          action,
          dgsm,
          ctx,
          npcPlanningAgent,
          sessionId,
          moduleId,
          gameDay,
          language,
          registry,
          featureNotes,
          memoryManager,
        });
        action = postProcessResult.action;
        if (postProcessResult.pendingRevisionRequest) {
          pendingRevisionRequests.push(
            postProcessResult.pendingRevisionRequest
          );
        }

        logNodeExecutionResult(node, action);

        // Fumble -> damage a random evidence item in the NPC's current scene
        if (action.successLevel === "fumble") {
          const scene = dgsm.getScene(node.location);
          const damageable =
            scene?.items?.filter(
              (i) => i.category === "evidence" && !i.damaged
            ) ?? [];
          if (damageable.length > 0) {
            const victim =
              damageable[Math.floor(Math.random() * damageable.length)];
            dgsm.damageEvidenceItem(
              victim.id,
              node.characterName,
              `Fumbled: ${node.action}`,
              node.location
            );
            action.damagedEvidence = {
              itemId: victim.id,
              sourceName: scene?.name ?? node.location,
            };
            console.log(
              `[TickProcessor] Fumble damaged evidence: ${(victim.description || victim.name).slice(0, 40)}`
            );
          }
        }
      }
    })
  );

  for (const { node, action } of movementFinalizations) {
    tickActions.push(action);
    logNodeExecutionResult(node, action);

    if (memoryManager) {
      await memoryManager.add({
        npcId: node.characterId,
        sessionId,
        moduleId,
        type: "event",
        content: action.outcome,
        gameDay,
        gameTime: action.gameTime,
        location: action.location,
        metadata: {
          outcome: action.outcome,
          failureReason: action.failureReason ?? "",
          blockedReason: node.executionMeta.blockedReason ?? "",
        },
      });
    }

    if (action.status === "failed") {
      pendingRevisionRequests.push({
        npcId: node.characterId,
        trigger: {
          type: "failure",
          failureReason: "location_blocked",
          action: action.action,
          gameTime: action.gameTime,
          failureOutcome: action.outcome,
          blockedReason: node.executionMeta.blockedReason,
        },
        reactionQuery: `${action.action} failed: ${node.executionMeta.blockedReason ?? action.outcome}`,
      });
    } else if (action.status === "completed") {
      const scheduledEndMinutes = timeToMinutes(node.endTime);
      const actualEndMinutes = timeToMinutes(action.gameTime);
      const scheduleDeltaMinutes = scheduledEndMinutes - actualEndMinutes;

      if (scheduleDeltaMinutes !== 0) {
        await npcPlanningAgent.shiftPendingNodesByDelta(
          sessionId,
          node.characterId,
          gameDay,
          node.endTime,
          scheduleDeltaMinutes
        );
      }
    }
  }

  await processPendingRevisionRequests({
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
  });

  const encounterEvents = scanUnplannedEncounters({
    dgsm,
    tickTime: tickStartTime,
    tickActions,
    movedNpcIds,
    previousEncounterSignatures:
      previousEncounterSignatures ?? new Set<string>(),
    lang: language,
  });

  const injectedNodes: PlanNode[] = [];
  await processImpactPipeline({
    dgsm,
    tickActions,
    encounterEvents,
    npcPlanningAgent,
    sessionId,
    moduleId,
    gameDay,
    language,
    registry,
    tickRuntime,
    memoryManager,
    recordRevisionInterruption,
  });

  // 6. Feature temporal tick — let each feature update its time/state-driven logic
  for (const feature of registry.getAllFeatures()) {
    feature.tick?.(dgsm, tickRuntime);
  }

  // 7. Feature overlay activation already done per-node in step 3b above.
  //    (propagation sources registered there as well)

  // 8. Drive feature propagation on schedule
  for (const feature of registry.getAllFeatures()) {
    if (!feature.propagation || !feature.propagate) continue;
    if (!registry.shouldPropagationFire(feature.id, isFullTick)) continue;

    const sources = registry.getPropagationSources(feature.id);
    if (sources.length === 0) continue;

    const nextSources: Array<{ sceneId: string; currentHop: number }> = [];

    for (const source of sources) {
      const propResult = await feature.propagate(
        source.sceneId,
        source.currentHop,
        dgsm,
        tickRuntime
      );

      // New scenes become sources at hop+1
      for (const newSceneId of propResult.spreadTo) {
        nextSources.push({
          sceneId: newSceneId,
          currentHop: source.currentHop + 1,
        });
      }
      // Original source persists at hop+1
      nextSources.push({
        sceneId: source.sceneId,
        currentHop: source.currentHop + 1,
      });

      // Collect propagation-injected nodes
      if (propResult.newNodes?.length) {
        injectedNodes.push(...propResult.newNodes);
      }
    }

    registry.updatePropagationSources(feature.id, nextSources);
  }

  // Drain sanity-triggered emotions (clear from pending queue; no longer persisted as memory)
  drainPendingEmotions(dgsm);

  if (memoryManager) {
    await syncNpcMapMemories({
      dgsm,
      memoryManager,
      sessionId,
      moduleId,
      gameDay,
      gameTime: tickRuntime.tickTime,
      movedNpcIds,
    });
  }

  // Collect world events from features (scene_updated, feature_triggered)
  const worldEvents = dgsm.drainWorldEvents();
  const encounterSignatures = [...buildEncounterSnapshot(dgsm)];

  return {
    actions: tickActions,
    injectedNodes,
    worldEvents,
    encounterSignatures,
  };
}

// ==================== Simulation tick ====================

/**
 * Execute a single simulation tick (no player involved).
 *
 * Wraps executeSingleTick and advances game time
 * by TICK_DURATION_MINUTES afterwards.
 */
export async function runSimulationTick(params: {
  dgsm: DynamicGameStateManager;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  moduleId: string;
  language: string;
  registry: GameEngineRegistry;
  ctx: ExecutionContext;
  memoryManager?: NpcMemoryManager;
  previousEncounterSignatures?: ReadonlySet<string>;
}): Promise<SimulationTickResult> {
  const state = params.dgsm.getState();
  const tickStartMinutes =
    Number.parseInt(state.timeOfDay.split(":")[0]) * 60 +
    Number.parseInt(state.timeOfDay.split(":")[1]);

  const result = await executeSingleTick({
    tickStartMinutes,
    tickDurationMinutes: TICK_DURATION_MINUTES,
    ...params,
  });

  const { dayChanged } = params.dgsm.updateGameTime(TICK_DURATION_MINUTES);

  return {
    actions: result.actions,
    worldEvents: result.worldEvents,
    encounterSignatures: result.encounterSignatures,
    dayChanged,
  };
}
