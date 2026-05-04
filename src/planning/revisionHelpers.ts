import { t } from "../i18n/t.js";
import type { PlanNode } from "./types.js";

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
