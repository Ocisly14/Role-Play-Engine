import { t } from "../../i18n/t.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { NPCPlanningAgent } from "../../planning/NPCPlanningAgent.js";
import {
  buildLocationNameMap,
  resolveLocationId as resolveLocationFromName,
} from "../../planning/sceneMapFormatter.js";
import type {
  CharacterAction,
  FailureTrigger,
  PlanNode,
  SuccessLevel,
} from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { Item } from "../../state/types.js";
import {
  applyCharacterDelta,
  resolveInteractionState,
  resolveTargets,
} from "../handlers/interactionStateResolver.js";
import {
  applyObjectDelta,
  resolveObjectInteractionState,
} from "../handlers/objectInteractionStateResolver.js";
import {
  applySceneDelta,
  resolveSceneInteractionState,
} from "../handlers/sceneInteractionStateResolver.js";
import type { GameEngineRegistry } from "../registry.js";
import type { ExecutionContext } from "../types.js";
import {
  discoverEvidence,
  discoverNpcKnowledge,
  embedDiscoveries,
} from "./discoveryPipeline.js";

interface ItemActionContext {
  itemId?: string;
  itemName?: string;
  targetItemId?: string;
  targetItemName?: string;
}

function findKnownItem(
  dgsm: DynamicGameStateManager,
  node: PlanNode,
  itemId: string
): Item | null {
  const actorItem = dgsm.findNpcItem(node.characterId, itemId);
  if (actorItem) return actorItem;

  const sceneItem = dgsm
    .getScene(node.location)
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
  node: PlanNode
): ItemActionContext | null {
  if (node.type === "object_interaction" && node.objectInteractionPayload) {
    const { itemId } = node.objectInteractionPayload;
    if (!itemId) return null;
    const item = findKnownItem(dgsm, node, itemId);
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

export interface PendingRevisionRequest {
  npcId: string;
  trigger: FailureTrigger;
  reactionQuery: string;
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
  pendingRevisionRequest?: PendingRevisionRequest;
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
  const itemContext = getItemActionContext(dgsm, node);
  let eventOutcome = appendItemContext(action.outcome, itemContext);
  const eventMetadata = buildEventMetadata(action.outcome, itemContext);
  const allTargetIds = node.targetCharacterIds ?? [];

  if (
    featureNotes.length > 0 &&
    node.type !== "character_interaction" &&
    node.type !== "object_interaction" &&
    node.type !== "scene_interaction"
  ) {
    const combined = featureNotes.join(" ");
    action.outcome = combined;
    eventOutcome = combined;
  }

  if (action.status === "completed" && node.type === "character_interaction") {
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
      language,
      registry,
      featureNotes
    );

    const interactionTargets = resolveTargets(node);
    await applyCharacterDelta(
      dgsm,
      node.characterId,
      delta.actorChanges,
      interactionTargets.length > 0 ? interactionTargets : [node.characterId],
      memoryManager,
      sessionId,
      moduleId,
      gameDay,
      node.endTime
    );

    for (const targetId of Object.keys(delta.targetChanges)) {
      await applyCharacterDelta(
        dgsm,
        targetId,
        delta.targetChanges[targetId],
        [node.characterId],
        memoryManager,
        sessionId,
        moduleId,
        gameDay,
        node.endTime
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
              gameTime: node.endTime,
              location: loc,
              dgsm,
              locationIds: entry.locationIds,
            });
          })
        );
      }
    }

    action.outcome = delta.actorChanges.memory;
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

  if (action.status === "completed" && node.type === "object_interaction") {
    const objSkillRollResult = action.successLevel
      ? {
          successLevel: action.successLevel,
          detail: action.rollDetail ?? "",
        }
      : null;

    const objDelta = await resolveObjectInteractionState(
      node,
      dgsm,
      ctx.runtime,
      objSkillRollResult,
      language,
      memoryManager,
      sessionId,
      registry,
      featureNotes
    );

    applyObjectDelta(dgsm, node.characterId, objDelta, node.location);
    action.outcome = objDelta.memory;
    action.stateMemories = {
      [node.characterId]: objDelta.memory,
    };
  }

  if (action.status === "completed" && node.type === "scene_interaction") {
    const sceneSkillRollResult = action.successLevel
      ? {
          successLevel: action.successLevel,
          detail: action.rollDetail ?? "",
        }
      : null;

    const sceneDelta = await resolveSceneInteractionState(
      node,
      dgsm,
      ctx.runtime,
      sceneSkillRollResult,
      language,
      registry,
      featureNotes
    );

    const appliedSceneDelta = applySceneDelta(
      dgsm,
      sceneDelta,
      node.location,
      node.characterId
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
        if (dgsm.resolveLocationId(pos) === node.location) {
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
    action.stateMemories = {
      [node.characterId]: sceneDelta.memory,
    };
  }

  let relationshipChange: string | undefined;
  if (
    action.status === "completed" &&
    node.type === "character_interaction" &&
    allTargetIds.length > 0
  ) {
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
      node.location
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

    return {
      action,
      pendingRevisionRequest: {
        npcId: node.characterId,
        trigger: {
          type: "failure",
          failureReason,
          action: action.action,
          gameTime: action.gameTime,
          failureOutcome: action.outcome,
        },
        reactionQuery: `${action.action} failed: ${action.outcome}`,
      },
    };
  }

  return { action };
}
