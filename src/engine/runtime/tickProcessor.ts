import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { NPCPlanningAgent } from "../../planning/NPCPlanningAgent.js";
import type {
  CharacterAction,
  PlanNode,
  SimulationTickResult,
} from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
// Phase D: sanityFeature was relocated to src/simulation/roleSim/sanityGuidance.ts
// (LLM-judged bouts of madness). The legacy drainPendingEmotions queue no
// longer exists. tickProcessor.ts is slated for deletion in Phase E (Task E3);
// until then this is a no-op stub so transitive importers (e.g. mapService) can
// still resolve the module graph.
function drainPendingEmotions(_dgsm: unknown): unknown[] {
  return [];
}
import { interpretAction } from "../interpreter/gameInterpreter.js";
import type { GameEngineRegistry } from "../registry.js";
import { applyStateResolution } from "../resolver/applyStateResolution.js";
import { buildStateContext } from "../resolver/stateContextBuilder.js";
import { resolveState } from "../resolver/stateResolver.js";
import { buildEncounterSnapshot } from "../shared/encounterDedup.js";
import { executeSkillCheck } from "../tools/skillCheckTool.js";
import type { ExecutionContext, TickRuntimeContext } from "../types.js";
import { scanUnplannedEncounters } from "./encounterScanner.js";
import {
  processImpactPipeline,
  recordRevisionInterruption as recordRevisionInterruptionEntry,
} from "./impactPipeline.js";
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
  buildExecutionContextPromptBlock,
  diffMinutes,
} from "./resolutionExecutionContext.js";

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
 * 4. Post-execution: relationship update, NPC memory, discovery
 * 5. Built-in impact propagation (scan impact>0 actions, notify affected NPCs, LLM gate, intent update / node interruption)
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
    if (!nodeByNpc.has(node.characterId)) {
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

  // NPCs targeted by an in-progress character_interaction
  // are "engaged" and should not execute their own nodes this tick.
  const engagedTargets = new Set<string>();
  for (const node of allNodes) {
    if (
      node.type === "character_interaction" &&
      node.status === "in_progress" &&
      node.targetCharacterIds?.length
    ) {
      for (const tid of node.targetCharacterIds) {
        engagedTargets.add(tid);
      }
    }
  }

  const tickActions: CharacterAction[] = [];
  const executedNodes: PlanNode[] = [];
  const nodesReadyToExecute: PlanNode[] = [];
  const movementFinalizations: Array<{
    node: PlanNode;
    action: CharacterAction;
  }> = [];
  const movedNpcIds = new Set<string>();

  const recordRevisionInterruption = async (
    node: PlanNode,
    action: CharacterAction | undefined
  ): Promise<void> => {
    if (!action) return;

    // Write a memory for the interrupted action
    if (memoryManager) {
      await memoryManager.add({
        npcId: node.characterId,
        sessionId,
        moduleId,
        type: "event",
        content: action.outcome ?? `${node.action} was interrupted.`,
        gameDay,
        gameTime: action.gameTime,
        location: action.location,
      });
    }

    await recordRevisionInterruptionEntry({
      action,
      tickActions,
    });
    logNodeExecutionResult(node, action);
  };

  for (const rawNode of allNodes) {
    // Skip execution for NPCs engaged as interaction targets
    if (engagedTargets.has(rawNode.characterId)) {
      if (rawNode.status === "pending") {
        const held: PlanNode = {
          ...rawNode,
          status: "in_progress",
          executionMeta: { ...rawNode.executionMeta, startedAt: tickStartTime },
        };
        await npcPlanningAgent.updateNode(
          sessionId,
          held.characterId,
          gameDay,
          held
        );
      }
      continue;
    }

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
          location: (() => {
            const pos = dgsm.getCharacterPosition(node.characterId);
            return pos ? dgsm.resolveLocationId(pos) : "";
          })(),
          type: node.type,
          impact: 0,
          status: "failed",
          failureReason: "prerequisite_not_met",
          outcome: blocked.reason,
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
    const pos = dgsm.getCharacterPosition(node.characterId);
    const loc = pos ? dgsm.resolveLocationId(pos) : "";
    const group = nodesByLocation.get(loc) ?? [];
    group.push(node);
    nodesByLocation.set(loc, group);
  }

  await Promise.all(
    [...nodesByLocation.values()].map(async (sceneNodes) => {
      // Within same scene, higher DEX acts first
      sceneNodes.sort((a, b) => {
        const npcA = state.npcCharacters.find((n) => n.id === a.characterId);
        const npcB = state.npcCharacters.find((n) => n.id === b.characterId);
        return (npcB?.attributes?.DEX ?? 50) - (npcA?.attributes?.DEX ?? 50);
      });
      // Track targets engaged by interactions resolved within this scene
      const sceneEngaged = new Set<string>();
      for (const rawNode of sceneNodes) {
        if (sceneEngaged.has(rawNode.characterId)) {
          // Engaged by an interaction that just resolved — hold node in_progress
          if (rawNode.status === "pending") {
            const held: PlanNode = {
              ...rawNode,
              status: "in_progress",
              executionMeta: {
                ...rawNode.executionMeta,
                startedAt: tickStartTime,
              },
            };
            await npcPlanningAgent.updateNode(
              sessionId,
              held.characterId,
              gameDay,
              held
            );
          }
          continue;
        }

        const node = rawNode;
        executedNodes.push(node);

        // --- GameInterpreter: classify action into definition steps ---
        const definitions = registry.getAllDefinitions();
        const interpreted = await interpretAction(
          node.action,
          definitions,
          ctx.runtime,
          language
        );
        const steps = interpreted.steps;

        // Use first non-movement step (movement steps handled above in the movement section)
        const step =
          steps.find((s) => s.definitionId !== "movement") ?? steps[0];
        const definition =
          registry.getDefinition(step.definitionId) ??
          registry.getDefinition("generic");

        // --- Skill Check ---
        const pos = dgsm.getCharacterPosition(node.characterId);
        const locationId = pos ? dgsm.resolveLocationId(pos) : "";
        const targetIds = node.targetCharacterIds;

        const skillResult = executeSkillCheck(
          definition?.skillCheck,
          node.characterId,
          node.skill,
          dgsm,
          locationId,
          registry,
          targetIds
        );

        let action: CharacterAction;

        if (
          skillResult.status === "failed" &&
          definition?.skillCheck?.failBehavior === "abort"
        ) {
          // Skill check failed with abort behavior
          action = {
            characterId: node.characterId,
            characterName: node.characterName,
            gameTime: tickStartTime,
            action: node.action,
            location: locationId,
            type: node.type,
            impact: step.impact,
            status: "failed",
            failureReason: "skill_roll_failed",
            outcome: skillResult.outcomeDescription,
            successLevel: skillResult.successLevel,
            rollDetail: skillResult.rollDetail,
            perTargetResults: skillResult.perTargetResults,
          };
        } else {
          // --- StateResolver: generate state changes ---
          const outcomeKey =
            skillResult.status === "failed" ? "On Failure" : "On Success";
          const sectionRegex = new RegExp(
            `### ${outcomeKey}\\n([\\s\\S]*?)(?=### |## |$)`
          );
          const guidanceBody =
            definition?.guidanceBody ?? definition?.content ?? "";
          const sectionMatch = guidanceBody.match(sectionRegex);
          const outcomeSection = sectionMatch?.[1] ?? guidanceBody;

          const stateCtx = buildStateContext(
            definition!,
            node,
            dgsm,
            locationId,
            registry
          );

          const resolutionContext = {
            executionStatus: "completed" as const,
            startedAt: node.executionMeta?.startedAt ?? node.startTime,
            resolvedAt: node.endTime,
            elapsedMinutes: Math.max(
              1,
              diffMinutes(node.startTime, node.endTime)
            ),
            plannedMinutes: Math.max(
              1,
              diffMinutes(node.startTime, node.endTime)
            ),
          };

          const stateResolution = await resolveState(
            {
              action: node.action,
              definition: definition!,
              outcomeSection,
              skillCheckResult: skillResult,
              stateContext: stateCtx,
              executionContext:
                buildExecutionContextPromptBlock(resolutionContext),
              language,
            },
            ctx.runtime
          );

          const outputSchema = definition?.outputSchema;
          if (outputSchema) {
            applyStateResolution(dgsm, stateResolution, outputSchema);
          }

          // Feature overlay activation from StateResolution
          for (const feature of registry.getAllFeatures()) {
            const schema = feature.planNodeSchema;
            if (!schema) continue;
            const allFields = [
              ...schema.requiredFields,
              ...(schema.optionalFields ?? []),
            ];
            for (const fieldDef of allFields) {
              if (stateResolution[fieldDef.field] !== undefined) {
                const syntheticNode = {
                  ...node,
                  [fieldDef.field]: stateResolution[fieldDef.field],
                };
                feature.activate?.(syntheticNode as any, dgsm);
                break; // one activation per feature
              }
            }
          }

          // Write memories from StateResolution
          const memoryTypes = ["memory.event", "memory.witness"];
          if (memoryManager) {
            for (const memType of memoryTypes) {
              const memories = stateResolution[memType];
              if (!Array.isArray(memories)) continue;
              for (const mem of memories) {
                await memoryManager.add({
                  npcId: mem.characterId,
                  sessionId,
                  moduleId,
                  type: memType.split(".")[1] as any,
                  content: mem.content,
                  gameDay,
                  gameTime: tickStartTime,
                  location: locationId,
                });
              }
            }
          }

          action = {
            characterId: node.characterId,
            characterName: node.characterName,
            gameTime: tickStartTime,
            action: node.action,
            location: locationId,
            type: node.type,
            impact: step.impact,
            status: skillResult.status === "failed" ? "failed" : "completed",
            outcome: skillResult.outcomeDescription,
            successLevel: skillResult.successLevel,
            rollDetail: skillResult.rollDetail,
            perTargetResults: skillResult.perTargetResults,
          };
        }

        tickActions.push(action);

        // Stealth: successful Stealth → hide; any other action → reveal
        if (action.status === "completed" && node.skill === "Stealth") {
          dgsm.setCharacterHidden(node.characterId, true);
        } else if (dgsm.isCharacterHidden(node.characterId)) {
          dgsm.setCharacterHidden(node.characterId, false);
        }

        // Mark interaction targets as engaged so their nodes are skipped
        if (
          node.type === "character_interaction" &&
          action.status === "completed" &&
          node.targetCharacterIds?.length
        ) {
          for (const tid of node.targetCharacterIds) {
            sceneEngaged.add(tid);
          }
        }

        logNodeExecutionResult(node, action);

        // Fumble -> damage a random evidence item in the NPC's current scene
        if (action.successLevel === "fumble") {
          const scene = dgsm.getScene(action.location);
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
              action.location
            );
            action.damagedEvidence = {
              itemId: victim.id,
              sourceName: scene?.name ?? action.location,
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

    if (action.status === "completed") {
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
    const actedNpcIds = new Set(tickActions.map((a) => a.characterId));
    await syncNpcMapMemories({
      dgsm,
      memoryManager,
      sessionId,
      moduleId,
      gameDay,
      gameTime: tickRuntime.tickTime,
      movedNpcIds,
      actedNpcIds,
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
