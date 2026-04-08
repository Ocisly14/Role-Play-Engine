import { t } from "../i18n/t.js";
import type { CharacterAction, PlanNode } from "./types.js";

export function buildInterruptedAction(
  node: PlanNode,
  gameTime: string,
  location: string,
  language = "en",
  triggerDescription?: string
): CharacterAction {
  const base = t("interrupted_replanning_at", language, {
    action: node.action,
    location,
  });

  return {
    characterId: node.characterId,
    characterName: node.characterName,
    gameTime,
    action: node.action,
    location,
    type: node.type,
    skill: node.skill,
    impact: 0,
    difficulty: node.difficulty,
    status: "interrupted",
    outcome: triggerDescription ?? base,
    interruptionReason: "revise_replan",
    triggerDescription,
    targetCharacterIds: node.targetCharacterIds,
  };
}

export function interruptNode(
  node: PlanNode,
  gameTime: string,
  language = "en"
): PlanNode {
  return {
    ...node,
    status: "interrupted",
    outcome: t("interrupted_replanning", language, { action: node.action }),
    executionMeta: {
      ...node.executionMeta,
      remainingMinutes: 0,
      interruptedAt: gameTime,
      interruptionReason: "revise_replan",
    },
  };
}
