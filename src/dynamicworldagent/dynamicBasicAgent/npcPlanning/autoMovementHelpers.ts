import { randomUUID } from "crypto";
import type { PlanNode } from "./types.js";

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTimeLabel(minutes: number): string {
  const clamped = Math.max(0, Math.min(1439, minutes));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function getNodeDurationMinutes(node: PlanNode): number {
  return Math.max(1, timeToMinutes(node.endTime) - timeToMinutes(node.startTime));
}

export function buildAutoMovementReplacement(
  node: PlanNode,
  params: {
    currentTime: string;
    fromLocation: string;
    travelMinutes: number;
  }
): { movementNode: PlanNode; resumedNode: PlanNode } {
  const movementStart = params.currentTime;
  const movementEnd = minutesToTimeLabel(
    timeToMinutes(movementStart) + Math.max(1, Math.ceil(params.travelMinutes))
  );

  const movementNode: PlanNode = {
    nodeId: randomUUID(),
    characterId: node.characterId,
    characterName: node.characterName,
    startTime: movementStart,
    endTime: movementEnd,
    action: `Travel from ${params.fromLocation} to ${node.location} before: ${node.action}`,
    location: node.location,
    type: "movement",
    impact: 0,
    status: "pending",
    executionMeta: {
      remainingMinutes: Math.max(1, Math.ceil(params.travelMinutes)),
    },
  };

  const resumedNode: PlanNode = {
    ...node,
    status: "pending",
    executionMeta: {
      remainingMinutes: getNodeDurationMinutes(node),
    },
  };
  delete resumedNode.outcome;

  return { movementNode, resumedNode };
}
