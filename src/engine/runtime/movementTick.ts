import { t } from "../../i18n/t.js";
import type { CharacterAction, PlanNode } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterPosition } from "../../state/topologyTypes.js";
import { SUCCESS_RANK, getSuccessLevel, rollD100 } from "../shared/dice.js";
import {
  buildMovementRouteIgnoringBlocks,
  resolveTargetPosition,
} from "../shared/pathfinding.js";

export const TICK_DURATION_MINUTES = 1;

export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToTimeLabel(minutes: number): string {
  const clamped = Math.min(minutes, 1439);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function getNpcSkillValue(
  dgsm: DynamicGameStateManager,
  npcId: string,
  skillName: string,
  defaultValue: number
): number {
  const npc = dgsm.getState().npcCharacters.find((n) => n.id === npcId);
  if (!npc?.skills) return defaultValue;
  const lower = skillName.toLowerCase();
  for (const [k, v] of Object.entries(npc.skills)) {
    if (k.toLowerCase() === lower) return v;
  }
  return defaultValue;
}

function getDetectionSkillValue(
  dgsm: DynamicGameStateManager,
  npcId: string
): number {
  const npc = dgsm.getState().npcCharacters.find((n) => n.id === npcId);
  const skills = npc?.skills ?? {};
  const lower = Object.fromEntries(
    Object.entries(skills).map(([k, v]) => [k.toLowerCase(), v])
  );
  return lower["spot hidden"] ?? lower.perception ?? 25;
}

export function rollStealthForMovement(
  dgsm: DynamicGameStateManager,
  npcId: string
): boolean {
  const stealthValue = getNpcSkillValue(dgsm, npcId, "Stealth", 20);
  const roll = rollD100();
  const level = getSuccessLevel(roll, stealthValue);
  return level !== "fail" && level !== "fumble";
}

export function tryDetectHidden(
  dgsm: DynamicGameStateManager,
  observerId: string,
  hiddenNpcId: string
): boolean {
  const detectionValue = getDetectionSkillValue(dgsm, observerId);
  const stealthValue = getNpcSkillValue(dgsm, hiddenNpcId, "Stealth", 20);

  const observerRoll = rollD100();
  const stealthRoll = rollD100();
  const observerLevel = getSuccessLevel(observerRoll, detectionValue);
  const stealthLevel = getSuccessLevel(stealthRoll, stealthValue);

  return SUCCESS_RANK[observerLevel] > SUCCESS_RANK[stealthLevel];
}

export function getNodeDurationMinutes(node: PlanNode): number {
  return Math.max(
    1,
    timeToMinutes(node.endTime) - timeToMinutes(node.startTime)
  );
}

export function startNode(node: PlanNode, currentTime: string): PlanNode {
  return {
    ...node,
    status: "in_progress",
    executionMeta: {
      ...node.executionMeta,
      startedAt: node.executionMeta.startedAt ?? currentTime,
      remainingMinutes:
        node.executionMeta.remainingMinutes > 0
          ? node.executionMeta.remainingMinutes
          : getNodeDurationMinutes(node),
    },
  };
}

function interpolateMovementPosition(
  from: CharacterPosition,
  to: CharacterPosition,
  progress: number
): CharacterPosition {
  if (from.type === "road" && to.type === "road" && from.roadId === to.roadId) {
    return {
      type: "road",
      roadId: from.roadId,
      position: from.position + (to.position - from.position) * progress,
    };
  }

  return progress >= 1 ? to : from;
}

function buildMovementAction(
  node: PlanNode,
  status: "completed" | "failed",
  gameTime: string,
  location: string,
  outcome: string,
  failureReason?: "location_blocked"
): CharacterAction {
  return {
    characterId: node.characterId,
    characterName: node.characterName,
    gameTime,
    action: node.action,
    location,
    type: node.type,
    skill: node.skill,
    impact: 0,
    status,
    outcome,
    failureReason,
    targetCharacterIds: node.targetCharacterIds,
  };
}

export function initializeMovementNode(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  currentTime: string,
  lang: string
): PlanNode {
  const destination = node.destination;
  const currentPosition = dgsm.getCharacterPosition(node.characterId);
  if (!currentPosition || !destination) {
    return {
      ...startNode(node, currentTime),
      status: "failed",
      executionMeta: {
        ...node.executionMeta,
        startedAt: currentTime,
        failedAt: currentTime,
        remainingMinutes: 0,
      },
      outcome: t("no_path_failed", lang, { action: node.action }),
    };
  }

  if (currentPosition.type === "scene") {
    const state = dgsm.getState();
    const currentScene = state.scenes.get(currentPosition.sceneId);
    const targetScene = state.scenes.get(destination);
    if (
      currentScene &&
      targetScene &&
      currentScene.parentLocationId === targetScene.parentLocationId &&
      currentScene.parentLocationId !== "OUTDOOR" &&
      currentPosition.sceneId !== destination
    ) {
      const targetPos: CharacterPosition = {
        type: "scene",
        sceneId: destination,
      };
      const moveDuration = Math.max(1, node.executionMeta.remainingMinutes);
      return {
        ...startNode(node, currentTime),
        executionMeta: {
          ...node.executionMeta,
          startedAt: currentTime,
          remainingMinutes: moveDuration,
          movement: {
            routeSnapshot: [
              {
                kind: "to_scene",
                from: currentPosition,
                to: targetPos,
                durationMinutes: moveDuration,
                blockCheck: {
                  fromId: currentPosition.sceneId,
                  toId: destination,
                },
              },
            ],
            currentStepIndex: 0,
            minutesIntoStep: 0,
            lastReachablePosition: currentPosition,
            targetPosition: targetPos,
          },
        },
      };
    }
  }

  const topology = dgsm.getTopology();
  const targetPosition = resolveTargetPosition(destination, topology, dgsm);
  if (!targetPosition) {
    return {
      ...startNode(node, currentTime),
      status: "failed",
      executionMeta: {
        ...node.executionMeta,
        startedAt: currentTime,
        failedAt: currentTime,
        remainingMinutes: 0,
      },
      outcome: t("no_path_failed", lang, { action: node.action }),
    };
  }

  const route = buildMovementRouteIgnoringBlocks(
    currentPosition,
    targetPosition,
    topology,
    dgsm
  );
  if (!route) {
    return {
      ...startNode(node, currentTime),
      status: "failed",
      executionMeta: {
        ...node.executionMeta,
        startedAt: currentTime,
        failedAt: currentTime,
        remainingMinutes: 0,
      },
      outcome: t("no_path_failed", lang, { action: node.action }),
    };
  }

  return {
    ...startNode(node, currentTime),
    executionMeta: {
      ...node.executionMeta,
      startedAt: currentTime,
      remainingMinutes: Math.max(1, Math.ceil(route.totalMinutes)),
      movement: {
        routeSnapshot: route.steps,
        currentStepIndex: 0,
        minutesIntoStep: 0,
        lastReachablePosition: currentPosition,
        targetPosition,
      },
    },
  };
}

function processImmediateMovementTransitions(
  node: PlanNode,
  dgsm: DynamicGameStateManager
): { node: PlanNode; blockedReason?: string; moved: boolean } {
  const movement = node.executionMeta.movement;
  if (!movement) return { node, moved: false };

  let currentNode = node;
  let moved = false;

  while (true) {
    const currentMovement = currentNode.executionMeta.movement;
    if (!currentMovement) break;
    const step =
      currentMovement.routeSnapshot[currentMovement.currentStepIndex];
    if (!step || step.durationMinutes > 0) break;

    const blockedReason = step.blockCheck
      ? dgsm.getConnectionBlockReason(
          step.blockCheck.fromId,
          step.blockCheck.toId
        )
      : undefined;
    if (blockedReason) {
      return { node: currentNode, blockedReason, moved };
    }

    dgsm.setCharacterPosition(currentNode.characterId, step.to);
    moved = true;
    currentNode = {
      ...currentNode,
      executionMeta: {
        ...currentNode.executionMeta,
        movement: {
          ...currentMovement,
          currentStepIndex: currentMovement.currentStepIndex + 1,
          minutesIntoStep: 0,
          lastReachablePosition: step.to,
        },
      },
    };
  }

  return { node: currentNode, moved };
}

export function advanceMovementNodeOneMinute(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  currentTime: string,
  lang: string
): {
  node: PlanNode;
  action?: CharacterAction;
  moved: boolean;
} {
  const processed = processImmediateMovementTransitions(node, dgsm);
  if (processed.blockedReason) {
    const failedNode: PlanNode = {
      ...processed.node,
      status: "failed",
      executionMeta: {
        ...processed.node.executionMeta,
        failedAt: currentTime,
        blockedReason: processed.blockedReason,
        remainingMinutes: 0,
        movement: processed.node.executionMeta.movement
          ? {
              ...processed.node.executionMeta.movement,
              blockedReason: processed.blockedReason,
            }
          : undefined,
      },
      outcome: t("blocked_failed", lang, {
        action: processed.node.action,
        reason: processed.blockedReason,
      }),
    };
    const failedPosition = dgsm.getCharacterPosition(node.characterId);
    const failedOutcome =
      failedNode.outcome ??
      t("blocked_failed", lang, {
        action: processed.node.action,
        reason: processed.blockedReason,
      });
    return {
      node: failedNode,
      moved: processed.moved,
      action: buildMovementAction(
        failedNode,
        "failed",
        currentTime,
        failedPosition
          ? dgsm.resolveLocationId(failedPosition)
          : (processed.node.destination ?? ""),
        failedOutcome,
        "location_blocked"
      ),
    };
  }

  const movement = processed.node.executionMeta.movement;
  if (!movement) {
    return { node: processed.node, moved: processed.moved };
  }

  const step = movement.routeSnapshot[movement.currentStepIndex];
  if (!step) {
    const completedNode: PlanNode = {
      ...processed.node,
      status: "completed",
      executionMeta: {
        ...processed.node.executionMeta,
        completedAt: currentTime,
        remainingMinutes: 0,
      },
      outcome: t("arrived_succeeded", lang, {
        action: processed.node.action,
        location: processed.node.destination ?? "",
      }),
    };
    const completedOutcome =
      completedNode.outcome ??
      t("arrived_succeeded", lang, {
        action: processed.node.action,
        location: processed.node.destination ?? "",
      });
    return {
      node: completedNode,
      moved: processed.moved,
      action: buildMovementAction(
        completedNode,
        "completed",
        currentTime,
        processed.node.destination ?? "",
        completedOutcome
      ),
    };
  }

  const blockedReason =
    movement.minutesIntoStep === 0 && step.blockCheck
      ? dgsm.getConnectionBlockReason(
          step.blockCheck.fromId,
          step.blockCheck.toId
        )
      : undefined;
  if (blockedReason) {
    const failedNode: PlanNode = {
      ...processed.node,
      status: "failed",
      executionMeta: {
        ...processed.node.executionMeta,
        failedAt: currentTime,
        blockedReason,
        remainingMinutes: 0,
        movement: {
          ...movement,
          blockedReason,
        },
      },
      outcome: t("blocked_failed", lang, {
        action: processed.node.action,
        reason: blockedReason,
      }),
    };
    const failedPosition = dgsm.getCharacterPosition(node.characterId);
    const failedOutcome =
      failedNode.outcome ??
      t("blocked_failed", lang, {
        action: processed.node.action,
        reason: blockedReason,
      });
    return {
      node: failedNode,
      moved: processed.moved,
      action: buildMovementAction(
        failedNode,
        "failed",
        currentTime,
        failedPosition
          ? dgsm.resolveLocationId(failedPosition)
          : (processed.node.destination ?? ""),
        failedOutcome,
        "location_blocked"
      ),
    };
  }

  const duration = Math.max(1, step.durationMinutes);
  const nextMinutesIntoStep = movement.minutesIntoStep + 1;
  const progress = Math.min(nextMinutesIntoStep / duration, 1);
  const nextPosition = interpolateMovementPosition(
    step.from,
    step.to,
    progress
  );
  dgsm.setCharacterPosition(node.characterId, nextPosition);

  let nextNode: PlanNode = {
    ...processed.node,
    executionMeta: {
      ...processed.node.executionMeta,
      remainingMinutes: Math.max(
        0,
        processed.node.executionMeta.remainingMinutes - 1
      ),
      movement: {
        ...movement,
        minutesIntoStep: nextMinutesIntoStep,
        lastReachablePosition: nextPosition,
      },
    },
  };

  if (progress >= 1) {
    const nextMovementState = nextNode.executionMeta.movement;
    if (!nextMovementState) {
      return {
        node: nextNode,
        moved: true,
      };
    }

    nextNode = {
      ...nextNode,
      executionMeta: {
        ...nextNode.executionMeta,
        movement: {
          ...nextMovementState,
          currentStepIndex: movement.currentStepIndex + 1,
          minutesIntoStep: 0,
          lastReachablePosition: step.to,
        },
      },
    };
  }

  const afterMinute = processImmediateMovementTransitions(nextNode, dgsm);
  if (afterMinute.blockedReason) {
    const failedNode: PlanNode = {
      ...afterMinute.node,
      status: "failed",
      executionMeta: {
        ...afterMinute.node.executionMeta,
        failedAt: currentTime,
        blockedReason: afterMinute.blockedReason,
        remainingMinutes: 0,
        movement: afterMinute.node.executionMeta.movement
          ? {
              ...afterMinute.node.executionMeta.movement,
              blockedReason: afterMinute.blockedReason,
            }
          : undefined,
      },
      outcome: t("blocked_failed", lang, {
        action: afterMinute.node.action,
        reason: afterMinute.blockedReason,
      }),
    };
    const failedPosition = dgsm.getCharacterPosition(node.characterId);
    const failedOutcome =
      failedNode.outcome ??
      t("blocked_failed", lang, {
        action: afterMinute.node.action,
        reason: afterMinute.blockedReason,
      });
    return {
      node: failedNode,
      moved: true,
      action: buildMovementAction(
        failedNode,
        "failed",
        currentTime,
        failedPosition
          ? dgsm.resolveLocationId(failedPosition)
          : (node.destination ?? ""),
        failedOutcome,
        "location_blocked"
      ),
    };
  }

  const nextMovement = afterMinute.node.executionMeta.movement;
  if (
    !nextMovement ||
    !nextMovement.routeSnapshot[nextMovement.currentStepIndex]
  ) {
    const completedNode: PlanNode = {
      ...afterMinute.node,
      status: "completed",
      executionMeta: {
        ...afterMinute.node.executionMeta,
        completedAt: currentTime,
        remainingMinutes: 0,
      },
      outcome: t("arrived_succeeded", lang, {
        action: afterMinute.node.action,
        location: afterMinute.node.destination ?? "",
      }),
    };
    const completedOutcome =
      completedNode.outcome ??
      t("arrived_succeeded", lang, {
        action: afterMinute.node.action,
        location: afterMinute.node.destination ?? "",
      });
    return {
      node: completedNode,
      moved: true,
      action: buildMovementAction(
        completedNode,
        "completed",
        currentTime,
        afterMinute.node.destination ?? "",
        completedOutcome
      ),
    };
  }

  return {
    node: afterMinute.node,
    moved: true,
  };
}
