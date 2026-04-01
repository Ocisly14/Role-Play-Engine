import { t } from "../../i18n/t.js";
import type {
  CharacterAction,
  FailureReason,
  PlanNode,
  SuccessLevel,
} from "../../planning/types.js";

export function buildOutcome(
  node: PlanNode,
  status: "completed" | "failed",
  opts?: { rollDetail?: string; reason?: string },
  language = "en"
): string {
  const detail = opts?.rollDetail ?? opts?.reason;
  let base: string;
  if (detail) {
    base =
      status === "completed"
        ? t("outcome_with_detail_succeeded", language, {
            action: node.action,
            detail,
          })
        : t("outcome_with_detail_failed", language, {
            action: node.action,
            detail,
          });
  } else {
    base =
      status === "completed"
        ? t("outcome_succeeded", language, { action: node.action })
        : t("outcome_failed", language, { action: node.action });
  }

  // Payload context suffix
  if (node.type === "object_interaction" && node.objectInteractionPayload) {
    const p = node.objectInteractionPayload;
    if (p.itemId) {
      base += " " + t("outcome_item", language, { item: p.itemId });
    }
  }

  return base;
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
    location?: string;
  }
): CharacterAction {
  return {
    characterId: node.characterId,
    characterName: node.characterName,
    gameTime: opts?.gameTime ?? node.endTime,
    action: node.action,
    location: opts?.location ?? node.destination ?? "",
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
