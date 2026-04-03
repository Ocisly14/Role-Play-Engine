import { t } from "../../i18n/t.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { NPCPlanningAgent } from "../../npc/planning/NPCPlanningAgent.js";
import type { CharacterAction, PlanNode } from "../../npc/planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { resolveTargetPosition } from "../handlers/movementHandler.js";
import { buildMovementRouteIgnoringBlocks } from "../shared/pathfinding.js";
import type { ExecutionContext, NodeHandler } from "../types.js";

async function writeAutoMovementMemory(params: {
  dgsm: DynamicGameStateManager;
  npcId: string;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  gameTime: string;
  location: string;
  content: string;
  outcome: string;
  memoryManager?: NpcMemoryManager;
}): Promise<void> {
  const {
    npcId,
    sessionId,
    moduleId,
    gameDay,
    gameTime,
    location,
    content,
    outcome,
    memoryManager,
  } = params;
  if (!memoryManager) return;

  await memoryManager.add({
    npcId,
    sessionId,
    moduleId,
    type: "event",
    content,
    gameDay,
    gameTime,
    location,
    metadata: {
      outcome,
    },
  });
}

export async function recoverActionExecution(params: {
  node: PlanNode;
  action: CharacterAction;
  handler: NodeHandler;
  dgsm: DynamicGameStateManager;
  ctx: ExecutionContext;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  tickStartTime: string;
  language: string;
  movedNpcIds: Set<string>;
  memoryManager?: NpcMemoryManager;
}): Promise<{
  node: PlanNode;
  action: CharacterAction;
}> {
  const {
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
  } = params;
  let { node, action } = params;

  if (action.failureReason === "location_mismatch") {
    const targetDestination = node.destination;
    const currentPos = dgsm.getCharacterPosition(node.characterId);
    const topology = dgsm.getTopology();
    const targetPos = targetDestination
      ? resolveTargetPosition(targetDestination, topology, dgsm)
      : null;

    if (currentPos && targetPos && targetDestination) {
      const route = buildMovementRouteIgnoringBlocks(
        currentPos,
        targetPos,
        topology,
        dgsm
      );
      if (route) {
        const travelMinutes = Math.max(1, Math.ceil(route.totalMinutes));
        const fromLocationId = dgsm.resolveLocationId(currentPos);

        dgsm.setCharacterPosition(node.characterId, targetPos);
        movedNpcIds.add(node.characterId);

        await npcPlanningAgent.shiftPendingNodesByDelta(
          sessionId,
          node.characterId,
          gameDay,
          tickStartTime,
          -travelMinutes
        );

        await writeAutoMovementMemory({
          dgsm,
          npcId: node.characterId,
          sessionId,
          moduleId,
          gameDay,
          gameTime: tickStartTime,
          location: targetDestination,
          content: t("walked_from_to", language, {
            from: fromLocationId,
            to: targetDestination,
            minutes: String(travelMinutes),
          }),
          outcome: t("auto_movement_outcome", language, {
            from: fromLocationId,
            to: targetDestination,
          }),
          memoryManager,
        });

        console.log(
          `[TickProcessor] Auto-movement: ${node.characterName} walked from ${fromLocationId} to ${targetDestination} (~${travelMinutes} min)`
        );

        action = await handler.execute(node, dgsm, ctx);
      }
    }
  }

  if (
    action.failureReason === "object_not_found" &&
    node.objectInteractionPayload?.itemId
  ) {
    const itemId = node.objectInteractionPayload.itemId;
    const currentScene = dgsm.getScene(action.location);
    const parentId = currentScene?.parentLocationId;

    if (parentId && parentId !== "OUTDOOR") {
      const state = dgsm.getState();
      let targetSceneId: string | undefined;

      for (const [sceneId, scene] of state.scenes) {
        if (sceneId === action.location) continue;
        if (scene.parentLocationId !== parentId) continue;
        const found =
          scene.items?.some((item) => item.id === itemId) ||
          scene.items?.some((item) =>
            item.containerStats?.storedItems?.some(
              (stored) => stored.id === itemId
            )
          );
        if (found) {
          targetSceneId = sceneId;
          break;
        }
      }

      if (targetSceneId) {
        const fromLocationId = action.location;

        dgsm.setCharacterPosition(node.characterId, {
          type: "scene",
          sceneId: targetSceneId,
        });

        await npcPlanningAgent.shiftPendingNodesByDelta(
          sessionId,
          node.characterId,
          gameDay,
          tickStartTime,
          -1
        );

        await writeAutoMovementMemory({
          dgsm,
          npcId: node.characterId,
          sessionId,
          moduleId,
          gameDay,
          gameTime: tickStartTime,
          location: targetSceneId,
          content: t("walked_for_item", language, {
            from: fromLocationId,
            to: targetSceneId,
            item: itemId,
          }),
          outcome: t("auto_movement_item_outcome", language, {
            from: fromLocationId,
            to: targetSceneId,
            item: itemId,
          }),
          memoryManager,
        });

        console.log(
          `[TickProcessor] Auto-movement: ${node.characterName} walked from ${fromLocationId} to ${targetSceneId} for item ${itemId}`
        );

        action = await handler.execute(node, dgsm, ctx);
      }
    }
  }

  return {
    node,
    action,
  };
}
