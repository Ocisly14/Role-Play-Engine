import { t } from "../../i18n/t.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { NPCPlanningAgent } from "../../npc/planning/NPCPlanningAgent.js";
import {
  buildLocationNameMap,
  resolveLocationId as resolveLocationFromName,
} from "../../npc/planning/sceneMapFormatter.js";
import type {
  ActionResolutionContext,
  CharacterAction,
  PlanNode,
  SuccessLevel,
} from "../../npc/planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { Item } from "../../state/types.js";
import { applyFatigueDelta } from "../features/staminaFeature.js";
import {
  applyActionSceneDelta,
  resolveActionState,
} from "../handlers/actionStateResolver.js";
import {
  applyCharacterDelta,
  resolveInteractionState,
  resolveTargets,
} from "../handlers/interactionStateResolver.js";
import { resolveTargetPosition } from "../handlers/movementHandler.js";
import type { GameEngineRegistry } from "../registry.js";
import {
  applyObjectDelta,
  resolveItemState,
} from "../tools/itemStateResolver.js";
import type { ExecutionContext } from "../types.js";
import {
  discoverEvidence,
  discoverNpcKnowledge,
  embedDiscoveries,
} from "./discoveryPipeline.js";
import { buildActionResolutionContext } from "./resolutionExecutionContext.js";

interface ItemActionContext {
  itemId?: string;
  itemName?: string;
  targetItemId?: string;
  targetItemName?: string;
}

function findKnownItem(
  dgsm: DynamicGameStateManager,
  node: PlanNode,
  locationId: string,
  itemId: string
): Item | null {
  const actorItem = dgsm.findNpcItem(node.characterId, itemId);
  if (actorItem) return actorItem;

  const sceneItem = dgsm
    .getScene(locationId)
    ?.items.find((i) => i.id === itemId);
  if (sceneItem) return sceneItem;

  const primaryTargetId = node.targetCharacterIds?.[0];
  if (primaryTargetId) {
    const targetItem = dgsm.findNpcItem(primaryTargetId, itemId);
    if (targetItem) return targetItem;
  }

  return null;
}

function getItemActionContext(
  dgsm: DynamicGameStateManager,
  node: PlanNode,
  locationId: string
): ItemActionContext | null {
  if (node.type === "object_interaction" && node.objectInteractionPayload) {
    const { itemId } = node.objectInteractionPayload;
    if (!itemId) return null;
    const item = findKnownItem(dgsm, node, locationId, itemId);
    return {
      itemId,
      itemName: item?.name,
    };
  }

  return null;
}

function formatItemReference(
  name: string | undefined,
  id: string | undefined
): string | null {
  if (!name && !id) return null;
  if (name && id) return `${name} (id:${id})`;
  return name ?? id ?? null;
}

function appendItemContext(
  outcome: string,
  itemContext: ItemActionContext | null
): string {
  if (!itemContext) return outcome;

  const parts: string[] = [];
  const itemRef = formatItemReference(itemContext.itemName, itemContext.itemId);
  if (itemRef) parts.push(`item: ${itemRef}`);

  const targetRef = formatItemReference(
    itemContext.targetItemName,
    itemContext.targetItemId
  );
  if (targetRef) parts.push(`target: ${targetRef}`);

  if (parts.length === 0) return outcome;
  return `${outcome} [${parts.join("; ")}]`;
}

function buildEventMetadata(
  outcome: string,
  itemContext: ItemActionContext | null
): Record<string, string> {
  const metadata: Record<string, string> = { outcome };

  if (itemContext?.itemId) metadata.itemId = itemContext.itemId;
  if (itemContext?.itemName) metadata.itemName = itemContext.itemName;
  if (itemContext?.targetItemId)
    metadata.targetItemId = itemContext.targetItemId;
  if (itemContext?.targetItemName) {
    metadata.targetItemName = itemContext.targetItemName;
  }

  return metadata;
}

export function shouldRunResolver(action: CharacterAction): boolean {
  return (
    action.status === "completed" ||
    action.status === "interrupted" ||
    action.failureReason === "skill_roll_failed"
  );
}

