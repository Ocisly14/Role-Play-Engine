import type {
  CharacterAction,
  FailureReason,
  PlanNode,
  SuccessLevel,
} from "../../dynamicBasicAgent/npcPlanning/types.js";

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
  if (node.type === "object_interaction" && node.objectInteractionPayload) {
    const p = node.objectInteractionPayload;
    if (p.itemId) {
      parts.push(`(item: ${p.itemId})`);
    }
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
    gameTime?: string;
    difficulty?: "regular" | "hard" | "extreme";
    successLevel?: SuccessLevel;
    failureReason?: FailureReason;
  }
): CharacterAction {
  return {
    characterId: node.characterId,
    characterName: node.characterName,
    gameTime: opts?.gameTime ?? node.endTime,
    action: node.action,
    location: node.location,
    type: node.type,
    skill: node.skill,
    impact: node.impact,
    difficulty: opts?.difficulty,
    successLevel: opts?.successLevel,
    status,
    outcome,
    failureReason: opts?.failureReason,
    targetCharacterIds: node.targetCharacterIds,
  };
}
