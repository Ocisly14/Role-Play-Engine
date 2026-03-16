import type { CharacterAction, PlanNode } from "./types.js";

export function buildInterruptedMovementAction(
  node: PlanNode,
  gameTime: string,
  location: string
): CharacterAction {
  return {
    characterId: node.characterId,
    characterName: node.characterName,
    gameTime,
    action: node.action,
    location,
    type: node.type,
    skill: node.skill,
    impact: node.impact,
    difficulty: node.difficulty,
    status: "interrupted",
    outcome: `${node.action} [interrupted for replanning at ${location}] interrupted`,
    interruptionReason: "revise_replan",
    targetCharacterId: node.targetCharacterId,
  };
}

function interruptMovementNode(
  node: PlanNode,
  gameTime: string
): PlanNode {
  return {
    ...node,
    status: "interrupted",
    outcome: `${node.action} [interrupted for replanning] interrupted`,
    executionMeta: {
      ...node.executionMeta,
      remainingMinutes: 0,
      interruptedAt: gameTime,
      interruptionReason: "revise_replan",
    },
  };
}

export function mergeRevisedNodesWithHistory(
  existingNodes: PlanNode[],
  revisedNodes: PlanNode[],
  gameTime: string
): {
  nextNodes: PlanNode[];
  interruptedNode?: PlanNode;
} {
  const preservedNodes: PlanNode[] = [];
  let interruptedNode: PlanNode | undefined;

  for (const node of existingNodes) {
    if (
      node.status === "completed" ||
      node.status === "failed" ||
      node.status === "interrupted"
    ) {
      preservedNodes.push(node);
      continue;
    }

    if (node.status === "in_progress") {
      if (node.type === "movement") {
        interruptedNode = interruptMovementNode(node, gameTime);
        preservedNodes.push(interruptedNode);
      } else {
        preservedNodes.push(node);
      }
    }
  }

  return {
    nextNodes: [...preservedNodes, ...revisedNodes],
    interruptedNode,
  };
}
