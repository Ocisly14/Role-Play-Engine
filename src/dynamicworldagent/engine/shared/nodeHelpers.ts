import type { PlanNode, CharacterAction, FailureReason, SuccessLevel } from "../../dynamicBasicAgent/npcPlanning/types.js";

export function buildOutcome(
  node: PlanNode,
  status: "completed" | "failed",
  opts?: { rollDetail?: string; reason?: string }
): string {
  const parts: string[] = [node.action];
  if (opts?.rollDetail) {
    parts.push(`[${opts.rollDetail}]`);
  } else if (opts?.reason) {
    parts.push(`[${opts.reason}]`);
  }
  // Payload context
  if (node.type === "character_interaction" && node.characterInteractionPayload) {
    const p = node.characterInteractionPayload;
    if (p.transferType === "item" && p.itemId) parts.push(`(item: ${p.itemId})`);
    else if (p.transferType === "clue" && p.clueId) parts.push(`(clue: ${p.clueId})`);
    else if (p.transferType === "information" && p.informationContent) parts.push(`(info: ${p.informationContent})`);
  } else if (node.type === "object_interaction" && node.objectInteractionPayload) {
    const p = node.objectInteractionPayload;
    const target = p.targetItemId ? ` → ${p.targetItemId}` : "";
    parts.push(`(${p.action}${p.itemId ? `: ${p.itemId}` : ""}${target})`);
  } else if (node.type === "scene_interaction" && node.sceneConnectionEffect) {
    const e = node.sceneConnectionEffect;
    parts.push(`(${e.action} connection to ${e.targetScenarioId})`);
  }
  parts.push(status === "completed" ? "succeeded" : "failed");
  return parts.join(" ");
}

export function makeAction(
  node: PlanNode,
  status: "completed" | "failed",
  outcome: string,
  opts?: {
    difficulty?: "regular" | "hard" | "extreme" | "luck_only";
    successLevel?: SuccessLevel;
    failureReason?: FailureReason;
  }
): CharacterAction {
  return {
    characterId: node.characterId,
    characterName: node.characterName,
    gameTime: node.gameTime,
    action: node.action,
    location: node.location,
    type: node.type,
    actionType: node.actionType,
    impact: node.impact,
    isPlayer: node.isPlayer,
    difficulty: opts?.difficulty,
    successLevel: opts?.successLevel,
    status,
    outcome,
    failureReason: opts?.failureReason,
    targetCharacterId: node.targetCharacterId,
  };
}