export function sanitizeFatigueDelta(
  fatigueDelta: number | undefined,
  resolutionContext: ActionResolutionContext
): number {
  if (fatigueDelta == null || !Number.isFinite(fatigueDelta)) return 0;
  const absoluteBound = Math.max(
    3,
    Math.min(8, Math.ceil(resolutionContext.plannedMinutes / 30))
  );
  return Math.max(
    -absoluteBound,
    Math.min(absoluteBound, Math.trunc(fatigueDelta))
  );
}

export function applyIncidentalActionMove(params: {
  dgsm: DynamicGameStateManager;
  characterId: string;
  moveTo?: string;
}): boolean {
  const { dgsm, characterId, moveTo } = params;
  if (!moveTo) return false;

  const targetPosition = resolveTargetPosition(
    moveTo,
    dgsm.getTopology(),
    dgsm
  );
  if (!targetPosition) {
    console.warn(
      `[ActionPostProcessing] Ignoring invalid incidental action moveTo "${moveTo}" for ${characterId}`
    );
    return false;
  }

  dgsm.setCharacterPosition(characterId, targetPosition);
  return true;
}

export async function postProcessExecutedNodeAction(params: {
  node: PlanNode;
  action: CharacterAction;
  dgsm: DynamicGameStateManager;
  ctx: ExecutionContext;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  language: string;
  registry: GameEngineRegistry;
  featureNotes: string[];
  memoryManager?: NpcMemoryManager;
}): Promise<{
  action: CharacterAction;
}> {
  const {
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
  } = params;
  const state = dgsm.getState();
  const locationId = action.location;
  const itemContext = getItemActionContext(dgsm, node, locationId);
  let eventOutcome = appendItemContext(action.outcome, itemContext);
  const eventMetadata = buildEventMetadata(action.outcome, itemContext);
  const allTargetIds = node.targetCharacterIds ?? [];
  const resolutionContext = buildActionResolutionContext(node, action);
  if (action.failureReason) {
    eventMetadata.failureReason = action.failureReason;
  }
  if (action.interruptionReason) {
    eventMetadata.interruptionReason = action.interruptionReason;
  }

  // Run LLM resolver for character_interaction when the interaction actually
  // took place (completed OR skill_roll_failed — both mean actor & targets were
  // co-located and the attempt happened). Skip for target_absent / prerequisite_not_met.
  const interactionAttempted =
    node.type === "character_interaction" && shouldRunResolver(action);

  if (interactionAttempted) {
    const npcKnowledge = memoryManager
      ? await discoverNpcKnowledge(node, dgsm, memoryManager)
      : [];

    const skillRollResult = action.successLevel
      ? {
          successLevel: action.successLevel,
          detail: action.rollDetail ?? "",
          perTargetResults: action.perTargetResults,
        }
      : null;

    const delta = await resolveInteractionState(
      node,
      dgsm,
      ctx.runtime,
      skillRollResult,
      npcKnowledge,
      locationId,
      language,
      registry,
      featureNotes,
      resolutionContext
    );

    const interactionTargets = resolveTargets(node);
    delta.actorChanges.fatigueDelta = sanitizeFatigueDelta(
      delta.actorChanges.fatigueDelta,
      resolutionContext
    );
    await applyCharacterDelta(
      dgsm,
      node.characterId,
      delta.actorChanges,
      interactionTargets.length > 0 ? interactionTargets : [node.characterId],
      memoryManager,
      sessionId,
      moduleId,
      gameDay,
      action.gameTime
    );

    for (const targetId of Object.keys(delta.targetChanges)) {
      delta.targetChanges[targetId].fatigueDelta = sanitizeFatigueDelta(
        delta.targetChanges[targetId].fatigueDelta,
        resolutionContext
      );
      await applyCharacterDelta(
        dgsm,
        targetId,
        delta.targetChanges[targetId],
        [node.characterId],
        memoryManager,
        sessionId,
        moduleId,
        gameDay,
        action.gameTime
      );
    }

    if (memoryManager) {
      const nameMap = buildLocationNameMap(dgsm);
      const resolveNames = (names: string[]): string[] =>
        names
          .map((name) => {
            const resolved = resolveLocationFromName(name, nameMap);
            if (
              resolved === name &&
              !dgsm.getState().scenes.has(name) &&
              !dgsm.getState().junctions.has(name) &&
              !dgsm.getState().roads.has(name)
            ) {
              return null;
            }
            return resolved;
          })
          .filter((id): id is string => id !== null);

      const learnedEntries: Array<{ npcId: string; locationIds: string[] }> =
        [];
      if (delta.actorChanges.learnedLocationNames?.length) {
        const ids = resolveNames(delta.actorChanges.learnedLocationNames);
        if (ids.length > 0) {
          learnedEntries.push({
            npcId: node.characterId,
            locationIds: ids,
          });
        }
      }
      for (const [targetId, targetDelta] of Object.entries(
        delta.targetChanges
      )) {
        if (targetDelta.learnedLocationNames?.length) {
          const ids = resolveNames(targetDelta.learnedLocationNames);
          if (ids.length > 0) {
            learnedEntries.push({ npcId: targetId, locationIds: ids });
          }
        }
      }
      if (learnedEntries.length > 0) {
        await Promise.all(
          learnedEntries.map(async (entry) => {
            const pos = dgsm.getCharacterPosition(entry.npcId);
            const loc = pos ? dgsm.resolveLocationId(pos) : undefined;
            await memoryManager.revealLocationsInMap({
              npcId: entry.npcId,
              sessionId,
              moduleId,
              gameDay,
              gameTime: action.gameTime,
              location: loc,
              dgsm,
              locationIds: entry.locationIds,
            });
          })
        );
      }
    }

    action.outcome = delta.actorChanges.memory;
    eventOutcome = appendItemContext(action.outcome, itemContext);
    action.stateMemories = {
      [node.characterId]: delta.actorChanges.memory,
      ...Object.fromEntries(
        Object.entries(delta.targetChanges).map(([id, change]) => [
          id,
          change.memory,
        ])
      ),
    };
  }

  const objectInteractionAttempted =
    node.type === "object_interaction" && shouldRunResolver(action);

  if (objectInteractionAttempted) {
    const objSkillRollResult = action.successLevel
      ? {
          successLevel: action.successLevel,
          detail: action.rollDetail ?? "",
        }
      : null;

    const objDelta = await resolveItemState(
      node,
      dgsm,
      ctx.runtime,
      objSkillRollResult,
      locationId,
      language,
      memoryManager,
      sessionId,
      registry,
      featureNotes,
      resolutionContext
    );

    applyObjectDelta(dgsm, node.characterId, objDelta, locationId);
    action.outcome = objDelta.outcome;
    eventOutcome = appendItemContext(action.outcome, itemContext);
    action.stateMemories = {
      [node.characterId]: objDelta.outcome,
    };
  }

  const sceneLikeActionAttempted =
    node.type === "action" && shouldRunResolver(action);

  if (sceneLikeActionAttempted) {
    const sceneSkillRollResult = action.successLevel
      ? {
          successLevel: action.successLevel,
          detail: action.rollDetail ?? "",
        }
      : null;

    const sceneDelta = await resolveActionState(
      node,
      dgsm,
      ctx.runtime,
      sceneSkillRollResult,
      locationId,
      language,
      registry,
      featureNotes,
      resolutionContext
    );

    const appliedSceneDelta = applyActionSceneDelta(
      dgsm,
      sceneDelta,
      locationId,
      node.characterId
    );
    applyIncidentalActionMove({
      dgsm,
      characterId: node.characterId,
      moveTo: sceneDelta.moveTo,
    });
    applyFatigueDelta(
      dgsm,
      node.characterId,
      sanitizeFatigueDelta(sceneDelta.fatigueDelta, resolutionContext)
    );

    if (
      memoryManager &&
      appliedSceneDelta.revealedHiddenConnections.length > 0
    ) {
      const recipientIds = new Set<string>([node.characterId]);
      for (const npc of state.npcCharacters) {
        if (npc.id === node.characterId) continue;
        if (!dgsm.isNpcAlive(npc.id)) continue;
        const pos = dgsm.getCharacterPosition(npc.id);
        if (!pos) continue;
        if (dgsm.resolveLocationId(pos) === locationId) {
          recipientIds.add(npc.id);
        }
      }
      await Promise.all(
        [...recipientIds].map(async (npcId) => {
          const npcPos = dgsm.getCharacterPosition(npcId);
          const npcLocation = npcPos
            ? dgsm.resolveLocationId(npcPos)
            : undefined;
          await memoryManager.revealHiddenConnectionsInMap({
            npcId,
            sessionId,
            moduleId,
            gameDay,
            gameTime: action.gameTime,
            location: npcLocation,
            dgsm,
            connections: appliedSceneDelta.revealedHiddenConnections,
          });
        })
      );
    }

    action.outcome = sceneDelta.memory;
    eventOutcome = appendItemContext(action.outcome, itemContext);
    action.stateMemories = {
      [node.characterId]: sceneDelta.memory,
    };
  }

  let relationshipChange: string | undefined;
  if (interactionAttempted && allTargetIds.length > 0) {
    const relParts: string[] = [];
    for (const targetId of allTargetIds) {
      const relResult = await npcPlanningAgent.updateRelationshipViaLLM(
        dgsm,
        node.characterId,
        targetId,
        action.outcome,
        language
      );
      if (relResult) {
        const sign = relResult.scoreDelta >= 0 ? "+" : "";
        const targetName =
          state.npcCharacters.find((n) => n.id === targetId)?.name ?? targetId;
        relParts.push(
          `[rel:${targetName} ${sign}${relResult.scoreDelta} → ${relResult.newScore}]`
        );
      }
    }
    if (relParts.length > 0) {
      relationshipChange = relParts.join(" ");
    }
  }

  let logEntry = action.stateMemories?.[node.characterId] ?? eventOutcome;
  if (relationshipChange) logEntry += ` ${relationshipChange}`;
  eventMetadata.outcome = action.outcome;

  if (memoryManager) {
    await memoryManager.add({
      npcId: node.characterId,
      sessionId,
      moduleId,
      type: "event",
      content: logEntry,
      gameDay,
      gameTime: action.gameTime,
      location: action.location,
      metadata: eventMetadata,
    });
  }

  if (memoryManager && action.stateMemories) {
    const targetIdSet = new Set(allTargetIds);
    for (const [charId, memoryText] of Object.entries(action.stateMemories)) {
      if (charId === node.characterId) continue;
      const isDirectTarget = targetIdSet.has(charId);
      await memoryManager.add({
        npcId: charId,
        sessionId,
        moduleId,
        type: isDirectTarget ? "event" : "witness",
        content: memoryText,
        gameDay,
        gameTime: action.gameTime,
        location: action.location,
        metadata: isDirectTarget
          ? eventMetadata
          : {
              sourceCharacterId: node.characterId,
              sourceAction: action.action,
              impact: action.impact,
            },
      });
    }
  } else if (
    memoryManager &&
    action.status === "completed" &&
    node.type === "character_interaction" &&
    allTargetIds.length > 0
  ) {
    const initiatorName = node.characterName;
    for (const targetId of allTargetIds) {
      await memoryManager.add({
        npcId: targetId,
        sessionId,
        moduleId,
        type: "event",
        content: t("fallback_mirror_memory", language, {
          name: initiatorName,
          action: action.action,
          outcome: eventOutcome,
        }),
        gameDay,
        gameTime: action.gameTime,
        location: action.location,
        metadata: eventMetadata,
      });
    }
  }

  if (action.status === "completed") {
    await npcPlanningAgent.markNodeCompleted(
      sessionId,
      node.characterId,
      gameDay,
      node.nodeId,
      action.outcome
    );
  }

  if (action.status === "completed") {
    const effectiveSuccess: SuccessLevel = action.successLevel ?? "regular";
    const discoveries = await discoverEvidence(
      node,
      effectiveSuccess,
      dgsm,
      language,
      locationId
    );
    if (discoveries.length > 0) {
      action.discoveries = [...(action.discoveries ?? []), ...discoveries];
      embedDiscoveries(discoveries, dgsm, language as "en" | "zh");
      console.log(
        `[TickProcessor] NPC discovered ${discoveries.length} item(s): ${discoveries.map((entry) => `[${entry.difficulty}] ${entry.text.slice(0, 40)}`).join("; ")}`
      );
    }
  }

  if (action.status === "failed") {
    const failureReason = action.failureReason ?? "unknown";
    await npcPlanningAgent.markNodeFailed(
      sessionId,
      node.characterId,
      gameDay,
      node.nodeId,
      failureReason
    );
  }

  return { action };
}
